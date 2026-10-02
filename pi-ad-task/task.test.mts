import test from "node:test";
import assert from "node:assert/strict";
import extension from "./index.ts";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function harness() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-ad-hooks-task-"));
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const sharedEvents = new Map<string, (event: unknown) => void>();
  let command: ((args: string, ctx: any) => Promise<void>) | undefined;
  const tools = new Map<string, any>();
  const entries: any[] = [];
  let branch = entries;
  let idle = true;
  let sendError: unknown;
  const notifications: string[] = [];
  const sent: string[] = [];
  const activeTools = new Set<string>();
  const pi: any = {
    on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, handler); },
    events: { on(name: string, handler: (event: unknown) => void) { sharedEvents.set(name, handler); }, emit(name: string, event: unknown) { sharedEvents.get(name)?.(event); } },
    registerCommand(_name: string, definition: any) { command = definition.handler; },
    registerTool(definition: any) { tools.set(definition.name, definition); },
    appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); },
    getActiveTools() { return [...activeTools]; },
    setActiveTools(names: string[]) { activeTools.clear(); names.forEach(name => activeTools.add(name)); },
    sendUserMessage(message: string) { if (sendError) throw sendError; sent.push(message); },
  };
  const ctx: any = {
    isIdle: () => idle,
    sessionManager: { getBranch: () => branch },
    ui: { notify: (message: string) => notifications.push(message) },
  };
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  extension(pi);
  if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
  return { dir, handlers, command: (args: string, context: any) => command!(args, context), tool: (name = "task_update") => tools.get(name), emit: (name: string, value: unknown) => sharedEvents.get(name)?.(value), entries, notifications, sent, ctx, activeTools, setIdle: (value: boolean) => { idle = value; }, setSendError: (value: unknown) => { sendError = value; }, setBranch: (value: any[]) => { branch = value; } };
}

test("task commands show help, persist bare or explicit goals, and control the task-only tool", async () => {
  const h = harness();
  try {
    await h.command("", h.ctx);
    assert.match(h.notifications.at(-1)!, /\/task <goal>/);
    assert.match(h.notifications.at(-1)!, /20 automatic continuations/);
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
    await control.execute("id", { action: "pause" }, undefined, undefined, h.ctx);
    assert.equal(h.entries.at(-1).data.status, "paused");
    await control.execute("id", { action: "resume", note: "Approved" }, undefined, undefined, h.ctx);
    assert.equal(h.entries.at(-1).data.status, "active");
    assert.match(h.entries.at(-1).data.progress, /Approved/);
    await control.execute("id", { action: "stop" }, undefined, undefined, h.ctx);
    assert.equal(h.entries.at(-1).data.status, "stopped");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("natural-language task controls preserve Telegram ownership and reject other chats", async () => {
  const h = harness();
  try {
    h.emit("pi-ad-telegram:run-chat", { chatId: 42 });
    const control = h.tool("task_control");
    await control.execute("id", { action: "start", goal: "Telegram-approved goal" }, undefined, undefined, h.ctx);
    assert.equal(h.entries.at(-1).data.telegramChatId, 42);
    h.handlers.get("agent_settled")!({}, h.ctx);
    h.emit("pi-ad-telegram:run-chat", { chatId: 84 });
    const refused = await control.execute("id", { action: "status" }, undefined, undefined, h.ctx);
    assert.equal(refused.isError, true);
    assert.equal(refused.content[0].text.includes("Telegram-approved goal"), false);
    h.emit("pi-ad-telegram:run-chat", { chatId: 42 });
    await control.execute("id", { action: "stop" }, undefined, undefined, h.ctx);
    h.emit("pi-ad-telegram:run-chat", { chatId: 84 });
    await control.execute("id", { action: "start", goal: "Next Telegram task" }, undefined, undefined, h.ctx);
    assert.equal(h.entries.at(-1).data.telegramChatId, 84, "a new chat may start after the former owner's task is terminal");
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
    assert.equal(h.handlers.get("agent_before_settle")!({ outcome: "completed", entries: [], context: {} }, h.ctx), undefined);
    assert.equal(h.activeTools.has("task_update"), false);
    assert.equal(h.notifications.join(" ").includes("confidential"), false);
    await h.command("resume", h.ctx);
    await tool.execute("id", { action: "done", note: "completed" }, undefined, undefined, h.ctx);
    assert.equal(h.entries.at(-1).data.status, "done");
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
    const settle = h.handlers.get("agent_before_settle")!;
    for (let count = 1; count <= 20; count++) {
      const result = settle({ outcome: "completed", entries: [], context: {} }, h.ctx);
      assert.equal(result.continue, true);
      assert.equal(result.entries[0].customType, "pi-ad-hooks-task-continuation");
      assert.equal(h.entries.at(-1).data.continuations, count);
      assert.equal(h.entries[count - 1].data.continuations, count - 1);
    }
    const exhausted = settle({ outcome: "completed", entries: [], context: {} }, h.ctx);
    assert.equal(exhausted, undefined);
    assert.equal(h.entries.at(-1).data.status, "paused");
    assert.match(h.notifications.at(-1)!, /20 automatic continuations/);
    await h.command("resume", h.ctx);
    const failed = settle({ outcome: "error", entries: [], context: {} }, h.ctx);
    assert.equal(failed, undefined);
    assert.equal(h.entries.at(-1).data.status, "paused");
    await h.command("resume", h.ctx);
    const aborted = settle({ outcome: "aborted", entries: [], context: {} }, h.ctx);
    assert.equal(aborted, undefined);
    assert.equal(h.entries.at(-1).data.status, "paused");
    await h.command("resume", h.ctx);
    await h.command("pause", h.ctx);
    assert.equal(settle({ outcome: "completed", entries: [], context: {} }, h.ctx), undefined);
    await h.command("resume", h.ctx);
    await h.command("done", h.ctx);
    assert.equal(settle({ outcome: "completed", entries: [], context: {} }, h.ctx), undefined);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
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
    assert.equal(h.handlers.get("agent_before_settle")!({ outcome: "completed", entries: [], context: {} }, h.ctx), undefined);
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
    assert.equal(h.handlers.get("agent_before_settle")!({ outcome: "completed", entries: [], context: {} }, h.ctx), undefined);
    assert.equal(h.entries.length, snapshotCount);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("restores task state and tool exposure from only the active branch", () => {
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
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});
