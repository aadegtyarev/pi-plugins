import test from "node:test";
import assert from "node:assert/strict";
import { collectUsage } from "./usage.ts";

const assistant = (id: string, usage: unknown) => ({ type: "message", id, parentId: null, timestamp: "", message: { role: "assistant", content: [], api: "x", provider: "x", model: "x", usage } }) as never;
const childEntry = (id: string, customType: string, details: unknown) => ({ type: customType === "subagent-slash-result" ? "custom_message" : "message", id, parentId: null, timestamp: "", ...(customType === "subagent-slash-result" ? { customType, content: "", display: true, details } : { message: { role: "toolResult", toolName: "subagent", details, content: [], toolCallId: "x", isError: false } }) }) as never;
const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) => ({ input, output, cacheRead, cacheWrite, cost: { total: cost } });

test("active branch metrics match /status prompt and cache-hit semantics", () => {
  const report = collectUsage([assistant("p", usage(8345, 1234, 4000, 0, 0.045))]);
  assert.deepEqual(report.parent.prompt, { value: 12345, complete: true });
  assert.deepEqual(report.parent.input, { value: 8345, complete: true });
  assert.deepEqual(report.parent.cached, { value: 4000, complete: true });
  assert.deepEqual(report.parent.cacheWrite, { value: 0, complete: true });
  assert.deepEqual(report.parent.uncached, { value: 8345, complete: true });
  assert.equal(report.parent.total.value, 13579);
  assert.equal(report.parent.cacheHitRate, 4000 / 12345 * 100);
  assert.equal(report.parent.costUsd.value, 0.045);
});

test("child result usage is attributable and duplicate custom/tool result copies count once", () => {
  const details = { mode: "parallel", runId: "run1", results: [{ agent: "scout", task: "inspect", sessionFile: "/child", usage: { input: 20, output: 5, cacheRead: 3, cacheWrite: 2, cost: 0.01 } }] };
  const report = collectUsage([assistant("p", usage(10, 2, 1, 0, 0.02)), childEntry("c1", "subagent-slash-result", { requestId: "req1", result: { details } }), childEntry("c2", "tool", details)]);
  assert.equal(report.subagents.costUsd.value, 0.01);
  assert.equal(report.subagentCount, 1);
  assert.equal(report.total.costUsd.value, 0.03);
  assert.equal(report.total.costUsd.complete, false, "child aggregates do not retain field-level provenance");
  assert.equal(report.total.prompt.value, 36);
  assert.equal(report.total.prompt.complete, false);
});

test("background child schema uses model attempts without double-counting totalCost", () => {
  const details = {
    mode: "single",
    results: [{
      agent: "scout",
      task: "inspect",
      sessionFile: "/background-child",
      modelAttempts: [{ model: "model-x", success: true, usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 5, cost: 0.04, turns: 1 } }],
      totalCost: { inputTokens: 100, outputTokens: 20, costUsd: 0.04 },
    }],
  };
  const report = collectUsage([childEntry("c", "tool", details)]);
  assert.equal(report.subagents.costUsd.value, 0.04);
  assert.equal(report.subagents.prompt.value, 155);
  assert.equal(report.subagents.cached.value, 50);
  assert.equal(report.subagents.prompt.complete, false);
  assert.ok(report.partial.includes("subagents.input"));
});

test("background child totalCost fallback exposes only retained categories", () => {
  const details = { mode: "single", results: [{ agent: "scout", task: "inspect", totalCost: { inputTokens: 100, outputTokens: 20, costUsd: 0.04 } }] };
  const report = collectUsage([childEntry("c", "tool", details)]);
  assert.equal(report.subagents.prompt.value, 100);
  assert.equal(report.subagents.cached.value, null);
  assert.equal(report.subagents.output.value, 20);
  assert.equal(report.subagents.costUsd.value, 0.04);
  assert.equal(report.subagents.costUsd.complete, false);
});

