import assert from "node:assert/strict";
import test from "node:test";
import { TelegramTypingIndicator, type TypingTimerApi } from "./typing-indicator.ts";

function fakeTimers() {
  let callback: (() => void) | undefined;
  let delay = 0;
  let cleared = 0;
  const timer = 1 as unknown as ReturnType<typeof setInterval>;
  const api: TypingTimerApi = {
    setInterval(next, ms) { callback = next; delay = ms; return timer; },
    clearInterval(value) { assert.equal(value, timer); cleared++; callback = undefined; },
  };
  return {
    api,
    fire() { callback?.(); },
    get delay() { return delay; },
    get cleared() { return cleared; },
  };
}

test("typing indicator sends immediately, refreshes, and stops on abort", async () => {
  const timers = fakeTimers();
  const calls: number[] = [];
  const controller = new AbortController();
  const indicator = new TelegramTypingIndicator(async (chatId) => { calls.push(chatId); }, 4000, timers.api);

  indicator.start(42, controller.signal);
  await Promise.resolve();
  assert.deepEqual(calls, [42]);
  assert.equal(timers.delay, 4000);
  timers.fire();
  await Promise.resolve();
  assert.deepEqual(calls, [42, 42]);

  controller.abort();
  assert.equal(timers.cleared, 1);
  timers.fire();
  await Promise.resolve();
  assert.deepEqual(calls, [42, 42]);
});

test("typing indicator prevents overlapping actions and aborts an in-flight action on stop", async () => {
  const timers = fakeTimers();
  let resolveRequest: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  let calls = 0;
  const indicator = new TelegramTypingIndicator(async (_chatId, requestSignal) => {
    calls++;
    signal = requestSignal;
    await new Promise<void>((resolve) => { resolveRequest = resolve; });
  }, 4000, timers.api);

  indicator.start(7, new AbortController().signal);
  timers.fire();
  assert.equal(calls, 1);
  indicator.stop();
  assert.equal(signal?.aborted, true);
  resolveRequest?.();
});

test("typing action failures are reported without escaping the timer callback", async () => {
  const timers = fakeTimers();
  const errors: unknown[] = [];
  const indicator = new TelegramTypingIndicator(async () => { throw new Error("network"); }, 4000, timers.api, (error) => errors.push(error));
  indicator.start(1, new AbortController().signal);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(errors.length, 1);
  indicator.stop();
});
