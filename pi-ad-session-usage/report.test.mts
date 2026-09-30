import test from "node:test";
import assert from "node:assert/strict";
import { collectUsage } from "./usage.ts";
import { ERROR_CODES, formatSummary, formatToolContent, SAFE_ERRORS } from "./report.ts";

const parentEntry = (usage: unknown) => ({ type: "message", id: "p", parentId: null, timestamp: "", message: { role: "assistant", content: [], api: "x", provider: "x", model: "x", usage } }) as never;
const childEntry = (results: unknown[]) => ({ type: "message", id: "child", parentId: null, timestamp: "", message: { role: "toolResult", toolName: "subagent", details: { mode: "parallel", results }, content: [], toolCallId: "c", isError: false } }) as never;
const grouped = (value: number) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(value);
const availabilityNote = "В отчёте только данные, которые Pi сохранил и удалось собрать; отсутствующая статистика не считается нулевой.";

test("empty report uses descriptive unavailable labels and one closing data note", () => {
  const text = formatSummary(collectUsage([]));
  assert.match(text, /^Расходы текущей ветки сессии \(оценка\)/);
  assert.match(text, /Токены: prompt недоступно \(кеш недоступно \/ без кеша недоступно\), output недоступно, всего недоступно; cache hit недоступен\./);
  assert.match(text, /Стоимость: нет данных \(основной агент нет данных\)\./);
  assert.equal(text.split(availabilityNote).length - 1, 1);
  assert.doesNotMatch(text, /частично|\?/i);
  assert.doesNotMatch(text, /сабагенты .*\$0\.000|сабагенты.*\b0\b/);
});

test("detailed summary shows full token counts and parent/subagent attribution", () => {
  const report = collectUsage([
    parentEntry({ input: 8345, output: 1234, cacheRead: 4000, cacheWrite: 0, cost: { total: 0.045 } }),
    childEntry([0, 1, 2].map((i) => ({ agent: `scout-${i}`, task: "inspect", sessionFile: `/child-${i}`, usage: { input: 10, output: 2, cacheRead: 1, cacheWrite: 1, cost: 0.026 } }))),
  ]);
  const text = formatSummary(report);
  assert.ok(text.includes(`Токены: prompt ${grouped(12_381)} (кеш ${grouped(4_003)} / без кеша ${grouped(8_378)}), output ${grouped(1_240)}, всего ${grouped(13_621)}; cache hit недоступен.`));
  assert.ok(text.includes("Стоимость: $0.123 (основной агент $0.045; сабагенты $0.078, 3)."));
  assert.equal(text.split(availabilityNote).length - 1, 1);
  assert.doesNotMatch(text, /частично|\?/i);
  assert.match(formatToolContent(report), /Структурированные данные \(JSON\):\n\{/);
});

test("background fallback shows retained values without inventing cache data", () => {
  const report = collectUsage([
    parentEntry({ input: 10, output: 2, cacheRead: 4, cacheWrite: 0, cost: { total: 0.02 } }),
    childEntry([{ agent: "worker", sessionFile: "/worker", totalCost: { inputTokens: 100, outputTokens: 20, costUsd: 0.04 } }]),
  ]);
  const text = formatSummary(report);
  assert.ok(text.includes(`Токены: prompt ${grouped(114)} (кеш ${grouped(4)} / без кеша ${grouped(110)}), output ${grouped(22)}, всего ${grouped(136)}; cache hit недоступен.`));
  assert.ok(text.includes("сабагенты $0.040, 1"));
  assert.equal(text.split(availabilityNote).length - 1, 1);
});

test("missing parent cost is unavailable without marking measured token counts", () => {
  const text = formatSummary(collectUsage([
    parentEntry({ input: 2, output: 3, cacheRead: 0, cacheWrite: 0 }),
    childEntry([]),
  ]));
  assert.match(text, /prompt 2 \(кеш 0 \/ без кеша 2\), output 3, всего 5/);
  assert.match(text, /Стоимость: нет данных \(основной агент нет данных\)\./);
  assert.doesNotMatch(text, /prompt[^\n]*частично|\?/i);
});

test("positive sub-cent costs remain visible in the detailed format", () => {
  const text = formatSummary(collectUsage([
    parentEntry({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.004 } }),
    childEntry([]),
  ]));
  assert.match(text, /Стоимость: \$0\.004 \(основной агент \$0\.004\)\./);
});

test("incomplete zero totals are not rendered as measured zero", () => {
  const text = formatSummary(collectUsage([
    parentEntry({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }),
  ]));
  assert.match(text, /prompt 1 \(кеш недоступно \/ без кеша 1\), output 1, всего 2/);
  assert.match(text, /Стоимость: нет данных \(основной агент \$0\.000\)\./);
  assert.doesNotMatch(text, /Стоимость: \$0\.000/);
});

test("stable safe error references are available for both boundaries", () => {
  assert.match(SAFE_ERRORS.tool, new RegExp(ERROR_CODES.tool));
  assert.match(SAFE_ERRORS.automatic, new RegExp(ERROR_CODES.automatic));
  assert.doesNotMatch(SAFE_ERRORS.tool, /stack|secret|token=/i);
});
