import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TelegramOutbox } from "./outbox.ts";

const ok = async <T,>(_token: string, _method: string, _body: Record<string, unknown>, _signal: AbortSignal): Promise<T> => ({ ok: true } as T);

async function withTempOutbox(run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-outbox-"));
  try {
    await run(join(dir, "outbox.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("outbox persists request without token and awaits API result", async () => withTempOutbox(async (path) => {
  const outbox = new TelegramOutbox(path);
  let calls = 0;
  const requester = async <T,>(_token: string, _method: string, _body: Record<string, unknown>, _signal: AbortSignal): Promise<T> => {
    calls++;
    return { message_id: 10 } as T;
  };
  const result = await outbox.request<{ message_id: number }>("secret-token", "sendMessage", { chat_id: 7, text: "hello" }, new AbortController().signal, requester);
  assert.deepEqual(result, { message_id: 10 });
  assert.equal(calls, 1);
  const saved = await readFile(path, "utf8");
  assert.doesNotMatch(saved, /secret-token/);
  assert.deepEqual(JSON.parse(saved), []);
}));

test("replay sends persisted operations FIFO and removes acknowledged entries", async () => withTempOutbox(async (path) => {
  await writeFile(path, JSON.stringify([
    { id: "a", method: "sendMessage", body: { text: "first" } },
    { id: "b", method: "editMessageText", body: { text: "second" } },
  ]));
  const outbox = new TelegramOutbox(path);
  const sent: string[] = [];
  await outbox.replay("token", new AbortController().signal, async <T,>(_token: string, method: string, body: Record<string, unknown>) => {
    sent.push(`${method}:${body.text}`);
    return true as T;
  });
  assert.deepEqual(sent, ["sendMessage:first", "editMessageText:second"]);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), []);
}));

test("permanent API errors are not retried or allowed to block the outbox", async () => withTempOutbox(async (path) => {
  const outbox = new TelegramOutbox(path);
  let calls = 0;
  const requester = async <T,>(): Promise<T> => {
    calls++;
    throw Object.assign(new Error("Bad Request"), { status: 400 });
  };
  await assert.rejects(outbox.request("token", "sendMessage", { text: "x" }, new AbortController().signal, requester), /Bad Request/);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(await readFile(path, "utf8")).length, 0);
  await outbox.replay("token", new AbortController().signal, ok);
}));

test("transient network failures back off and retain entries when aborted", async () => withTempOutbox(async (path) => {
  const outbox = new TelegramOutbox(path);
  const controller = new AbortController();
  let calls = 0;
  const requester = async <T,>(): Promise<T> => {
    calls++;
    if (calls === 1) setTimeout(() => controller.abort(new Error("shutdown")), 20);
    throw new TypeError("fetch failed");
  };
  await assert.rejects(outbox.request("token", "sendMessage", { text: "x" }, controller.signal, requester), /shutdown/);
  assert.equal(calls, 1);
  const entries = JSON.parse(await readFile(path, "utf8"));
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].body, { text: "x" });
}));
