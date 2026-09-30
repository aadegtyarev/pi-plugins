import test from "node:test";
import assert from "node:assert/strict";
import { collectUsage } from "./usage.ts";
import { ERROR_CODES, formatSummary, formatToolContent, SAFE_ERRORS } from "./report.ts";

const parentEntry = (usage: unknown) => ({ type: "message", id: "p", parentId: null, timestamp: "", message: { role: "assistant", content: [], api: "x", provider: "x", model: "x", usage } }) as never;
const childEntry = (results: unknown[]) => ({ type: "message", id: "child", parentId: null, timestamp: "", message: { role: "toolResult", toolName: "subagent", details: { mode: "parallel", results }, content: [], toolCallId: "c", isError: false } }) as never;

test("summary is compact Russian and labels estimate and partial availability", () => {
  const report = collectUsage([]);
  const text = formatSummary(report);
  assert.match(text, /Расходы текущей ветки сессии \(оценка\)/);
  assert.match(text, /prompt недоступно/);
  assert.match(text, /Стоимость: недоступно/);
  assert.match(text, /не счет провайдера/);
});

test("summary preserves localized token grouping and cost attribution", () => {
  const report = collectUsage([
    parentEntry({ input: 8345, output: 1234, cacheRead: 4000, cacheWrite: 0, cost: { total: 0.045 } }),
    childEntry([0, 1, 2].map((i) => ({ agent: `scout-${i}`, task: "inspect", sessionFile: `/child-${i}`, usage: { input: 10, output: 2, cacheRead: 1, cacheWrite: 1, cost: 0.026 } }))),
  ]);
  const text = formatSummary(report);
  assert.match(text, /prompt 12[\s\u00a0\u202f]381/);
  assert.match(text, /кеш 4[\s\u00a0\u202f]003/);
  assert.match(text, /Стоимость: \$0\.123 \(частично\) \(основной агент \$0\.045; сабагенты \$0\.078 \(частично\), 3\)/);
  assert.match(formatToolContent(report), /Структурированные данные \(JSON\):\n\{/);
});

test("partial zero totals are not rendered as an exact zero", () => {
  const report = collectUsage([parentEntry({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } })]);
  const text = formatSummary(report);
  assert.match(text, /Стоимость: недоступно \(частично\)/);
});

test("stable safe error references are available for both boundaries", () => {
  assert.match(SAFE_ERRORS.tool, new RegExp(ERROR_CODES.tool));
  assert.match(SAFE_ERRORS.automatic, new RegExp(ERROR_CODES.automatic));
  assert.doesNotMatch(SAFE_ERRORS.tool, /stack|secret|token=/i);
});
