import assert from "node:assert/strict";
import test from "node:test";
import { CompactionActivityLifecycle, formatLocalTime, renderTelegramActivity, type TelegramActivityTool } from "./telegram-activity.ts";

const base = {
  order: [],
  tools: new Map<string, TelegramActivityTool>(),
  working: true,
  inputTokens: 0,
  outputTokens: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextWindow: 128_000,
  contextPercent: 0,
  thinkingLevel: "medium",
  messageLimit: 3500,
  historyLimit: 35,
  textLimit: 550,
  updatedAt: new Date(2026, 8, 30, 9, 7),
};

test("activity timestamp is local HH:mm with no calendar date", () => {
  assert.equal(formatLocalTime(new Date(2026, 8, 30, 9, 7)), "09:07");
  assert.equal(formatLocalTime(new Date(2026, 8, 30, 22, 3)), "22:03");
});

test("activity timestamp is the final line of the final bubble", () => {
  const parts = renderTelegramActivity({ ...base, order: [{ type: "tool", id: "compact" }], tools: new Map([[
    "compact", { summary: "🧹 Compact context (threshold reached)", status: "running" },
  ]]) });
  assert.equal(parts.length, 1);
  assert.match(parts[0]!, /🧹 Compact context \(threshold reached\) …/);
  assert.equal(parts[0]!.split("\n").at(-1), "Updated: 09:07");
});

test("activity renderer puts update time on the final split bubble, not in a separate message", () => {
  const lines = Array.from({ length: 12 }, (_, index) => ({ type: "tool" as const, id: String(index) }));
  const tools = new Map(lines.map(({ id }) => [id, { summary: `entry ${id} ${"x".repeat(90)}`, status: "done" as const }]));
  const parts = renderTelegramActivity({ ...base, order: lines, tools, messageLimit: 500, textLimit: 100 });
  assert.ok(parts.length > 1);
  assert.ok(parts.slice(0, -1).every((part) => !part.includes("Updated:")));
  assert.equal(parts.at(-1)!.split("\n").at(-1), "Updated: 09:07");
});

test("manual command and Pi lifecycle events share one compaction row and finalize once", () => {
  const lifecycle = new CompactionActivityLifecycle();
  const commandRow = lifecycle.begin("Compacting context (requested)");
  const eventRow = lifecycle.begin("Compacting context (threshold reached)");
  assert.equal(eventRow.id, commandRow.id);
  assert.equal(lifecycle.active?.summary, "Compacting context (threshold reached)");
  const completed = lifecycle.finish(commandRow.id, "done", "Context compacted");
  assert.deepEqual(completed, { id: commandRow.id, summary: "Context compacted", status: "done" });
  assert.equal(lifecycle.finish(commandRow.id, "failed", "duplicate failure"), undefined);
  const failedRow = lifecycle.begin("Another compaction");
  assert.deepEqual(lifecycle.finish(failedRow.id, "failed", "Context compaction failed"), {
    id: failedRow.id, summary: "Context compaction failed", status: "failed",
  });
  assert.notEqual(lifecycle.begin("Next compaction").id, failedRow.id);
});
