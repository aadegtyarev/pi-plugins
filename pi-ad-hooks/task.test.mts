import test from "node:test";
import assert from "node:assert/strict";
import extension from "./index.ts";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function harness() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-ad-hooks-task-"));
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  let command: ((args: string, ctx: any) => Promise<void>) | undefined;
  let tool: any;
  const entries: any[] = [];
  let branch = entries;
  let idle = true;
  const notifications: string[] = [];
  const sent: string[] = [];
  const activeTools = new Set<string>();
  const pi: any = {
    on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, handler); },
    registerCommand(_name: string, definition: any) { command = definition.handler; },
    registerTool(definition: any) { tool = definition; },
    appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); },
    getActiveTools() { return [...activeTools]; },
    setActiveTools(names: string[]) { activeTools.clear(); names.forEach(name => activeTools.add(name)); },
    sendUserMessage(message: string) { sent.push(message); },
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
  return { dir, handlers, command: (args: string, context: any) => command!(args, context), tool: () => tool, entries, notifications, sent, ctx, activeTools, setIdle: (value: boolean) => { idle = value; }, setBranch: (value: any[]) => { branch = value; } };
}

test("task commands persist state, dispatch initial goal, and control task-only tool", async () => {
  const h = harness();
  try {
    await h.command("start Ship the feature", h.ctx);
    assert.deepEqual(h.sent, ["Ship the feature"]);
    assert.equal(h.entries.at(-1).customType, "pi-ad-hooks-task");
    assert.equal(h.entries.at(-1).data.status, "active");
    assert.equal(h.activeTools.has("task_update"), true);
    await h.command("status", h.ctx);
    await h.command("pause", h.ctx);
    assert.equal(h.entries.at(-1).data.status, "paused");
    assert.equal(h.entries[0].data.status, "active");
    assert.equal(h.activeTools.has("task_update"), false);
    await h.command("resume", h.ctx);
    assert.equal(h.entries.at(-1).data.status, "active");
    assert.equal(h.entries.at(-2).data.status, "paused");
    assert.equal(h.sent.length, 2);
    await h.command("done", h.ctx);
    assert.equal(h.entries.at(-1).data.status, "done");
    await h.command("start Replacement", h.ctx);
    assert.equal(h.entries.at(-1).data.goal, "Replacement");
    await h.command("stop", h.ctx);
    assert.equal(h.entries.at(-1).data.status, "stopped");
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
    assert.match(h.notifications.at(-1), /20 automatic continuations/);
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

test("busy start and resume reject before side effects or unrelated-run continuation", async () => {
  const h = harness();
  try {
    h.setIdle(false);
    await h.command("start busy goal", h.ctx);
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
