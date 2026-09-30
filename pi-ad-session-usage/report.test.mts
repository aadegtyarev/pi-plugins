import test from "node:test";
import assert from "node:assert/strict";
import { collectUsage } from "./usage.ts";
import { ERROR_CODES, formatSummary, formatToolContent, SAFE_ERRORS } from "./report.ts";

const parentEntry = (usage: unknown) => ({ type: "message", id: "p", parentId: null, timestamp: "", message: { role: "assistant", content: [], api: "x", provider: "x", model: "x", usage } }) as never;
const childEntry = (results: unknown[]) => ({ type: "message", id: "child", parentId: null, timestamp: "", message: { role: "toolResult", toolName: "subagent", details: { mode: "parallel", results }, content: [], toolCallId: "c", isError: false } }) as never;

test("summary is compact and explains unavailable data without invoice boilerplate", () => {
  const report = collectUsage([]);
  const text = formatSummary(report);
  assert.match(text, /↑— ↓— R— W— CH— Σ— — · основная — \+ сабагенты — \/ —/);
  assert.match(text, /Основная сессия: в ветке нет сохранённой usage-статистики/);
  assert.match(text, /Сабагенты: не найдены отчёты в поддерживаемом формате/);
  assert.match(text, /CH—: cache hit нельзя вычислить без полных prompt- и cache-данных/);
  assert.doesNotMatch(text, /не счет провайдера|частично/i);
});

test("summary uses compact usage notation and shows token and cost attribution", () => {
  const report = collectUsage([
    parentEntry({ input: 8345, output: 1234, cacheRead: 4000, cacheWrite: 0, cost: { total: 0.045 } }),
    childEntry([0, 1, 2].map((i) => ({ agent: `scout-${i}`, task: "inspect", sessionFile: `/child-${i}`, usage: { input: 10, output: 2, cacheRead: 1, cacheWrite: 1, cost: 0.026 } }))),
  ]);
  const text = formatSummary(report);
  assert.match(text, /↑8\.4k\? ↓1\.2k\? R4\.0k\? W3\? CH— Σ14k\? ≈\$0\.123\? · основная \$0\.045 \+ сабагенты \$0\.078\? \/ 3/);
  assert.match(text, /Сабагенты \(3\): агрегат Pi не помечает пропуски полей/);
  assert.match(text, /CH—: cache hit нельзя вычислить без полных prompt- и cache-данных/);
  assert.doesNotMatch(text, /не счет провайдера|частично/i);
  assert.match(formatToolContent(report), /Структурированные данные \(JSON\):\n\{/);
});

test("background fallback explains missing cache fields and unavailable cache hit", () => {
  const report = collectUsage([
    parentEntry({ input: 10, output: 2, cacheRead: 4, cacheWrite: 0, cost: { total: 0.02 } }),
    childEntry([{ agent: "worker", sessionFile: "/worker", totalCost: { inputTokens: 100, outputTokens: 20, costUsd: 0.04 } }]),
  ]);
  const text = formatSummary(report);
  assert.match(text, /Сабагенты \(1\): сохранены входные\/выходные токены и стоимость, но нет cache-read\/cache-write токенов/);
  assert.match(text, /CH—: cache hit нельзя вычислить без полных prompt- и cache-данных/);
});

test("incomplete parent cost is named separately from token completeness", () => {
  const report = collectUsage([
    parentEntry({ input: 2, output: 3, cacheRead: 0, cacheWrite: 0 }),
    childEntry([]),
  ]);
  const text = formatSummary(report);
  assert.match(text, /основная — \+ сабагенты/);
  assert.match(text, /Основная сессия: не сохранены стоимость/);
  assert.doesNotMatch(text, /Основная сессия: не сохранены .*токены/);
});

test("positive sub-cent costs are not rounded down to an apparent zero", () => {
  const report = collectUsage([
    parentEntry({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.004 } }),
    childEntry([]),
  ]);
  assert.match(formatSummary(report), /↑1 ↓1 R0 CH0\.0% Σ2 ≈\$0\.004 · основная \$0\.004/);
});

test("partial zero totals are not rendered as an exact zero", () => {
  const report = collectUsage([parentEntry({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } })]);
  const text = formatSummary(report);
  assert.match(text, /Σ2\?/);
  assert.match(text, /Сабагенты: не найдены отчёты в поддерживаемом формате/);
  assert.doesNotMatch(text, /≈\$0\.000/);
});

test("stable safe error references are available for both boundaries", () => {
  assert.match(SAFE_ERRORS.tool, new RegExp(ERROR_CODES.tool));
  assert.match(SAFE_ERRORS.automatic, new RegExp(ERROR_CODES.automatic));
  assert.doesNotMatch(SAFE_ERRORS.tool, /stack|secret|token=/i);
});
