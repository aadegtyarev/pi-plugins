import test from "node:test";
import assert from "node:assert/strict";
import { createTaskExtension } from "./index.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function harness() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-ad-hooks-task-"));
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const sharedEvents = new Map<string, Set<(event: unknown) => void>>();
  const emittedEvents: Array<{ name: string; event: unknown }> = [];
  let command: ((args: string, ctx: any) => Promise<void>) | undefined;
  const tools = new Map<string, any>();
  const entries: any[] = [];
  let branch = entries;
  let idle = true;
  let sendError: unknown;
  const notifications: string[] = [];
  const sent: string[] = [];
  const customSent: Array<{ message: any; options: any }> = [];
  const activeTools = new Set<string>();
  const pi: any = {
    on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, handler); },
    events: {
      on(name: string, handler: (event: unknown) => void) {
        if (!sharedEvents.has(name)) sharedEvents.set(name, new Set());
        sharedEvents.get(name)!.add(handler);
        return () => sharedEvents.get(name)?.delete(handler);
      },
      emit(name: string, event: unknown) { emittedEvents.push({ name, event }); for (const handler of [...(sharedEvents.get(name) ?? [])]) handler(event); },
    },
    registerCommand(_name: string, definition: any) { command = definition.handler; },
    registerTool(definition: any) { tools.set(definition.name, definition); },
    appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); },
    getActiveTools() { return [...activeTools]; },
    setActiveTools(names: string[]) { activeTools.clear(); names.forEach(name => activeTools.add(name)); },
    sendUserMessage(message: string) { if (sendError) throw sendError; sent.push(message); },
    sendMessage(message: any, options: any) { customSent.push({ message, options }); },
  };
  const ctx: any = {
    isIdle: () => idle,
    sessionManager: { getBranch: () => branch },
    ui: { notify: (message: string) => notifications.push(message) },
  };
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  createTaskExtension({ statusTimeoutMs: 30, wakeDelayMs: 20 })(pi);
  if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
  return { dir, handlers, command: (args: string, context: any) => command!(args, context), tool: (name = "task_update") => tools.get(name), emit: (name: string, value: unknown) => pi.events.emit(name, value), emittedEvents, customSent, pi, entries, notifications, sent, ctx, activeTools, setIdle: (value: boolean) => { idle = value; }, setSendError: (value: unknown) => { sendError = value; }, setBranch: (value: any[]) => { branch = value; } };
}

