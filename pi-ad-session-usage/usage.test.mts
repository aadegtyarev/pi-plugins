import test from "node:test";
import assert from "node:assert/strict";
import { collectUsage } from "./usage.ts";
import { ASYNC_USAGE_ACCOUNTING_ENTRY_TYPE, parseAsyncAccountingEnvelope } from "./async-accounting.ts";
import { formatSummary } from "./report.ts";

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
  assert.equal(report.rows[0]?.calls, 1);
  assert.equal(report.rows[0]?.model, "x");
  assert.equal(report.rows[0]?.effort, null);
  assert.equal(report.totalCalls, null, "without recognized child results the total invocation count is unknown");
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
  assert.equal(report.rows.find((row) => row.kind === "subagent")?.calls, 1);
  assert.equal(report.totalCalls, 2);
});

test("sanitized async accounting envelopes dedupe custom and legacy overlap while preserving distinct children", () => {
  const sharedUsage = { input: 10, output: 2, cacheRead: 4, cost: 0.05 };
  const envelope = {
    version: 1,
    runId: "top-async-run",
    results: [
      { resultId: "child-shared", agent: "reviewer", provider: "openai", model: "model-a", requestedModel: "model-a", thinking: "low", sessionFile: "/child/shared.jsonl", usage: sharedUsage },
      { resultId: "child-distinct", agent: "reviewer", provider: "anthropic", model: "model-b", requestedModel: "model-b", thinking: "medium", sessionFile: "/child/distinct.jsonl", totalCost: { inputTokens: 20, outputTokens: 3, costUsd: 0.07 } },
    ],
  };
  const asyncEntry = (id: string) => ({ type: "custom", id, parentId: null, timestamp: "", customType: ASYNC_USAGE_ACCOUNTING_ENTRY_TYPE, data: envelope });
  const legacy = { mode: "single", results: [{ agent: "reviewer", provider: "openai", model: "model-a", requestedModel: "model-a", thinking: "low", sessionFile: "/child/shared.jsonl", task: "legacy-only task metadata", usage: sharedUsage,
    modelAttempts: [{ model: "legacy-internal-model", usage: { input: 10, output: 2, cacheRead: 4, cost: 0.05 } }] }] };
  const legacyEntry = childEntry("legacy", "tool", legacy);
  const permutations = [
    [asyncEntry("accounting-1"), asyncEntry("accounting-duplicate"), legacyEntry],
    [legacyEntry, asyncEntry("accounting-1"), asyncEntry("accounting-duplicate")],
  ];
  for (const records of permutations) {
    const report = collectUsage([assistant("parent", usage(5, 1, 0, 0, 0.01)), ...records] as never[]);
    assert.equal(report.subagentCount, 2, "duplicate accounting entry and legacy overlap each count once");
    assert.equal(report.totalCalls, 3);
    assert.equal(report.subagents.input.value, 30);
    assert.equal(report.subagents.output.value, 5);
    assert.equal(report.subagents.cached.value, 4);
    assert.ok(Math.abs((report.subagents.costUsd.value ?? 0) - 0.12) < 1e-12);
    assert.equal(report.subagents.input.complete, true, "authoritative async completeness is order-independent");
    assert.equal(report.subagents.cacheWrite.value, null);
    assert.equal(report.subagents.cacheWrite.complete, false);
    assert.equal(report.subagents.costUsd.complete, true);
    assert.deepEqual(report.rows.filter((row) => row.kind === "subagent").map((row) => [row.model, row.provider, row.effort, row.calls]), [
      ["model-b", "anthropic", "medium", 1], ["model-a", "openai", "low", 1],
    ]);
  }
});

