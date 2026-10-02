import test from "node:test";
import assert from "node:assert/strict";
import extension from "./index.ts";
import { ERROR_CODES, SAFE_ERRORS } from "./report.ts";

function setup(branch: unknown[] = []) {
  let tool: any;
  let command: any;
  const sends: any[] = [];
  const events: string[] = [];
  const pi: any = {
    registerTool(definition: unknown) { tool = definition; },
    registerCommand(_name: string, definition: unknown) { command = definition; },
    on(name: string) { events.push(name); },
    sendMessage(...args: unknown[]) { sends.push(args); },
  };
  extension(pi);
  const ctx: any = { sessionManager: { getBranch: () => branch } };
  return { tool, command, sends, events, ctx };
}

const branchWithUsage = [{
  type: "message", id: "a", parentId: null, timestamp: "2026-10-02T12:00:00.000Z",
  message: { role: "assistant", content: [], api: "x", provider: "test", model: "model-x", providerThinkingLevel: "medium", usage: { input: 2, output: 1, cacheRead: 1, cacheWrite: 0, cost: { total: 0.02 } } },
}];

test("registers a deterministic /cost command and a separate on-demand model tool", async () => {
  const h = setup(branchWithUsage as any[]);
  const result = await h.tool.execute("id", {}, new AbortController().signal, () => {}, h.ctx);
  assert.equal(result.details.parent.total.value, 4);
  assert.match(result.content[0].text, /Session:/);
  assert.match(result.content[0].text, /parent ×1/);
  assert.match(result.content[0].text, /Report data \(JSON\):\n\{/);
  assert.equal(typeof h.command.handler, "function");

  await h.command.handler("", h.ctx);
  assert.equal(h.sends.length, 1);
  assert.match(h.sends[0][0].content, /Session:/);
  assert.equal(h.sends[0][0].display, true);
  assert.equal(h.sends[0][0].details.rows.length, 1);
  assert.deepEqual(h.sends[0][1], { triggerTurn: false });
  assert.deepEqual(h.events, [], "manual reporting must not register an automatic settle handler");
});

test("tool and command failures are safe, stable, and best-effort", async () => {
  const original = console.error;
  const logs: string[] = [];
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try {
    const h = setup();
    h.ctx.sessionManager.getBranch = () => { throw new Error("raw secret prompt should not leak"); };
    const toolResult = await h.tool.execute("id", {}, new AbortController().signal, () => {}, h.ctx);
    assert.equal(toolResult.isError, true);
    assert.equal(toolResult.details.errorCode, ERROR_CODES.tool);
    assert.equal(toolResult.content[0].text, SAFE_ERRORS.tool);

    await h.command.handler("", h.ctx);
    assert.equal(h.sends.length, 1);
    assert.equal(h.sends[0][0].content, SAFE_ERRORS.command);
    assert.deepEqual(h.sends[0][1], { triggerTurn: false });
    assert.ok(logs.some((line) => line.includes(ERROR_CODES.tool)));
    assert.ok(logs.some((line) => line.includes(ERROR_CODES.command)));
    assert.ok(logs.every((line) => !line.includes("raw secret prompt")));
  } finally { console.error = original; }
});