test("missing provider pricing and usage categories remain partial, never zero-valued", () => {
  const report = collectUsage([assistant("p", { input: 8, output: 2, cacheRead: 0 })]);
  assert.deepEqual(report.parent.cached, { value: 0, complete: true });
  assert.equal(report.parent.uncached.complete, false);
  assert.deepEqual(report.parent.costUsd, { value: null, complete: false });
  assert.equal(report.complete, false);
  assert.ok(report.partial.includes("parent.costUsd"));
});

test("unknown child attribution stays unavailable rather than zero", () => {
  const report = collectUsage([assistant("p", usage(0, 0, 0, 0, 0))]);
  assert.equal(report.subagentCount, null);
  assert.ok(report.unavailable.includes("subagents.attribution"));
  assert.equal(report.subagents.costUsd.value, null);
  assert.equal(report.total.costUsd.complete, false, "unobserved subagent attribution makes branch totals partial");
});

test("unverified child-result shapes are not treated as usage metadata", () => {
  const malformed = { results: [{ agent: "scout", usage: usage(20, 5, 3, 2, 0.01) }] };
  const report = collectUsage([childEntry("c", "tool", malformed)]);
  assert.equal(report.subagentCount, null);
  assert.ok(report.unavailable.includes("subagents.attribution"));
  assert.equal(report.subagents.costUsd.value, null);
});

test("missing parent usage cannot make child-only branch totals look complete", () => {
  const details = { mode: "single", results: [{ agent: "scout", task: "inspect", sessionFile: "/child", usage: { input: 20, output: 5, cacheRead: 3, cacheWrite: 2, cost: 0.01 } }] };
  const report = collectUsage([assistant("p", undefined), childEntry("c", "tool", details)]);
  assert.equal(report.parent.total.value, null);
  assert.equal(report.total.prompt.value, 25);
  assert.equal(report.total.prompt.complete, false);
  assert.ok(report.unavailable.includes("parent.usage"));
});

test("identical child records without a stable identity are counted once and marked ambiguous", () => {
  const result = { agent: "scout", task: "same", usage: { input: 20, output: 5, cacheRead: 3, cacheWrite: 2, cost: 0.01 } };
  const details = { mode: "parallel", results: [result, { ...result }] };
  const report = collectUsage([assistant("p", usage(10, 2, 1, 0, 0.02)), childEntry("c", "tool", details)]);
  assert.equal(report.subagents.costUsd.value, 0.01);
  assert.equal(report.subagentCount, null);
  assert.ok(report.partial.includes("subagents.duplicateIdentity"));
  assert.equal(report.total.costUsd.complete, false);
});

test("same child session file with conflicting snapshots is not double-counted", () => {
  const details = {
    mode: "parallel",
    results: [
      { agent: "scout", task: "inspect", sessionFile: "/child", usage: { input: 20, output: 5, cacheRead: 3, cacheWrite: 2, cost: 0.01 } },
      { agent: "scout", task: "inspect", sessionFile: "/child", usage: { input: 20, output: 5, cacheRead: 3, cacheWrite: 2, cost: 0.02 } },
    ],
  };
  const report = collectUsage([childEntry("c", "tool", details)]);
  assert.equal(report.subagents.costUsd.value, 0.01);
  assert.equal(report.subagentCount, null);
  assert.ok(report.partial.includes("subagents.duplicateIdentity"));
});

test("zero-valued aggregated child fields are unavailable, not known zeros", () => {
  const details = { mode: "single", results: [{ agent: "scout", task: "inspect", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } }] };
  const report = collectUsage([assistant("p", usage(10, 2, 1, 0, 0.02)), childEntry("c", "tool", details)]);
  assert.equal(report.subagents.prompt.value, null);
  assert.equal(report.subagents.costUsd.value, null);
  assert.ok(report.partial.includes("subagents.input"));
  assert.ok(report.partial.includes("subagents.costUsd"));
});