test("async identity aliases reconcile legacy S, async R+S, and repeated R without a session file", () => {
  const usageSnapshot = { input: 8, output: 2, cacheRead: 1, cacheWrite: 0, cost: 0.02 };
  const asyncResult = (sessionFile?: string) => ({ resultId: "result-r", agent: "scout", provider: "openai", model: "model-r", thinking: "low",
    ...(sessionFile ? { sessionFile } : {}), usage: usageSnapshot });
  const asyncRecord = (id: string, result: ReturnType<typeof asyncResult>) => ({ type: "custom", id, parentId: null, timestamp: "", customType: ASYNC_USAGE_ACCOUNTING_ENTRY_TYPE,
    data: { version: 1, runId: "top-r", results: [result] } });
  const legacy = childEntry("legacy-s", "tool", { mode: "single", results: [{ agent: "scout", provider: "openai", model: "model-r", thinking: "low",
    sessionFile: "/child/s.jsonl", task: "legacy metadata", usage: usageSnapshot, modelAttempts: [{ model: "model-r", usage: usageSnapshot }] }] });
  const linked = asyncRecord("async-rs", asyncResult("/child/s.jsonl"));
  const repeated = asyncRecord("async-r", asyncResult());
  for (const records of [[legacy, linked, repeated], [repeated, legacy, linked], [linked, repeated, legacy]]) {
    const report = collectUsage([assistant("parent", usage(1, 1, 0, 0, 0.01)), ...records] as never[]);
    assert.equal(report.subagentCount, 1);
    assert.equal(report.totalCalls, 2);
    assert.equal(report.subagents.input.value, 8);
    assert.equal(report.subagents.input.complete, true);
    assert.equal(report.rows.find((row) => row.kind === "subagent")?.model, "model-r");
    assert.ok(!report.partial.includes("subagents.duplicateIdentity"));
  }
});

