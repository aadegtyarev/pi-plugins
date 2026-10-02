import test from "node:test";
import assert from "node:assert/strict";
import { collectUsage } from "./usage.ts";
import { ERROR_CODES, formatSummary, formatToolContent, SAFE_ERRORS } from "./report.ts";

const parentEntry = (usage: unknown, overrides: Record<string, unknown> = {}) => ({ type: "message", id: "p", parentId: null, timestamp: "", message: { role: "assistant", content: [], api: "x", provider: "test", model: "model-x", providerThinkingLevel: "medium", usage, ...overrides } }) as never;
const childEntry = (results: unknown[]) => ({ type: "message", id: "child", parentId: null, timestamp: "", message: { role: "toolResult", toolName: "subagent", details: { mode: "parallel", results }, content: [], toolCallId: "c", isError: false } }) as never;

test("empty report uses concise English labels and preserves unknown values", () => {
  const text = formatSummary(collectUsage([]));
  assert.match(text, /^Session: duration unavailable/);
  assert.match(text, /Usage data unavailable/);
  assert.match(text, /Total ×— ↑— ↓— R— W— CH— —/);
  assert.doesNotMatch(text, /\$0\.000/);
});

test("groups parent and subagent usage by model and effort with counts and compact metrics", () => {
  const branch = [
    { type: "message", id: "user", parentId: null, timestamp: "2026-10-02T12:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
    parentEntry({ input: 8345, output: 1234, cacheRead: 4000, cacheWrite: 0, cost: { total: 0.045 } }),
    parentEntry({ input: 4000, output: 200, cacheRead: 1600, cacheWrite: 10, cost: { total: 0.012 } }),
    childEntry([
      { agent: "reviewer", model: "gpt-6.1-sol", thinking: "high", sessionFile: "/reviewer-1", usage: { input: 2000, output: 400, cacheRead: 80250, cacheWrite: 0, cost: 3.06 } },
      { agent: "reviewer", model: "gpt-6.1-sol", thinking: "high", sessionFile: "/reviewer-2", usage: { input: 2600, output: 517, cacheRead: 80250, cacheWrite: 0, cost: 3.06 } },
      { agent: "coder", model: "gpt-6-luna", thinking: "high", sessionFile: "/coder-1", totalCost: { inputTokens: 850, outputTokens: 100, costUsd: 0.83 } },
    ]),
  ] as never[];
  const now = Date.parse("2026-10-02T12:34:00.000Z");
  const report = collectUsage(branch as never, now);
  const text = formatSummary(report);
  assert.match(text, /^Session: 0h 34m · Pi-recorded usage \(estimated USD\)/);
  assert.match(text, /parent ×2 ↑12\.3k ↓1\.4k R5\.6k W10 CH31\.2% \$0\.057 test\/model-x • medium/);
  assert.match(text, /subagent\/reviewer ×2 ↑4\.6k ↓917 R160\.5k W— CH— ~\$6\.12 gpt-6\.1-sol • high/);
  assert.match(text, /subagent\/coder ×1 ↑850 ↓100 R— W— CH— ~\$0\.83 gpt-6-luna • high/);
  assert.match(text, /Total ×5 ↑17\.8k ↓2\.5k R166\.1k W10 CH— ~\$7\.007/);
  assert.equal(report.rows.length, 3);
  assert.equal(report.rows.find((row) => row.agent === "reviewer")?.calls, 2);
  assert.match(formatToolContent(report), /Report data \(JSON\):\n\{/);
  assert.equal(JSON.parse(formatToolContent(report).split("Report data (JSON):\n")[1]!).rows.length, 3);
});

test("compact cost formatting preserves sub-cent and tiny positive values", () => {
  const report = collectUsage([
    parentEntry({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.004 } }),
    childEntry([]),
  ]);
  assert.match(formatSummary(report), /parent ×1 .* \$0\.004/);

  const tiny = collectUsage([
    parentEntry({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0000004 } }),
    childEntry([]),
  ]);
  assert.match(formatSummary(tiny), /parent ×1 .* <\$0\.000001/);
});

test("missing measurements and model attribution remain visibly unknown", () => {
  const report = collectUsage([
    parentEntry(undefined, { model: undefined, providerThinkingLevel: undefined }),
    childEntry([{ agent: "reviewer", sessionFile: "/reviewer", model: "gpt-6.1-sol" }]),
  ]);
  const text = formatSummary(report);
  assert.match(text, /parent ×1 ↑— ↓— R— W— CH— — unknown model • effort unknown/);
  assert.match(text, /subagent\/reviewer ×1 ↑— ↓— R— W— CH— — gpt-6\.1-sol • effort unknown/);
  assert.doesNotMatch(text, /↑0|↓0|\$0\.000/);
});

test("safe tool and command failures have stable references and English text", () => {
  assert.match(SAFE_ERRORS.tool, /Could not collect session usage/);
  assert.match(SAFE_ERRORS.command, /Could not collect session usage/);
  assert.match(SAFE_ERRORS.tool, new RegExp(ERROR_CODES.tool));
  assert.match(SAFE_ERRORS.command, new RegExp(ERROR_CODES.command));
  assert.doesNotMatch(SAFE_ERRORS.tool, /stack|secret|token=/i);
});
