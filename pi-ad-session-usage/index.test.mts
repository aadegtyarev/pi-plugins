import test from "node:test";
import assert from "node:assert/strict";
import extension from "./index.ts";
import { ERROR_CODES, SAFE_ERRORS } from "./report.ts";

test("tool registers and reports active branch; settled message is visible without triggering a turn", async () => {
  let definition: any; let settled: any; const sends: any[] = [];
  const pi: any = { registerTool(tool: unknown) { definition = tool; }, on(name: string, handler: unknown) { if (name === "agent_settled") settled = handler; }, sendMessage(...args: unknown[]) { sends.push(args); } };
  extension(pi);
  const ctx: any = { sessionManager: { getBranch: () => [{ type: "message", id: "a", parentId: null, timestamp: "", message: { role: "assistant", content: [], api: "x", provider: "x", model: "x", usage: { input: 2, output: 1, cacheRead: 1, cacheWrite: 0, cost: { total: 0.02 } } } }] } };
  const result = await definition.execute("id", {}, new AbortController().signal, () => {}, ctx);
  assert.equal(result.details.parent.total.value, 4);
  const toolText = result.content[0].text as string;
  const json = toolText.split("Структурированные данные (JSON):\n")[1];
  assert.ok(json);
  assert.equal(JSON.parse(json).parent.total.value, 4);
  await settled({}, ctx);
  assert.equal(sends.length, 1);
  assert.equal(sends[0][0].display, true);
  assert.deepEqual(sends[0][1], { triggerTurn: false });
});

test("automatic error notification failures stay caught and logs omit raw diagnostics", async () => {
  let settled: any;
  const original = console.error;
  const logs: string[] = [];
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try {
    const pi: any = {
      registerTool() {},
      on(_name: string, handler: unknown) { settled = handler; },
      sendMessage() { throw new Error("secret prompt must not be logged"); },
    };
    extension(pi);
    const ctx: any = { sessionManager: { getBranch: () => [] } };
    await assert.doesNotReject(settled({}, ctx));
    assert.ok(logs.some((line) => line.includes("PSU-AUTO-001")));
    assert.ok(logs.every((line) => !line.includes("secret prompt")));
  } finally { console.error = original; }
});

test("tool errors return stable safe error; settlement errors are visible and caught", async () => {
  let definition: any; let settled: any; const sends: any[] = []; const logs: unknown[][] = [];
  const original = console.error; console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    const pi: any = { registerTool(tool: unknown) { definition = tool; }, on(_name: string, handler: unknown) { settled = handler; }, sendMessage(...args: unknown[]) { sends.push(args); } };
    extension(pi);
    const ctx: any = { sessionManager: { getBranch() { throw new Error("raw secret prompt should not leak"); } } };
    const result = await definition.execute("id", {}, new AbortController().signal, () => {}, ctx);
    assert.equal(result.isError, true);
    assert.equal(result.details.errorCode, ERROR_CODES.tool);
    assert.equal(result.content[0].text, SAFE_ERRORS.tool);
    await assert.doesNotReject(settled({}, ctx));
    assert.equal(sends[0][0].content, SAFE_ERRORS.automatic);
    assert.ok(logs.every((line) => !String(line).includes("raw secret prompt")));
  } finally { console.error = original; }
});
