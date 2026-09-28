import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundAgentBatch } from "./agent-board.ts";
import { getTelegramCommandMenu, normalizeTelegramCommand, TELEGRAM_COMMAND_DEFINITIONS, telegramHelpText } from "./commands.ts";
import { MAX_QUEUED_TASKS, TelegramTaskQueue } from "./queue.ts";
import { renderTelegramMessage, sendTelegramMessage, type TelegramRequester } from "./message-renderer.ts";

test("agent board groups concurrent agents and starts a fresh batch after all finish", () => {
  const batches = new BackgroundAgentBatch();
  const agent = (id: string) => ({ id, agent: "worker", model: "model", task: id, status: "running" as const, startedAt: 1 });
  assert.equal(batches.start(agent("a")), true);
  assert.equal(batches.start(agent("b")), false);
  assert.equal(batches.finish("a", "completed", 2)?.status, "completed");
  assert.equal(batches.start(agent("c")), false);
  assert.deepEqual(batches.all().map((entry) => entry.id), ["a", "b", "c"]);
  batches.finish("b", "completed", 3);
  batches.finish("c", "stopped", 4);
  assert.equal(batches.hasRunning(), false);
  assert.equal(batches.start(agent("d")), true);
  assert.deepEqual(batches.all().map((entry) => entry.id), ["d"]);
});

test("queue preserves FIFO and scopes cancellation and clearing by chat", () => {
  const queue = new TelegramTaskQueue();
  const first = queue.enqueue(1, "first")!;
  const otherChat = queue.enqueue(2, "other chat")!;
  const last = queue.enqueue(1, "last")!;
  assert.equal(queue.remove(first.id, 2), undefined);
  assert.deepEqual(queue.removeAllForChat(1), [first, last]);
  assert.equal(queue.length, 1);
  assert.equal(queue.takeNext(), otherChat);
  assert.equal(queue.takeNext(), undefined);
});

test("queue enforces its shared capacity", () => {
  const queue = new TelegramTaskQueue();
  const tasks = Array.from({ length: MAX_QUEUED_TASKS }, (_, index) => queue.enqueue(1, String(index))!);
  assert.equal(queue.length, MAX_QUEUED_TASKS);
  assert.equal(queue.enqueue(1, "overflow"), undefined);
  assert.equal(queue.takeNext(), tasks[0]);
});

test("command menu, aliases, and help share one definition list", () => {
  const menu = getTelegramCommandMenu();
  assert.ok(menu.some((command) => command.command === "queue_cancel"));
  assert.equal(normalizeTelegramCommand("queue-cancel"), "queue_cancel");
  assert.equal(normalizeTelegramCommand("help"), "start");
  for (const command of menu) assert.ok(normalizeTelegramCommand(command.command));
  for (const definition of TELEGRAM_COMMAND_DEFINITIONS) assert.ok(telegramHelpText().includes(definition.help));
});

test("Markdown renders inline markup and escapes HTML", () => {
  assert.equal(renderTelegramMessage("**bold** <tag>", "markdown")[0], "<b>bold</b> &lt;tag&gt;");
});

test("plain text chunking never splits a surrogate pair", () => {
  const parts = renderTelegramMessage(`${"a".repeat(3499)}😀b`);
  assert.equal(parts.length, 2);
  assert.equal(parts[0], "a".repeat(3499));
  assert.equal(parts[1], "😀b");
});

test("HTML chunks keep tags balanced", () => {
  const parts = renderTelegramMessage(`<b>${"x".repeat(4000)}</b>`, "html");
  assert.equal(parts.length, 2);
  for (const part of parts) {
    assert.ok(part.startsWith("<b>"));
    assert.ok(part.endsWith("</b>"));
  }
  assert.equal(parts.map((part) => part.replace(/<\/?b>/g, "")).join(""), "x".repeat(4000));
});

test("formatted send falls back through the shared sender", async () => {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const request: TelegramRequester = async <T,>(_token, _method, body): Promise<T> => {
    calls.push({ body });
    if (body.parse_mode === "HTML") throw Object.assign(new Error("Bad Request: can't parse entities"), { status: 400 });
    return { message_id: 17 } as unknown as T;
  };
  const ids = await sendTelegramMessage(request, "token", 42, {
    text: "**fallback**",
    format: "markdown",
    replyToMessageId: 10,
    replyMarkup: { inline_keyboard: [[{ text: "Remove", callback_data: "remove" }]] },
  }, new AbortController().signal);
  assert.deepEqual(ids, [17]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.parse_mode, "HTML");
  assert.equal(calls[1].body.text, "**fallback**");
  assert.equal(calls[1].body.reply_parameters && (calls[1].body.reply_parameters as { message_id: number }).message_id, 10);
  assert.deepEqual(calls[1].body.reply_markup, { inline_keyboard: [[{ text: "Remove", callback_data: "remove" }]] });
});

test("a parse error falls back only for the failed chunk, without replaying sent chunks", async () => {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const request: TelegramRequester = async <T,>(_token, _method, body): Promise<T> => {
    const index = calls.push({ body }) - 1;
    if (index === 1) throw Object.assign(new Error("Bad Request: can't parse entities"), { status: 400 });
    return { message_id: index + 1 } as unknown as T;
  };
  const ids = await sendTelegramMessage(request, "token", 42, {
    text: `${"a".repeat(3500)}**bad**`,
    format: "markdown",
  }, new AbortController().signal);
  assert.deepEqual(ids, [1, 3]);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].body.text, "**bad**");
  assert.equal(calls[2].body.parse_mode, undefined);
});

test("transient send failures do not trigger plain-text retries", async () => {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const request: TelegramRequester = async <T,>(_token, _method, body): Promise<T> => {
    calls.push({ body });
    if (calls.length === 2) throw new Error("socket hang up");
    return { message_id: 1 } as unknown as T;
  };
  await assert.rejects(sendTelegramMessage(request, "token", 42, {
    text: `${"a".repeat(3500)}**bad**`,
    format: "markdown",
  }, new AbortController().signal), /socket hang up/);
  assert.equal(calls.length, 2);
});
