import test from "node:test";
import assert from "node:assert/strict";
import { PromptQueue } from "./prompt-queue.ts";

test("staged prompt additions are consumed once and cleared on run/session lifecycle", () => {
  const queue = new PromptQueue();
  queue.stage("one", "next request only");
  queue.stage("one", "duplicate while pending");
  queue.stage("two", "second in configured order");
  assert.deepEqual(queue.consume(), ["next request only", "second in configured order"]);
  queue.stage("one", "can stage after consumption");
  assert.deepEqual(queue.consume(), ["can stage after consumption"]);
  queue.stage("abandoned", "abandoned run"); queue.clear(); assert.deepEqual(queue.consume(), []);
});
