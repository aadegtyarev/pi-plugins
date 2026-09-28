import assert from "node:assert/strict";
import test from "node:test";
import { AgentBoardPublisher, type AgentBoardTransport, BackgroundAgentBatch } from "./agent-board.ts";
import { getTelegramCommandMenu, normalizeTelegramCommand, TELEGRAM_COMMAND_DEFINITIONS, telegramHelpText } from "./commands.ts";
import { TelegramCommandRegistry } from "./command-registry.ts";
import { finalizeQueueNotice, formatQueueListing, MAX_QUEUED_TASKS, parseQueueCancelId, TelegramTaskQueue } from "./queue.ts";
import { renderTelegramMessage, sendTelegramMessage, type TelegramRequester } from "./message-renderer.ts";
import telegramExtension from "./index.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

test("agent board edits one pinned batch, keeps its final message, and starts fresh next time", async () => {
  const publisher = new AgentBoardPublisher();
  const calls: string[] = [];
  const messages = new Map<number, string>();
  let nextMessageId = 10;
  let pinnedMessageId: number | undefined = 7;
  const transport: AgentBoardTransport = {
    findPinnedBoard: async () => { calls.push("find"); return pinnedMessageId; },
    sendBoard: async (_chatId, text) => {
      const id = nextMessageId++;
      messages.set(id, text);
      calls.push(`send:${id}`);
      return id;
    },
    editBoard: async (_chatId, id, text) => { messages.set(id, text); calls.push(`edit:${id}:${text}`); },
    pinBoard: async (_chatId, id) => { pinnedMessageId = id; calls.push(`pin:${id}`); },
    unpinBoard: async (_chatId, id) => {
      if (pinnedMessageId === id) pinnedMessageId = undefined;
      calls.push(`unpin:${id}`);
    },
  };
  const signal = new AbortController().signal;

  await publisher.refresh(1, "batch 1 running", true, signal, transport);
  await publisher.refresh(1, "batch 1 partly done", true, signal, transport);
  await publisher.refresh(1, "batch 1 complete", false, signal, transport);
  assert.equal(publisher.hasMessage(), false);
  assert.equal(pinnedMessageId, undefined);
  assert.equal(messages.get(10), "batch 1 complete");

  publisher.beginBatch();
  await publisher.refresh(1, "batch 2 running", true, signal, transport);
  assert.deepEqual(calls, [
    "find", "unpin:7", "send:10", "pin:10",
    "edit:10:batch 1 partly done", "edit:10:batch 1 complete", "unpin:10",
    "find", "send:11", "pin:11",
  ]);
  assert.equal(messages.get(10), "batch 1 complete");
  assert.equal(pinnedMessageId, 11);
});

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

test("failed notice deletion leaves an inert final status after a successful reaction", async () => {
  const calls: string[] = [];
  await finalizeQueueNotice({
    signal: new AbortController().signal,
    react: async () => { calls.push("react"); },
    deleteNotice: async () => { calls.push("delete"); return false; },
    editNotice: async () => { calls.push("edit"); },
  });
  assert.deepEqual(calls, ["react", "delete", "edit"]);
});

test("rejected reaction falls back to editing the notice", async () => {
  const calls: string[] = [];
  await finalizeQueueNotice({
    signal: new AbortController().signal,
    react: async () => { calls.push("react"); throw new Error("reactions unavailable"); },
    deleteNotice: async () => { calls.push("delete"); return true; },
    editNotice: async () => { calls.push("edit"); },
  });
  assert.deepEqual(calls, ["react", "edit"]);
});