test("async accounting entries reject non-contract fields and malformed metrics", () => {
  const valid = { version: 1, runId: "run", results: [{ resultId: "child", usage: { input: 1 } }] };
  assert.deepEqual(parseAsyncAccountingEnvelope(valid)?.results[0]?.usage, { input: 1 });
  assert.equal(parseAsyncAccountingEnvelope({ ...valid, prompt: "private" }), undefined);
  assert.equal(parseAsyncAccountingEnvelope({ version: 1, runId: "run", results: [{ resultId: "child", usage: { input: -1 } }] }), undefined);
  assert.equal(parseAsyncAccountingEnvelope({ version: 1, runId: "run", results: [{ resultId: "child", usage: { input: 1, transcript: "private" } }] }), undefined);
  const invalidCustom = { type: "custom", id: "invalid", parentId: null, timestamp: "", customType: ASYNC_USAGE_ACCOUNTING_ENTRY_TYPE,
    data: { ...valid, mode: "single", results: [{ resultId: "child", agent: "reviewer", usage: { input: 99 }, task: "must not fall through" }] } };
  const report = collectUsage([assistant("parent", usage(2, 1, 0, 0, 0.01)), invalidCustom] as never[]);
  assert.equal(report.subagentCount, null);
  assert.ok(report.unavailable.includes("subagents.attribution"));
  assert.equal(report.subagents.input.value, null, "invalid custom data cannot be reinterpreted as a legacy result");
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

test("multiple model attempts within one child invocation aggregate under one grouped call", () => {
  const details = {
    mode: "single",
    results: [{
      agent: "reviewer", sessionFile: "/reviewer", modelAttempts: [
        { model: "model-x", thinking: "high", usage: { input: 10, output: 2, cacheRead: 4, cacheWrite: 1, cost: 0.01 } },
        { model: "model-x", thinking: "high", usage: { input: 20, output: 3, cacheRead: 8, cacheWrite: 1, cost: 0.02 } },
      ],
    }],
  };
  const report = collectUsage([childEntry("c", "tool", details)]);
  const row = report.rows.find((item) => item.kind === "subagent");
  assert.equal(row?.calls, 1);
  assert.equal(row?.usage.input.value, 30);
  assert.equal(row?.usage.output.value, 5);
  assert.equal(report.totalCalls, 1);
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

test("legacy fallback keeps distinct tasks separate when no stable child identity exists", () => {
  const usage = { input: 20, output: 5, cacheRead: 3, cacheWrite: 2, cost: 0.01 };
  const details = { mode: "parallel", results: [
    { agent: "scout", task: "inspect source", usage },
    { agent: "scout", task: "inspect tests", usage },
  ] };
  const report = collectUsage([childEntry("c", "tool", details)]);
  assert.equal(report.subagentCount, 2);
  assert.equal(report.subagents.input.value, 40);
  assert.equal(report.subagents.output.value, 10);
  assert.equal(report.totalCalls, 2);
  assert.ok(!report.partial.includes("subagents.duplicateIdentity"));
});

test("legacy session snapshots with different attempt attribution are ambiguous in either order", () => {
  const aggregateUsage = { input: 10, output: 2, cacheRead: 4, cacheWrite: 1, cost: 0.05 };
  const attemptUsage = { input: 10, output: 2, cacheRead: 4, cacheWrite: 1, cost: 0.05 };
  const result = (model: string, provider: string, thinking: string) => ({
    agent: "reviewer", sessionFile: "/child/shared.jsonl", usage: aggregateUsage,
    modelAttempts: [{ model, provider, thinking, usage: attemptUsage }],
  });
  const snapshots = [result("model-a", "openai", "low"), result("model-b", "anthropic", "high")];
  for (const results of [snapshots, [...snapshots].reverse()]) {
    const report = collectUsage([childEntry("c", "tool", { mode: "parallel", results })]);
    assert.equal(report.subagents.input.value, 10);
    assert.equal(report.subagentCount, null);
    assert.equal(report.totalCalls, null);
    assert.ok(report.partial.includes("subagents.duplicateIdentity"));
    const row = report.rows.find((item) => item.kind === "subagent");
    assert.equal(row?.calls, null);
    assert.equal(row?.model, null);
    assert.equal(row?.provider, null);
  }
});

test("identical child records without a stable identity are counted once and marked ambiguous", () => {
  const result = { agent: "scout", task: "same", usage: { input: 20, output: 5, cacheRead: 3, cacheWrite: 2, cost: 0.01 } };
  const details = { mode: "parallel", results: [result, { ...result }] };
  const report = collectUsage([assistant("p", usage(10, 2, 1, 0, 0.02)), childEntry("c", "tool", details)]);
  assert.equal(report.subagents.costUsd.value, 0.01);
  assert.equal(report.subagentCount, null);
  assert.ok(report.partial.includes("subagents.duplicateIdentity"));
  assert.equal(report.rows.find((row) => row.kind === "subagent")?.calls, null);
  assert.equal(report.totalCalls, null);
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

test("duplicate child snapshots with conflicting model labels keep attribution ambiguous", () => {
  const usage = { input: 20, output: 5, cacheRead: 3, cacheWrite: 2, cost: 0.01 };
  const details = {
    mode: "parallel",
    results: [
      { agent: "reviewer", task: "inspect", sessionFile: "/child", model: "model-a", usage },
      { agent: "reviewer", task: "inspect", sessionFile: "/child", model: "model-b", usage },
    ],
  };
  const report = collectUsage([childEntry("c", "tool", details)]);
  assert.equal(report.subagentCount, null);
  assert.equal(report.totalCalls, null);
  assert.ok(report.partial.includes("subagents.duplicateIdentity"));
  const row = report.rows.find((item) => item.kind === "subagent");
  assert.equal(row?.calls, null);
  assert.equal(row?.agent, null);
  assert.equal(row?.provider, null);
  assert.equal(row?.model, null);
  assert.match(formatSummary(report), /subagent\/unknown ×— ↑20 ↓5 R3 W2 CH— ~\$0\.01 unknown model • effort unknown/);
});

test("zero-valued aggregated child fields are unavailable, not known zeros", () => {
  const details = { mode: "single", results: [{ agent: "scout", task: "inspect", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } }] };
  const report = collectUsage([assistant("p", usage(10, 2, 1, 0, 0.02)), childEntry("c", "tool", details)]);
  assert.equal(report.subagents.prompt.value, null);
  assert.equal(report.subagents.costUsd.value, null);
  assert.ok(report.partial.includes("subagents.input"));
  assert.ok(report.partial.includes("subagents.costUsd"));
});