test("task commands show help, persist bare or explicit goals, and control the task-only tool", async () => {
  const h = harness();
  try {
    await h.command("", h.ctx);
    assert.match(h.notifications.at(-1)!, /\/task <goal>/);
    assert.match(h.notifications.at(-1)!, /default of 40/);
    await h.command('start "Ship the feature"', h.ctx);
    assert.deepEqual(h.sent, ["Ship the feature"]);
    assert.match(h.notifications.at(-1)!, /Task started/);
    assert.equal(h.entries.at(-1).customType, "pi-ad-hooks-task");
    assert.equal(h.entries.at(-1).data.status, "active");
    assert.equal(h.activeTools.has("task_update"), true);
    await h.command("status", h.ctx);
    await h.command("pause", h.ctx);
    assert.match(h.notifications.at(-1)!, /Automatic continuation paused/);
    assert.equal(h.entries.at(-1).data.status, "paused");
    assert.equal(h.entries[0].data.status, "active");
    assert.equal(h.activeTools.has("task_update"), false);
    await h.command("resume", h.ctx);
    assert.equal(h.entries.at(-1).data.status, "active");
    assert.equal(h.entries.at(-2).data.status, "paused");
    assert.equal(h.sent.length, 2);
    await h.command("done", h.ctx);
    assert.equal(h.entries.at(-1).data.status, "done");
    await h.command("Replacement", h.ctx);
    assert.equal(h.entries.at(-1).data.goal, "Replacement");
    await h.command("stop", h.ctx);
    assert.match(h.notifications.at(-1)!, /Automatic continuation stopped/);
    assert.equal(h.entries.at(-1).data.status, "stopped");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("task control tool starts and manages only operator-requested single task", async () => {
  const h = harness();
  try {
    const control = h.tool("task_control");
    const started = await control.execute("id", { action: "start", goal: "Explicitly approved goal" }, undefined, undefined, h.ctx);
    assert.match(started.content[0].text, /Task started/);
    assert.equal(h.entries.at(-1).data.goal, "Explicitly approved goal");
    const duplicate = await control.execute("id", { action: "start", goal: "Second task" }, undefined, undefined, h.ctx);
    assert.equal(duplicate.isError, true);
    assert.equal(h.entries.at(-1).data.goal, "Explicitly approved goal");
    await h.handlers.get("agent_before_settle")!({ outcome: "completed", entries: [], context: {} }, h.ctx);
    assert.equal(h.entries.at(-1).data.continuations, 1);
    await control.execute("id", { action: "pause" }, undefined, undefined, h.ctx);
    assert.equal(h.entries.at(-1).data.status, "paused");
    await control.execute("id", { action: "resume", note: "Approved" }, undefined, undefined, h.ctx);
    assert.equal(h.entries.at(-1).data.status, "active");
    assert.equal(h.entries.at(-1).data.continuations, 0);
    assert.match(h.entries.at(-1).data.progress, /Approved/);
    await control.execute("id", { action: "stop" }, undefined, undefined, h.ctx);
    assert.equal(h.entries.at(-1).data.status, "stopped");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("legacy task state with unknown fields still loads and those fields are dropped on the next write", async () => {
  const h = harness();
  try {
    h.entries.push({ type: "custom", customType: "pi-ad-hooks-task", data: { version: 1, goal: "Legacy goal", progress: "", status: "paused", continuations: 3, continuationLimit: 40, legacyRoute: 42 } });
    await h.command("resume", h.ctx);
    assert.equal(h.entries.at(-1).data.status, "active");
    assert.equal(h.entries.at(-1).data.goal, "Legacy goal");
    assert.equal("legacyRoute" in h.entries.at(-1).data, false);
    assert.deepEqual(h.emittedEvents.filter(({ name }) => !name.startsWith("subagents:rpc:v1:")), []);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("task command errors always point to an actionable recovery", async () => {
  const h = harness();
  try {
    await h.command("resume", h.ctx);
    assert.match(h.notifications.at(-1)!, /\/task <goal>/);
    await h.command("start recovery goal", h.ctx);
    await h.command("pause", h.ctx);
    await h.command("pause", h.ctx);
    assert.match(h.notifications.at(-1)!, /\/task resume/);
    await h.command("resume", h.ctx);
    await h.command("done", h.ctx);
    await h.command("done", h.ctx);
    assert.match(h.notifications.at(-1)!, /\/task status/);
    assert.match(h.notifications.at(-1)!, /\/task start <goal>/);
    await h.command("stop", h.ctx);
    assert.match(h.notifications.at(-1)!, /already done/);
    assert.match(h.notifications.at(-1)!, /\/task start <goal>/);
    await h.command("start another goal", h.ctx);
    await h.command("stop", h.ctx);
    assert.match(h.notifications.at(-1)!, /Automatic continuation stopped/);
    await h.command("stop", h.ctx);
    assert.match(h.notifications.at(-1)!, /already stopped/);
    assert.match(h.notifications.at(-1)!, /\/task start <goal>/);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("TUI dispatch failure pauses the task and explains how to recover", async () => {
  const h = harness();
  try {
    h.setSendError(new Error("synthetic rejection"));
    await h.command("start rejected goal", h.ctx);
    assert.equal(h.entries.at(-1).data.status, "paused");
    assert.match(h.notifications.at(-1)!, /could not accept the task/);
    assert.match(h.notifications.at(-1)!, /\/task resume/);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("task tool records progress and done/blocked transitions without diagnostics", async () => {
  const h = harness();
  try {
    await h.command("start Keep private details", h.ctx);
    const tool = h.tool();
    await tool.execute("id", { action: "progress", note: "progress confidential" }, undefined, undefined, h.ctx);
    assert.equal(h.entries.at(-1).data.progress, "progress confidential");
    assert.equal(h.entries[0].data.progress, "");
    assert.equal(h.entries[0].data.status, "active");
    await tool.execute("id", { action: "blocked", note: "need user input" }, undefined, undefined, h.ctx);
    assert.equal(h.entries.at(-1).data.status, "blocked");
    assert.equal(h.entries.at(-2).data.status, "active");
    assert.equal(h.entries.at(-2).data.progress, "progress confidential");
    assert.equal(await h.handlers.get("agent_before_settle")!({ outcome: "completed", entries: [], context: {} }, h.ctx), undefined);
    assert.equal(h.activeTools.has("task_update"), false);
    assert.equal(h.notifications.join(" ").includes("confidential"), false);
    await h.command("resume", h.ctx);
    await tool.execute("id", { action: "done", note: "completed" }, undefined, undefined, h.ctx);
    assert.equal(h.entries.at(-1).data.status, "done");
    assert.deepEqual(h.emittedEvents.filter(({ name }) => !name.startsWith("subagents:rpc:v1:")), [], "task work emits nothing besides pi-subagents status requests");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("blocked tasks reject replacement with recovery help and resume with the user's answer", async () => {
  const h = harness();
  try {
    await h.command("start awaiting approval", h.ctx);
    const blockedResult = await h.tool().execute("id", { action: "blocked", note: "waiting for approval" }, undefined, undefined, h.ctx);
    assert.match(blockedResult.content[0].text, /\/task resume <answer>/);
    const stateCount = h.entries.length;
    await h.command("start replacement", h.ctx);
    assert.equal(h.entries.length, stateCount);
    assert.match(h.notifications.at(-1)!, /Task not started/);
    assert.match(h.notifications.at(-1)!, /\/task resume <blocker answer>/);
    await h.command("resume Подтверждаю scope и merge gate", h.ctx);
    assert.equal(h.entries.at(-1).data.status, "active");
    assert.match(h.sent.at(-1)!, /User response: Подтверждаю scope и merge gate/);
    assert.match(h.notifications.at(-1)!, /Task resumed/);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("settle continuation is bounded, persisted, and skipped for terminal or failed runs", async () => {
  const h = harness();
  try {
    await h.command("start bounded goal", h.ctx);
    await h.command("limit 20", h.ctx);
    const settle = h.handlers.get("agent_before_settle")!;
    for (let count = 1; count <= 20; count++) {
      const result = await settle({ outcome: "completed", entries: [], context: {} }, h.ctx);
      assert.equal(result.continue, true);
      assert.equal(result.entries[0].customType, "pi-ad-hooks-task-continuation");
      assert.equal(h.entries.at(-1).data.continuations, count);
      assert.equal(h.entries[count].data.continuations, count - 1);
    }
    const exhausted = await settle({ outcome: "completed", entries: [], context: {} }, h.ctx);
    assert.equal(exhausted, undefined);
    assert.equal(h.entries.at(-1).data.status, "paused");
    assert.match(h.notifications.at(-1)!, /limit 20/);
    await h.command("resume", h.ctx);
    assert.equal(h.entries.at(-1).data.continuations, 0);
    const failed = await settle({ outcome: "error", entries: [], context: {} }, h.ctx);
    assert.equal(failed, undefined);
    assert.equal(h.entries.at(-1).data.status, "paused");
    await h.command("resume", h.ctx);
    const aborted = await settle({ outcome: "aborted", entries: [], context: {} }, h.ctx);
    assert.equal(aborted, undefined);
    assert.equal(h.entries.at(-1).data.status, "paused");
    await h.command("resume", h.ctx);
    await h.command("pause", h.ctx);
    assert.equal(await settle({ outcome: "completed", entries: [], context: {} }, h.ctx), undefined);
    await h.command("resume", h.ctx);
    await h.command("done", h.ctx);
    assert.equal(await settle({ outcome: "completed", entries: [], context: {} }, h.ctx), undefined);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

function reviewerNotice(verdict: string) {
  return { type: "custom_message", customType: "subagent-notify", content: `Background task completed: **reviewer**\n\nreviewer:\n## Review\n\n**${verdict}**\n\n- findings` };
}

test("task blocks with a report instruction after two rejected review rounds", async () => {
  const h = harness();
  try {
    h.entries.push(reviewerNotice("REQUEST_CHANGES"));
    await h.command("start reviewed goal", h.ctx);
    const settle = h.handlers.get("agent_before_settle")!;
    assert.equal((await settle({ outcome: "completed", entries: [], context: {} }, h.ctx)).continue, true);
    h.entries.push(reviewerNotice("REQUEST_CHANGES"));
    h.entries.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "## Review\n**REQUEST_CHANGES** quoted by the model" }] } });
    h.entries.push(reviewerNotice("APPROVE"));
    const once = await settle({ outcome: "completed", entries: [], context: {} }, h.ctx);
    assert.equal(once.entries[0].content.startsWith("Continue the active task"), true);
    h.entries.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call-r", name: "subagent", arguments: { agent: "reviewer", task: "review" } }] } });
    h.entries.push({ type: "message", message: { role: "toolResult", toolName: "subagent", toolCallId: "call-r", content: [{ type: "text", text: "## Review — REQUEST_CHANGES\n- P1" }] } });
    const blocked = await settle({ outcome: "completed", entries: [], context: {} }, h.ctx);
    assert.equal(blocked.continue, true);
    assert.match(blocked.entries[0].content, /rejected this work 2 times/);
    assert.match(blocked.entries[0].content, /do not start, resume, or steer workers or reviewers/);
    assert.equal(h.entries.at(-1).data.status, "blocked");
    assert.match(h.notifications.at(-1)!, /2 rejected review rounds/);
    assert.equal(await settle({ outcome: "completed", entries: [], context: {} }, h.ctx), undefined);
    await h.command("resume accept as is", h.ctx);
    h.entries.push(reviewerNotice("REQUEST_CHANGES"));
    assert.equal((await settle({ outcome: "completed", entries: [], context: {} }, h.ctx)).entries[0].content.startsWith("Continue the active task"), true);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("review rejection counting ignores status views and starts legacy tasks from the current branch", async () => {
  const h = harness();
  try {
    h.entries.push(reviewerNotice("REQUEST_CHANGES"), reviewerNotice("REQUEST_CHANGES"));
    h.entries.push({ type: "custom", customType: "pi-ad-hooks-task", data: { version: 1, goal: "legacy", progress: "", status: "active", continuations: 0 } });
    const settle = h.handlers.get("agent_before_settle")!;
    assert.equal((await settle({ outcome: "completed", entries: [], context: {} }, h.ctx)).continue, true);
    assert.equal(h.entries.at(-1).data.reviewRejectionBaseline, 2);
    h.entries.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call-s", name: "subagent", arguments: { action: "status", id: "run" } }] } });
    h.entries.push({ type: "message", message: { role: "toolResult", toolName: "subagent", toolCallId: "call-s", content: [{ type: "text", text: "Transcript\n## Review\n**REQUEST_CHANGES**" }] } });
    h.entries.push(reviewerNotice("REQUEST_CHANGES"));
    const result = await settle({ outcome: "completed", entries: [], context: {} }, h.ctx);
    assert.equal(result.entries[0].content.startsWith("Continue the active task"), true);
    assert.equal(h.entries.at(-1).data.status, "active");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("review verdict parsing handles batched notices, approve-first wording, and long blank runs quickly", async () => {
  const { countReviewRejections } = await import("./review-limit.ts");
  const batched = { type: "custom_message", content: "Background tasks completed (2): **worker**, **reviewer**\n\n1. worker\nworker:\ndone\n2. reviewer (r1)\nreviewer:\n## Review\n\nSummary: two issues.\n\n**REQUEST_CHANGES**" };
  const approveFirst = { type: "custom_message", content: "Background task completed: **reviewer**\n\n## Review\n\n**APPROVE** — no REQUEST_CHANGES needed" };
  const failed = { type: "custom_message", content: "Background task failed: **reviewer**\n\n## Review\nREQUEST_CHANGES" };
  const blank = { type: "custom_message", content: `Background task completed: **reviewer**\n## Review\n${"\n".repeat(5000)}x` };
  const repeatedHeadings = { type: "custom_message", content: "Background task completed: **reviewer**\n\nreviewer:\n## Review\n**REQUEST_CHANGES**\n### Review findings\n- P1: must fix before merge (REQUEST_CHANGES)" };
  const workerHeading = { type: "custom_message", content: "Background tasks completed (2): **worker**, **reviewer**\n\n1. worker\n## Review feedback addressed\nfixed the REQUEST_CHANGES item\n2. reviewer\n## Review\n**APPROVE**" };
  const twoReviewers = { type: "custom_message", content: "Background tasks completed (2): **reviewer**, **reviewer**\n\n1. reviewer\n## Review\n**REQUEST_CHANGES**\n2. reviewer\n## Review\n**REQUEST_CHANGES**" };
  assert.equal(countReviewRejections([repeatedHeadings]), 1);
  assert.equal(countReviewRejections([workerHeading]), 0);
  assert.equal(countReviewRejections([twoReviewers]), 2);
  const started = performance.now();
  assert.equal(countReviewRejections([batched, approveFirst, failed, blank]), 1);
  assert.ok(performance.now() - started < 200);
});

test("task state controls stay available while busy and distinguish state changes from cancellation", async () => {
  const h = harness();
  try {
    await h.command("start busy-controls goal", h.ctx);
    h.setIdle(false);
    await h.command("status", h.ctx);
    assert.match(h.notifications.at(-1)!, /Current operation is still in progress/);
    await h.command("pause", h.ctx);
    assert.equal(h.entries.at(-1).data.status, "paused");
    assert.match(h.notifications.at(-1)!, /still in progress and will not be cancelled/);
    await h.command("done", h.ctx);
    assert.equal(h.entries.at(-1).data.status, "done");
    assert.match(h.notifications.at(-1)!, /still in progress and will not be cancelled/);

    h.setIdle(true);
    await h.command("start replacement goal", h.ctx);
    h.setIdle(false);
    await h.command("stop", h.ctx);
    assert.equal(h.entries.at(-1).data.status, "stopped");
    assert.match(h.notifications.at(-1)!, /wait for it to finish before starting another task/);
    assert.equal(h.sent.length, 2, "task-state controls do not submit model prompts");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("busy start and resume reject before side effects or unrelated-run continuation", async () => {
  const h = harness();
  try {
    h.setIdle(false);
    await h.command("busy goal", h.ctx);
    assert.match(h.notifications.at(-1)!, /Wait for the current run to finish/);
    assert.equal(h.entries.length, 0);
    assert.equal(h.sent.length, 0);
    assert.equal(h.activeTools.has("task_update"), false);
    assert.equal(await h.handlers.get("agent_before_settle")!({ outcome: "completed", entries: [], context: {} }, h.ctx), undefined);
    assert.equal(h.entries.length, 0);

    h.setIdle(true);
    await h.command("start resumable goal", h.ctx);
    await h.command("pause", h.ctx);
    const snapshotCount = h.entries.length;
    h.setIdle(false);
    await h.command("resume", h.ctx);
    assert.equal(h.entries.length, snapshotCount);
    assert.equal(h.entries.at(-1).data.status, "paused");
    assert.equal(h.activeTools.has("task_update"), false);
    assert.equal(h.sent.length, 1);
    assert.equal(await h.handlers.get("agent_before_settle")!({ outcome: "completed", entries: [], context: {} }, h.ctx), undefined);
    assert.equal(h.entries.length, snapshotCount);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("per-task continuation limits validate, persist across statuses, and migrate legacy state", async () => {
  const h = harness();
  try {
    await h.command("start configurable goal", h.ctx);
    assert.equal(h.entries.at(-1).data.continuationLimit, 40);
    await h.command("limit 3", h.ctx);
    assert.equal(h.entries.at(-1).data.continuationLimit, 3);
    await h.command("status", h.ctx);
    assert.ok(h.notifications.at(-1)!.includes("Automatic continuations: 0/3"));
    await h.command("limit nope", h.ctx);
    assert.match(h.notifications.at(-1)!, /Invalid continuation limit/);
    assert.equal(h.entries.at(-1).data.continuationLimit, 3);
    await h.command("pause", h.ctx);
    await h.command("limit off", h.ctx);
    assert.equal(h.entries.at(-1).data.continuationLimit, null);
    await h.command("resume", h.ctx);
    assert.equal(h.entries.at(-1).data.continuations, 0);
    await h.command("limit default", h.ctx);
    assert.equal(h.entries.at(-1).data.continuationLimit, 40);
    await h.tool("task_update").execute("id", { action: "blocked", note: "waiting" }, undefined, undefined, h.ctx);
    await h.command("limit 0", h.ctx);
    assert.equal(h.entries.at(-1).data.continuationLimit, 0);
    await h.command("status", h.ctx);
    assert.ok(h.notifications.at(-1)!.includes("Automatic continuations: 0/0"));

    h.setBranch([{ type: "custom", customType: "pi-ad-hooks-task", data: { version: 1, goal: "old state", progress: "", status: "active", continuations: 123456 } }]);
    await h.command("status", h.ctx);
    assert.ok(h.notifications.at(-1)!.includes("Automatic continuations: 123456/40"));
    await h.command("limit off", h.ctx);
    await h.command("status", h.ctx);
    assert.ok(h.notifications.at(-1)!.includes("Automatic continuations: 123456/unlimited"));
    const unlimited = await h.handlers.get("agent_before_settle")!({ outcome: "completed", entries: [], context: {} }, h.ctx);
    assert.equal(unlimited.continue, true);
    await h.command("status", h.ctx);
    assert.ok(h.notifications.at(-1)!.includes("Automatic continuations: 123457/unlimited"));
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("continuation limits stop at zero and saturate safely at the counter boundary", async () => {
  const h = harness();
  try {
    h.setBranch([{ type: "custom", customType: "pi-ad-hooks-task", data: { version: 1, goal: "zero limit", progress: "", status: "active", continuations: 0, continuationLimit: 0 } }]);
    assert.equal(await h.handlers.get("agent_before_settle")!({ outcome: "completed", entries: [], context: {} }, h.ctx), undefined);
    await h.command("status", h.ctx);
    assert.ok(h.notifications.at(-1)!.includes("Automatic continuations: 0/0"));
    assert.equal(h.entries.length, 0);

    h.setBranch([{ type: "custom", customType: "pi-ad-hooks-task", data: { version: 1, goal: "unlimited boundary", progress: "", status: "active", continuations: Number.MAX_SAFE_INTEGER, continuationLimit: null } }]);
    const settle = h.handlers.get("agent_before_settle")!;
    assert.equal((await settle({ outcome: "completed", entries: [], context: {} }, h.ctx)).continue, true);
    await h.command("status", h.ctx);
    assert.ok(h.notifications.at(-1)!.includes(`Automatic continuations: ${Number.MAX_SAFE_INTEGER}/unlimited`));
    assert.equal((await settle({ outcome: "completed", entries: [], context: {} }, h.ctx)).continue, true);
    await h.command("status", h.ctx);
    assert.ok(h.notifications.at(-1)!.includes(`Automatic continuations: ${Number.MAX_SAFE_INTEGER}/unlimited`));
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("restores task state and tool exposure from only the active branch", async () => {
  const h = harness();
  try {
    h.entries.push({ type: "custom", customType: "pi-ad-hooks-task", data: { version: 1, goal: "branch goal", progress: "", status: "active", continuations: 2 } });
    h.handlers.get("session_start")!({}, h.ctx);
    assert.equal(h.activeTools.has("task_update"), true);
    const otherBranch = [{ type: "custom", customType: "pi-ad-hooks-task", data: { version: 1, goal: "other", progress: "", status: "done", continuations: 0 } }];
    h.setBranch(otherBranch);
    h.handlers.get("session_tree")!({}, h.ctx);
    assert.equal(h.activeTools.has("task_update"), false);
    h.setBranch(h.entries);
    h.handlers.get("session_start")!({}, h.ctx);
    assert.equal(h.activeTools.has("task_update"), true);
    assert.equal(h.entries[0].data.goal, "branch goal");
    h.setBranch([{ type: "custom", customType: "pi-ad-hooks-task", data: { version: 1, goal: "numeric limit", progress: "", status: "active", continuations: 4, continuationLimit: 17 } }]);
    h.handlers.get("session_tree")!({}, h.ctx);
    await h.command("status", h.ctx);
    assert.ok(h.notifications.at(-1)!.includes("Automatic continuations: 4/17"));
    h.setBranch([{ type: "custom", customType: "pi-ad-hooks-task", data: { version: 1, goal: "unlimited", progress: "", status: "active", continuations: 5, continuationLimit: null } }]);
    h.handlers.get("session_tree")!({}, h.ctx);
    await h.command("status", h.ctx);
    assert.ok(h.notifications.at(-1)!.includes("Automatic continuations: 5/unlimited"));
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

const SETTLED = { outcome: "completed", entries: [], context: {} };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Fakes the pi-subagents RPC status reply; returns a setter for the running-subagent count. */
function fakeSubagents(h: ReturnType<typeof harness>, initial: number) {
  let running = initial;
  h.pi.events.on("subagents:rpc:v1:request", (request: any) => {
    h.pi.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, method: "status", success: true, data: { fleet: { version: 1, entries: [], totalActive: running, omitted: 0 } } });
  });
  return (value: number) => { running = value; };
}

test("task waits for running background subagents instead of spending a continuation", async () => {
  const h = harness();
  try {
    const setRunning = fakeSubagents(h, 2);
    await h.command("start delegated goal", h.ctx);
    const settle = h.handlers.get("agent_before_settle")!;
    assert.equal(await settle(SETTLED, h.ctx), undefined, "no continuation while subagents run");
    assert.equal(h.entries.at(-1).data.status, "active");
    assert.equal(h.entries.at(-1).data.continuations, 0);
    await h.command("status", h.ctx);
    assert.match(h.notifications.at(-1)!, /Waiting for 2 background subagents/);

    // pi-subagents wakes the parent itself: a run starts before the grace period ends, so the task does nothing.
    setRunning(0);
    h.emit("subagent:async-complete", { runId: "r1" });
    h.handlers.get("agent_start")!({}, h.ctx);
    await sleep(60);
    assert.equal(h.customSent.length, 0);
    const next = await settle(SETTLED, h.ctx);
    assert.equal(next.continue, true);
    assert.equal(h.entries.at(-1).data.continuations, 1);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("task starts the next step itself when a subagent completion produced no run", async () => {
  const h = harness();
  try {
    const setRunning = fakeSubagents(h, 1);
    await h.command("start delegated goal", h.ctx);
    await h.handlers.get("agent_before_settle")!(SETTLED, h.ctx);
    setRunning(0);
    h.emit("subagent:async-complete", { runId: "r1" });
    await sleep(80);
    assert.equal(h.customSent.length, 1);
    assert.equal(h.customSent[0].message.customType, "pi-ad-hooks-task-continuation");
    assert.match(h.customSent[0].message.content, /Continue the active task/);
    assert.equal(h.customSent[0].options.triggerTurn, true);
    assert.equal(h.entries.at(-1).data.continuations, 1);
    await h.command("status", h.ctx);
    assert.doesNotMatch(h.notifications.at(-1)!, /Waiting for/);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("missed-wake fallback stays quiet while other subagents still run or Pi is busy", async () => {
  const h = harness();
  try {
    const setRunning = fakeSubagents(h, 2);
    await h.command("start delegated goal", h.ctx);
    await h.handlers.get("agent_before_settle")!(SETTLED, h.ctx);
    setRunning(1);
    h.emit("subagent:async-complete", { runId: "r1" });
    await sleep(80);
    assert.equal(h.customSent.length, 0);
    await h.command("status", h.ctx);
    assert.match(h.notifications.at(-1)!, /Waiting for 1 background subagent to finish/);
    setRunning(0);
    h.setIdle(false);
    h.emit("subagent:async-complete", { runId: "r2" });
    await sleep(80);
    assert.equal(h.customSent.length, 0);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("task cannot be marked done by the model while background subagents run", async () => {
  const h = harness();
  try {
    const setRunning = fakeSubagents(h, 1);
    await h.command("start delegated goal", h.ctx);
    const refused = await h.tool().execute("id", { action: "done", note: "finished" }, undefined, undefined, h.ctx);
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /1 background subagent is still running/);
    assert.equal(h.entries.at(-1).data.status, "active");
    const progress = await h.tool().execute("id", { action: "progress", note: "waiting for worker" }, undefined, undefined, h.ctx);
    assert.equal(progress.isError, undefined);
    setRunning(0);
    await h.tool().execute("id", { action: "done", note: "finished" }, undefined, undefined, h.ctx);
    assert.equal(h.entries.at(-1).data.status, "done");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("without pi-subagents the task continues and allows done after one short timeout", async () => {
  const h = harness();
  try {
    await h.command("start solo goal", h.ctx);
    assert.equal((await h.handlers.get("agent_before_settle")!(SETTLED, h.ctx)).continue, true);
    const requests = h.emittedEvents.filter(({ name }) => name === "subagents:rpc:v1:request").length;
    assert.equal((await h.handlers.get("agent_before_settle")!(SETTLED, h.ctx)).continue, true);
    assert.equal(h.emittedEvents.filter(({ name }) => name === "subagents:rpc:v1:request").length, requests, "an unanswered request is not repeated");
    h.emit("subagents:rpc:v1:ready", {});
    await h.tool().execute("id", { action: "done" }, undefined, undefined, h.ctx);
    assert.equal(h.entries.at(-1).data.status, "done");
    assert.equal(h.emittedEvents.filter(({ name }) => name === "subagents:rpc:v1:request").length, requests + 1, "pi-subagents announcing itself re-enables requests");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("stock reviewer merge verdicts count, including verdicts only in the full-output file", async () => {
  const { countReviewRejections, verdictOf } = await import("./review-limit.ts");
  assert.equal(verdictOf("## Review\n- Finding: P0 ...\n- Merge verdict: BLOCK"), "rejected");
  assert.equal(verdictOf("## Review\n- Merge verdict: OK with notes"), "approved");
  assert.equal(verdictOf("## Review\n**Merge verdict:** OK"), "approved");
  assert.equal(verdictOf("Merge verdict: okay-ish"), undefined);
  const notice = (body: string) => ({ type: "custom_message", content: `Background task completed: **reviewer**\n\nreviewer:\n${body}` });
  assert.equal(countReviewRejections([notice("## Review\n- Merge verdict: BLOCK"), notice("## Review\n- Merge verdict: OK")]), 1);

  const h = harness();
  try {
    const full = path.join(h.dir, "reviewer-output.md");
    writeFileSync(full, `## Review\n${"- Finding: P1 detail\n".repeat(200)}- Merge verdict: BLOCK\n`);
    const truncated = notice(`## Review\n- Finding: P1 detail\n…\nFull output: ${full} (4.0 KB, 202 lines). Read it if needed.`);
    h.entries.push(truncated);
    assert.equal(countReviewRejections(h.entries), 1);
    await h.command("start reviewed goal", h.ctx);
    h.entries.push(truncated);
    const settle = h.handlers.get("agent_before_settle")!;
    assert.equal((await settle(SETTLED, h.ctx)).continue, true);
    const recorded = h.entries.filter(entry => entry.customType === "pi-ad-task-review-verdict");
    assert.deepEqual(recorded.map(entry => entry.data), [{ path: full, rejected: true }], "a file verdict is recorded once");
    rmSync(full);
    assert.equal(countReviewRejections(h.entries), 2, "recorded verdicts survive file cleanup");
    h.entries.push(truncated);
    const blocked = await settle(SETTLED, h.ctx);
    assert.match(blocked.entries[0].content, /rejected this work 2 times/);
    assert.equal(h.entries.at(-1).data.status, "blocked");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});