test("successful reaction and notice deletion do not edit a completed notice", async () => {
  const calls: string[] = [];
  await finalizeQueueNotice({
    signal: new AbortController().signal,
    react: async () => { calls.push("react"); },
    deleteNotice: async () => { calls.push("delete"); return true; },
    editNotice: async () => { calls.push("edit"); },
  });
  assert.deepEqual(calls, ["react", "delete"]);
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

test("queue listing uses real line breaks and cancel accepts trailing arguments", () => {
  const text = formatQueueListing([{ id: "q1", chatId: 1, text: "first\n  second" }]);
  assert.equal(text, "В вашей очереди 1 задач:\n• ID `q1`: first second\n\nУдалить: /queue_cancel <ID>");
  assert.equal(parseQueueCancelId("q1 extra args"), "q1");
  assert.equal(parseQueueCancelId("  \n"), undefined);
});

test("queue enforces its shared capacity", () => {
  const queue = new TelegramTaskQueue();
  const tasks = Array.from({ length: MAX_QUEUED_TASKS }, (_, index) => queue.enqueue(1, String(index))!);
  assert.equal(queue.length, MAX_QUEUED_TASKS);
  assert.equal(queue.enqueue(1, "overflow"), undefined);
  assert.equal(queue.takeNext(), tasks[0]);
});

test("command registry dispatches aliases to one canonical handler", async () => {
  const registry = new TelegramCommandRegistry<{ calls: string[] }>();
  registry.register("start", async ({ calls }, args) => { calls.push(`start:${args}`); });
  const context = { calls: [] as string[] };
  assert.equal(await registry.dispatch("help", "extra", context), true);
  assert.equal(await registry.dispatch("unknown", "", context), false);
  assert.deepEqual(context.calls, ["start:extra"]);
});

test("registry passes session context and arguments to migrated session command handlers", async () => {
  const commands = ["status", "model", "effort", "compact", "new", "reload", "bash", "cancel"];
  const registry = new TelegramCommandRegistry<{ chatId: number; signal: AbortSignal; ctx: { sessionId: string } }>();
  const calls: string[] = [];
  for (const command of commands) {
    registry.register(command, async ({ chatId, signal, ctx }, args) => {
      assert.equal(chatId, 42);
      assert.equal(signal, context.signal);
      assert.equal(ctx, context.ctx);
      calls.push(`${command}:${args}`);
    });
  }
  const context = { chatId: 42, signal: new AbortController().signal, ctx: { sessionId: "current-session" } };

  for (const command of commands) {
    assert.equal(await registry.dispatch(command, "argument", context), true);
  }
  assert.deepEqual(calls, commands.map((command) => `${command}:argument`));
});

test("Telegram polling dispatches migrated session commands with the current ExtensionContext", async () => {
  const previousToken = process.env.PI_TELEGRAM_BOT_TOKEN;
  const previousAllowedIds = process.env.PI_TELEGRAM_ALLOWED_USER_IDS;
  const previousEnabled = process.env.PI_TELEGRAM_ENABLED;
  const previousFetch = globalThis.fetch;
  process.env.PI_TELEGRAM_BOT_TOKEN = "test-token";
  process.env.PI_TELEGRAM_ALLOWED_USER_IDS = "7";
  process.env.PI_TELEGRAM_ENABLED = "1";

  const commands = ["/status", "/model", "/effort", "/compact", "/new", "/reload", "/bash echo test", "/cancel"];
  const sent: string[] = [];
  let deliveredUpdates = false;
  let messageId = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = url.pathname.split("/").at(-1);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    let result: unknown;
    if (method === "getUpdates" && body.offset === -1) {
      result = [];
    } else if (method === "getUpdates" && !deliveredUpdates) {
      deliveredUpdates = true;
      result = commands.map((text, index) => ({
        update_id: index + 1,
        message: { message_id: index + 1, from: { id: 7 }, chat: { id: 42, type: "private" }, text },
      }));
    } else if (method === "getUpdates") {
      const signal = init?.signal;
      await new Promise<never>((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    } else if (method === "sendMessage") {
      sent.push(String(body.text));
      result = { message_id: ++messageId };
    } else if (method === "getMe") {
      result = { id: 1, is_bot: true, first_name: "test", username: "test_bot" };
    } else {
      result = true;
    }
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const events = new Map<string, (...args: any[]) => unknown>();
  const pi = {
    registerFlag() {},
    registerCommand() {},
    registerTool() {},
    on(event: string, handler: (...args: any[]) => unknown) { events.set(event, handler); },
    events: { on() {} },
    getFlag: () => false,
    getThinkingLevel: () => "medium",
    sendUserMessage() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(),
    model: { provider: "test-provider", id: "test-model" },
    modelRegistry: { getAvailable: () => [] },
    isIdle: () => false,
    abort() {},
    getContextUsage: () => null,
    sessionManager: {
      getEntries: () => [],
      getSessionName: () => undefined,
      getSessionFile: () => undefined,
      getSessionId: () => "test-session",
    },
  } as unknown as ExtensionContext;

  try {
    telegramExtension(pi);
    await events.get("session_start")?.({}, ctx);
    const deadline = Date.now() + 3000;
    while (sent.length < commands.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(sent.length, commands.length, `Expected one response for each command; got: ${sent.join(" | ")}`);
    assert.match(sent[0], /Модель: test-provider\/test-model/);
    assert.match(sent[1], /Нет доступных моделей/);
    assert.match(sent[2], /Текущий effort: medium/);
    assert.match(sent[3], /Сжать контекст можно после завершения/);
    assert.match(sent[4], /Начать новую сессию можно после завершения/);
    assert.match(sent[5], /Перед перезагрузкой дождитесь завершения/);
    assert.match(sent[6], /Pi занят\. Выполнить Bash/);
    assert.match(sent[7], /Останавливаю текущую задачу/);
    assert.ok(sent.every((text) => !text.includes("Неизвестная команда")));
  } finally {
    await events.get("session_shutdown")?.();
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.PI_TELEGRAM_BOT_TOKEN;
    else process.env.PI_TELEGRAM_BOT_TOKEN = previousToken;
    if (previousAllowedIds === undefined) delete process.env.PI_TELEGRAM_ALLOWED_USER_IDS;
    else process.env.PI_TELEGRAM_ALLOWED_USER_IDS = previousAllowedIds;
    if (previousEnabled === undefined) delete process.env.PI_TELEGRAM_ENABLED;
    else process.env.PI_TELEGRAM_ENABLED = previousEnabled;
  }
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
