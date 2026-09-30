import assert from "node:assert/strict";
import test from "node:test";
import {
  availableEfforts,
  compactTaskPreview,
  countEditLines,
  splitAllowedIds,
  toolInputSummary,
} from "./telegram-format.ts";

test("task previews normalize intent and redact secrets and local paths", () => {
  const preview = compactTaskPreview("Review /home/alice/private/repo and token=secret-value. Then continue", 180);
  assert.match(preview, /^Review:/);
  assert.doesNotMatch(preview, /alice|private\/repo|secret-value/);
  assert.ok(preview.endsWith("…") === false);
});

test("edit summaries count changed lines and safely bound large diffs", () => {
  assert.deepEqual(countEditLines("a\nb\nc", "a\nx\nc\nd"), { added: 2, removed: 1 });
  const oldText = Array.from({ length: 1500 }, (_, index) => `line ${index}`).join("\n");
  const newText = oldText.replace("line 750", "updated line 750");
  assert.deepEqual(countEditLines(oldText, newText), { added: 1, removed: 1 });
});

test("tool activity summaries respect named presentation limits", () => {
  assert.match(toolInputSummary("web_search", { queries: ["one", "two", "three", "four"] }, 82), /\(\+2\)$/);
  assert.equal(toolInputSummary("web_fetch", { urls: ["https://example.com/a?q=secret"] }, 82), "🔗 Fetch: example.com/a");
});

test("Telegram IDs and model-supported effort levels are filtered", () => {
  assert.deepEqual([...splitAllowedIds("7, 0, nope, 7, 9007199254740992")], [7]);
  assert.deepEqual(availableEfforts({
    reasoning: true,
    thinkingLevelMap: { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null },
  } as never), ["off", "minimal", "low", "medium", "high"]);
});
