import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { installBackgroundAdapters } from "./background-adapters/index.ts";
import type { BackgroundWorkEvent } from "./background-adapters/types.ts";
import { AgentBoardPublisher, BackgroundAgentBatch } from "./agent-board.ts";
import { TelegramCommandRegistry } from "./command-registry.ts";
import { getTelegramCommandMenu, isPluginTelegramCommand, normalizeTelegramCommand, telegramHelpText } from "./commands.ts";
import { finalizeQueueNotice, formatQueueListing, MAX_QUEUED_TASKS, parseQueueCancelId, reactionForQueueTask, TelegramTaskQueue, type QueueTaskFinalState, type QueuedTelegramTask } from "./queue.ts";
import { editTelegramMessage, escapeHtml, MAX_TELEGRAM_MESSAGE_LENGTH as MAX_MESSAGE_LENGTH, sendTelegramMessage } from "./message-renderer.ts";

const TELEGRAM_API = "https://api.telegram.org";
const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type EffortLevel = (typeof EFFORT_LEVELS)[number];

interface TelegramUser {
  id: number;
}

interface TelegramChat {
  id: number;
  type: string;
  pinned_message?: { message_id: number; text?: string };
}

interface TelegramFile {
  file_id: string;
  file_name?: string;
}

interface TelegramMessage {
  message_id?: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  document?: TelegramFile;
  photo?: TelegramFile[];
  caption?: string;
  media_group_id?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: TelegramUser;
    data?: string;
    message?: { message_id: number; chat: TelegramChat };
  };
}

interface TelegramResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

async function telegramRequest<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const data = (await response.json()) as TelegramResponse<T>;
  if (!response.ok || !data.ok) {
    const error = new Error(data.description ?? `Telegram API error (${response.status})`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return data.result;
}

async function deleteTelegramMessage(
  token: string,
  chatId: number,
  messageId: number,
  signal: AbortSignal,
): Promise<void> {
  await telegramRequest<unknown>(
    token,
    "deleteMessage",
    { chat_id: chatId, message_id: messageId },
    signal,
  );
}

function compactTaskPreview(task: string): string {
  let preview = task.replace(/\s+/g, " ").trim();
  preview = preview.replace(/\/(?:home|tmp|workspace|mnt|Users)\/[^\s,;)]*/g, "project files");
  preview = preview.replace(/\s+(?:in|at) project files\b/gi, "");
  preview = preview.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]");
  preview = preview.replace(/\b(?:api[_-]?key|token|password|secret|authorization)(\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]");
  preview = preview.replace(/\b(?:sk|ghp|github_pat|xox[baprs])-[A-Za-z0-9_-]{12,}\b/g, "[redacted]");
  preview = preview.replace(/^review\s+(?:the\s+)?/i, "Review: ")
    .replace(/^implement\s+/i, "Implementation: ")
    .replace(/^(?:check|inspect|verify)\s+/i, "Check: ")
    .replace(/^test\s+/i, "Test: ")
    .replace(/^research\s+/i, "Research: ");
  preview = preview.split(/(?<=[.!?])\s/, 1)[0].replace(/[,:;\s]+$/, "");
  return preview.slice(0, 82) + (preview.length > 82 ? "…" : "");
}

function countEditLines(oldText: string, newText: string): { added: number; removed: number } {
  const lines = (text: string) => {
    const result = text.replace(/\r\n/g, "\n").split("\n");
    if (result.length > 1 && result[result.length - 1] === "") result.pop();
    return result;
  };
  const oldLines = lines(oldText);
  const newLines = lines(newText);
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > 1_000_000) {
    let prefix = 0;
    while (prefix < n && prefix < m && oldLines[prefix] === newLines[prefix]) prefix++;
    let suffix = 0;
    while (suffix < n - prefix && suffix < m - prefix && oldLines[n - 1 - suffix] === newLines[m - 1 - suffix]) suffix++;
    return { added: m - prefix - suffix, removed: n - prefix - suffix };
  }
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = oldLines[i] === newLines[j]
        ? lcs[(i + 1) * width + j + 1] + 1
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) { i++; j++; }
    else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) { removed++; i++; }
    else { added++; j++; }
  }
  return { added: added + m - j, removed: removed + n - i };
}

function toolInputSummary(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return name;
  const args = input as Record<string, unknown>;
  const preview = (value: unknown, maxLength: number): string => {
    if (typeof value !== "string") return "";
    const text = value.replace(/\s+/g, " ").trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
  };
  const urlPreview = (value: unknown): string => {
    const raw = preview(value, 240);
    if (!raw) return "";
    try {
      const url = new URL(raw);
      return `${url.host}${url.pathname}` || raw;
    } catch {
      return raw;
    }
  };
  const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "";
  if (name === "edit") {
    const oldText = typeof args.oldText === "string" ? args.oldText : "";
    const newText = typeof args.newText === "string" ? args.newText : "";
    const { added, removed } = countEditLines(oldText, newText);
    return `✏️ Edit: ${path || "file"} +${added} / -${removed}`;
  }
  if (name === "subagent") {
    const agent = typeof args.agent === "string" ? args.agent : typeof args.workflow === "string" ? `workflow:${args.workflow}` : "workflow";
    const task = typeof args.task === "string" ? compactTaskPreview(args.task) : "";
    const model = typeof args.model === "string" ? args.model : "";
    return `🤖 subagent · ${agent}${task ? ` · ${task}` : ""}${model ? ` · ${model}` : ""}`;
  }
  const rangeStart = typeof args.start_line === "number"
    ? args.start_line
    : typeof args.offset === "number" ? args.offset : typeof args.limit === "number" ? 1 : undefined;
  const rangeEnd = typeof args.end_line === "number"
    ? args.end_line
    : typeof rangeStart === "number" && typeof args.limit === "number"
      ? rangeStart + Math.max(1, args.limit) - 1
      : undefined;
  const range = rangeStart === undefined ? "" : rangeEnd === undefined ? `${rangeStart}+` : `${rangeStart}–${rangeEnd}`;
  if (["read", "edit", "write"].includes(name)) {
    const operation = name === "read" ? "📖 Read" : name === "edit" ? "✏️ Edit" : "📝 Write";
    return `${operation}: ${path || "file"}${range ? ` (lines ${range})` : ""}`;
  }
  if (name === "bash") return `\n\`\`\`bash\n${String(args.command ?? "bash").slice(0, 180)}\n\`\`\``;
  if (name === "grep" || name === "find") return `🔎 ${name}: ${String(args.pattern ?? args.query ?? "").slice(0, 120)}${path ? ` — ${path}` : ""}`;
  if (name === "web_search") {
    const queries = Array.isArray(args.queries) ? args.queries.filter((query): query is string => typeof query === "string") : [];
    const query = queries.length ? queries.slice(0, 2).map((item) => preview(item, 130)).join(" · ") : preview(args.query, 180);
    const extra = queries.length > 2 ? ` (+${queries.length - 2})` : "";
    return `🌐 Search: ${query || "query unavailable"}${extra}`;
  }
  if (name === "fetch_content" || name === "web_fetch") {
    const urls = Array.isArray(args.urls) ? args.urls.filter((url): url is string => typeof url === "string") : [];
    const url = urls.length ? urls.slice(0, 2).map(urlPreview).join(" · ") : urlPreview(args.url);
    const extra = urls.length > 2 ? ` (+${urls.length - 2})` : "";
    return `🔗 Fetch: ${url || "URL unavailable"}${extra}`;
  }
  if (name === "source_check") return `🧾 Source check: ${preview(args.claim, 180) || "claim unavailable"}`;
  if (name === "get_search_content") {
    const target = args.url ? urlPreview(args.url) : preview(args.query ?? args.findText, 140);
    return `📚 Retrieve: ${target || `response ${preview(args.responseId, 24)}`}`;
  }
  return name;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

function splitAllowedIds(value: string | undefined): Set<number> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  );
}

function assistantText(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text!)
    .join("")
    .trim();
}

function availableEfforts(model: ExtensionContext["model"]): EffortLevel[] {
  if (!model?.reasoning) return ["off"];
  return EFFORT_LEVELS.filter((level) => {
    const mappedLevel = model.thinkingLevelMap?.[level];
    if (mappedLevel === null) return false;
    if (level === "xhigh" || level === "max") return mappedLevel !== undefined;
    return true;
  });
}

function compactTokens(value: number): string {
  const tokens = Math.max(0, Math.round(value));
  if (tokens < 1000) return String(tokens);
  if (tokens < 10_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${Math.round(tokens / 1000)}k`;
}

function contextUsageText(ctx: ExtensionContext): string {
  const usage = ctx.getContextUsage();
  if (!usage) return "Context: no data yet.";

  const format = compactTokens;
  const window = format(usage.contextWindow);
  if (usage.tokens === null) return `Context: unknown / ${window} tokens.`;

  const tokens = Math.max(0, usage.tokens);
  const percent = usage.percent === null ? "" : ` (${usage.percent.toFixed(1)}%)`;
  const remaining = format(usage.contextWindow - tokens);
  return `Context: ~${format(tokens)} / ${window} tokens${percent}; ~${remaining} remaining.`;
}

function sessionReportText(ctx: ExtensionContext): string {
  let users = 0;
  let assistants = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let totalMessages = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  const addUsage = (usage: any) => {
    if (!usage) return;
    input += usage.input ?? 0;
    output += usage.output ?? 0;
    cacheRead += usage.cacheRead ?? 0;
    cacheWrite += usage.cacheWrite ?? 0;
    cost += usage.cost?.total ?? 0;
  };

  for (const rawEntry of ctx.sessionManager.getEntries()) {
    const entry = rawEntry as any;
    if (entry.type === "usage" || ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage)) {
      addUsage(entry.usage);
    }
    if (entry.type !== "message") continue;
    totalMessages++;
    const message = entry.message;
    if (message.role === "user") users++;
    else if (message.role === "assistant") {
      assistants++;
      if (Array.isArray(message.content)) toolCalls += message.content.filter((part: any) => part.type === "toolCall").length;
      addUsage(message.usage);
    } else if (message.role === "toolResult") {
      toolResults++;
      addUsage(message.usage);
    }
  }

  const promptTokens = input + cacheRead + cacheWrite;
  const totalTokens = promptTokens + output;
  const cacheRate = promptTokens > 0 ? ` (${((cacheRead / promptTokens) * 100).toFixed(1)}%)` : "";
  const sessionName = ctx.sessionManager.getSessionName();
  const lines = [
    ...(sessionName ? [`Session: ${sessionName}`] : []),
    `File: ${ctx.sessionManager.getSessionFile() ?? "in-memory"}`,
    `ID: ${ctx.sessionManager.getSessionId()}`,
    `Messages: ${totalMessages} total · ${users} user · ${assistants} assistant · tools: ${toolCalls} calls, ${toolResults} results`,
    `Tokens: ${promptTokens.toLocaleString()} input · ${cacheRead.toLocaleString()} cached${cacheRate} · ${(input + cacheWrite).toLocaleString()} uncached · ${output.toLocaleString()} output · ${totalTokens.toLocaleString()} total`,
    `Cost: $${cost.toFixed(3)}`,
  ];
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  let controller: AbortController | undefined;
  let pollTask: Promise<void> | undefined;
  let currentContext: ExtensionContext | undefined;
  let botToken: string | undefined;
  let activeChatId: number | undefined;
  let lastTelegramChatId: number | undefined;
  let activeBashChatId: number | undefined;
  let activeCompactChatId: number | undefined;
  let pendingNewChatId: number | undefined;
  let bashController: AbortController | undefined;
  let cancelRequested = false;
  const queuedTasks = new TelegramTaskQueue();
  let drainingQueue = false;
  let lastAssistantText = "";
  const activityMessageIds: number[] = [];
  const activityTexts: string[] = [];
  let activityChatId: number | undefined;
  let currentThinking = "";
  let currentThinkingEntry: { type: "thinking"; text: string } | undefined;
  const activityOrder: Array<{ type: "tool"; id: string } | { type: "thinking"; text: string }> = [];
  let activityWorking = false;
  let activityInputTokens = 0;
  let activityOutputTokens = 0;
  let activityCacheRead = 0;
  let activityCacheWrite = 0;
  let activityCacheHitRate: number | undefined;
  let activityCost = 0;
  let activityQueue: Promise<void> = Promise.resolve();
  let agentBoardQueue: Promise<void> = Promise.resolve();
  let agentBoardRefreshTimer: ReturnType<typeof setInterval> | undefined;
  let agentBoardPolling = false;
  const agentBoardPublisher = new AgentBoardPublisher();
  const backgroundAgents = new BackgroundAgentBatch();
  const backgroundAgentLaunches = new Map<string, { chatId: number; agent: string }>();
  const toolCalls = new Map<string, { summary: string; status: "running" | "done" | "failed"; exitLabel?: string }>();

  pi.registerFlag("telegram", {
    description: "Enable the Telegram bridge for this Pi session",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("telegram", {
    description: "Turn the Telegram bridge on or off",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action !== "on" && action !== "off") {
        tellPi(ctx, "Usage: /telegram on|off");
        return;
      }
      if (action === "on") {
        if (await startTelegram(ctx)) tellPi(ctx, "Telegram bot enabled.");
        return;
      }
      await stopTelegram();
      tellPi(ctx, "Telegram bot disabled.");
    },
  });

  pi.registerCommand("telegram-reload", {
    description: "Reload Pi extensions and resources from Telegram",
    handler: async (_args, ctx) => {
      await ctx.reload();
      if (botToken && controller && !controller.signal.aborted) {
        try {
          await telegramRequest<true>(botToken, "setMyCommands", { commands: getTelegramCommandMenu(pi.getCommands()) }, controller.signal);
        } catch (error) {
          console.error("[pi-ad-telegram] Failed to refresh Telegram commands after reload:", error);
        }
      }
    },
  });

  pi.registerTool(defineTool({
    name: "telegram_send_file",
    label: "Send Telegram file",
    description: "Send a file from the current project to the connected Telegram chat when the user asks for it.",
    parameters: Type.Object({ path: Type.String({ description: "File path, relative to the project or absolute" }) }),
    async execute(_id, { path }, signal, _onUpdate, ctx) {
      const chatId = activeChatId;
      if (chatId === undefined || !botToken) throw new Error("No active Telegram chat");
      const filePath = resolve(ctx.cwd, path);
      const data = await readFile(filePath);
      const form = new FormData();
      form.append("chat_id", String(chatId));
      form.append("document", new Blob([data]), basename(filePath));
      const response = await fetch(`${TELEGRAM_API}/bot${botToken}/sendDocument`, { method: "POST", body: form, signal });
      const result = (await response.json()) as TelegramResponse<unknown>;
      if (!response.ok || !result.ok) throw new Error(result.description ?? "Telegram upload failed");
      return { content: [{ type: "text", text: `Sent ${basename(filePath)} to Telegram.` }], details: undefined };
    },
  }));

  pi.registerCommand("telegram-new", {
    description: "Start a new Pi session from Telegram",
    handler: async (_args, ctx) => {
      const chatId = pendingNewChatId;
      try {
        const result = await ctx.newSession({
          withSession: async () => {
            if (chatId === undefined) return;
            pendingNewChatId = undefined;
            if (controller) await reply(chatId, "A new Pi session has been created.", controller.signal);
          },
        });
        if (result.cancelled && chatId !== undefined) {
          pendingNewChatId = undefined;
          if (controller) await reply(chatId, "Creating a new session was cancelled.", controller.signal);
        }
      } catch (error) {
        pendingNewChatId = undefined;
        if (chatId !== undefined && controller) {
          await reply(chatId, `Failed to create a session: ${String(error)}`, controller.signal);
        }
      } finally {
        void drainQueuedTasks();
      }
    },
  });

  function tellPi(ctx: ExtensionContext, text: string): void {
    if (ctx.hasUI) ctx.ui.notify(text, "warning");
    else console.error(`[pi-ad-telegram] ${text}`);
  }

  async function reply(chatId: number, text: string, signal: AbortSignal, formatMarkdown = false): Promise<void> {
    if (!botToken) return;
    try {
      await sendTelegramMessage(telegramRequest, botToken, chatId, { text, format: formatMarkdown ? "markdown" : "plain" }, signal);
    } catch (error) {
      if (!signal.aborted) console.error("[pi-ad-telegram] Failed to send Telegram message:", error);
    }
  }

  async function sendQueuedTask(chatId: number, task: QueuedTelegramTask, signal: AbortSignal): Promise<void> {
    if (!botToken) return;
    const [messageId] = await sendTelegramMessage(telegramRequest, botToken, chatId, {
      text: `✅ Added to the queue · ID ${task.id}\nView: /queue · remove: /queue_cancel ${task.id}`,
      replyToMessageId: task.replyToMessageId,
      replyMarkup: { inline_keyboard: [[{ text: "Remove from queue", callback_data: `queue-remove:${task.id}` }]] },
    }, signal);
    task.noticeMessageId = messageId;
  }

  async function deleteQueueNotice(task: QueuedTelegramTask, signal: AbortSignal): Promise<boolean> {
    if (!botToken || task.noticeMessageId === undefined) return true;
    try {
      await deleteTelegramMessage(botToken, task.chatId, task.noticeMessageId, signal);
      return true;
    } catch (error) {
      if (!signal.aborted) console.error("[pi-ad-telegram] Failed to remove queued-task notice:", error);
      return false;
    }
  }

  async function closeQueuedTask(task: QueuedTelegramTask, state: QueueTaskFinalState, emoji: "✅" | "❌", signal: AbortSignal): Promise<void> {
    if (!botToken) return;
    await finalizeQueueNotice({
      signal,
      ...(task.replyToMessageId !== undefined ? {
        react: () => telegramRequest<unknown>(botToken!, "setMessageReaction", {
          chat_id: task.chatId,
          message_id: task.replyToMessageId,
          reaction: [{ type: "emoji", emoji: reactionForQueueTask(state) }],
          is_big: false,
        }, signal),
      } : {}),
      deleteNotice: () => deleteQueueNotice(task, signal),
      editNotice: async () => {
        if (task.noticeMessageId === undefined) return;
        await editTelegramMessage(telegramRequest, botToken!, task.chatId, task.noticeMessageId, {
          text: `${emoji} Task ${task.id} ${state}.`,
          replyMarkup: { inline_keyboard: [] },
        }, signal);
      },
      onError: (stage, error) => {
        if (signal.aborted) return;
        if (stage === "reaction" && error instanceof Error && error.message.includes("REACTION_INVALID")) {
          console.warn("[pi-ad-telegram] Telegram rejected the queue reaction; falling back to editing the queue notice.");
          return;
        }
        console.error(`[pi-ad-telegram] Failed to finalize queue task (${stage}):`, error);
      },
    });
  }

  const commandRegistry = new TelegramCommandRegistry<{ chatId: number; signal: AbortSignal; ctx: ExtensionContext | undefined }>();
  commandRegistry.register("start", async ({ chatId, signal }) => {
    await reply(chatId, telegramHelpText(pi.getCommands()), signal);
  });
  commandRegistry.register("queue", async ({ chatId, signal }) => {
    await reply(chatId, formatQueueListing(queuedTasks.listForChat(chatId)), signal, true);
  });
  commandRegistry.register("queue_cancel", async ({ chatId, signal }, args) => {
    const id = parseQueueCancelId(args);
    const removed = id ? queuedTasks.remove(id, chatId) : undefined;
    if (!removed) await reply(chatId, "That task was not found in your queue. See IDs with /queue.", signal);
    else await closeQueuedTask(removed, "cancelled", "❌", signal);
  });
  commandRegistry.register("clear_queue", async ({ chatId, signal }) => {
    const chatTasks = queuedTasks.removeAllForChat(chatId);
    for (const task of chatTasks) await closeQueuedTask(task, "cancelled", "❌", signal);
    await reply(chatId, `Queue cleared; removed ${chatTasks.length} task(s).`, signal);
  });
  commandRegistry.register("agents", async ({ chatId, signal }) => {
    if (!backgroundAgents.hasRunning()) {
      await reply(chatId, "There are no active background agents. Completed boards remain in the chat as regular messages.", signal);
      return;
    }
    if (activeChatId !== undefined && controller) await refreshAgentBoard(chatId, controller.signal);
    else await refreshAgentBoard(chatId, signal);
    await reply(chatId, "The active group status was refreshed on the pinned board. When all agents finish, the board will be unpinned and remain in the chat.", signal);
  });

  const isSessionBusy = (ctx: ExtensionContext): boolean =>
    !ctx.isIdle() || activeChatId !== undefined || activeBashChatId !== undefined || activeCompactChatId !== undefined || pendingNewChatId !== undefined;

  commandRegistry.register("status", async ({ chatId, signal, ctx }) => {
    if (!ctx) {
      await reply(chatId, "The Pi session is not ready yet.", signal);
      return;
    }
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "not selected";
    await reply(chatId,
      `Pi is ${isSessionBusy(ctx) ? "busy" : "idle and waiting for a task"}.\nModel: ${model}\nEffort: ${pi.getThinkingLevel()}\n${contextUsageText(ctx)}\n\n${sessionReportText(ctx)}`,
      signal,
    );
  });

  commandRegistry.register("model", async ({ chatId, signal, ctx }, args) => {
    if (!ctx) {
      await reply(chatId, "The Pi session is not ready yet.", signal);
      return;
    }
    const models = [...ctx.modelRegistry.getAvailable()].sort((a, b) =>
      `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`),
    );
    if (!args) {
      if (models.length === 0) {
        await reply(chatId, "No models are available. Check your Pi authentication settings.", signal);
        return;
      }
      const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const shown = models.slice(0, 50).map((model) => {
        const id = `${model.provider}/${model.id}`;
        return `${id === current ? "✓ " : ""}${id} — ${model.name}`;
      });
      const more = models.length > shown.length
        ? `\n… and ${models.length - shown.length} more. Select a model using its full provider/model-id.`
        : "";
      await reply(chatId, `Available models (${models.length}):\n${shown.join("\n")}${more}\n\nSelect: /model provider/model-id`, signal);
      return;
    }
    if (isSessionBusy(ctx)) {
      await reply(chatId, "You can change the model after the current task finishes.", signal);
      return;
    }
    const normalized = args.toLowerCase();
    const matches = models.filter((model) =>
      `${model.provider}/${model.id}`.toLowerCase() === normalized ||
      model.id.toLowerCase() === normalized || model.name.toLowerCase() === normalized,
    );
    if (matches.length === 0) {
      await reply(chatId, `Model “${args}” was not found. Send /model to see the available models.`, signal);
      return;
    }
    if (matches.length > 1) {
      await reply(chatId, `The name is ambiguous. Specify provider/model-id:\n${matches.map((model) => `${model.provider}/${model.id}`).join("\n")}`, signal);
      return;
    }
    const selected = matches[0];
    try {
      if (!(await pi.setModel(selected))) {
        await reply(chatId, `Could not select ${selected.provider}/${selected.id}: provider authentication is unavailable.`, signal);
        return;
      }
      await reply(chatId, `Model selected: ${selected.provider}/${selected.id}\nEffort: ${pi.getThinkingLevel()}`, signal);
    } catch (error) {
      await reply(chatId, `Could not select the model: ${String(error)}`, signal);
    }
  });

  commandRegistry.register("effort", async ({ chatId, signal, ctx }, args) => {
    if (!ctx) {
      await reply(chatId, "The Pi session is not ready yet.", signal);
      return;
    }
    const levels = availableEfforts(ctx.model);
    if (!args) {
      await reply(chatId, `Current effort: ${pi.getThinkingLevel()}\nAvailable: ${levels.join(", ")}\nSet: /effort <level>`, signal);
      return;
    }
    if (isSessionBusy(ctx)) {
      await reply(chatId, "You can change effort after the current task finishes.", signal);
      return;
    }
    const effort = args.toLowerCase();
    if (!(EFFORT_LEVELS as readonly string[]).includes(effort)) {
      await reply(chatId, `Unknown effort level. Available: ${levels.join(", ")}.`, signal);
      return;
    }
    if (!levels.includes(effort as EffortLevel)) {
      await reply(chatId, `Effort “${effort}” is not supported by this model. Available: ${levels.join(", ")}.`, signal);
      return;
    }
    pi.setThinkingLevel(effort as EffortLevel);
    await reply(chatId, `Effort set to ${pi.getThinkingLevel()}.`, signal);
  });

  commandRegistry.register("compact", async ({ chatId, signal, ctx }, args) => {
    if (!ctx) {
      await reply(chatId, "The Pi session is not ready yet.", signal);
      return;
    }
    if (isSessionBusy(ctx)) {
      await reply(chatId, "Context can be compacted after the current task finishes.", signal);
      return;
    }
    activeCompactChatId = chatId;
    await reply(chatId, "Compacting context…", signal);
    if (signal.aborted) {
      activeCompactChatId = undefined;
      return;
    }
    try {
      ctx.compact({
        ...(args ? { customInstructions: args } : {}),
        onComplete: () => {
          if (activeCompactChatId !== chatId) return;
          activeCompactChatId = undefined;
          if (controller) void reply(chatId, "Context compaction complete.", controller.signal);
          void drainQueuedTasks();
        },
        onError: (error) => {
          if (activeCompactChatId !== chatId) return;
          activeCompactChatId = undefined;
          if (controller) void reply(chatId, `Failed to compact context: ${error.message}`, controller.signal);
          void drainQueuedTasks();
        },
      });
    } catch (error) {
      activeCompactChatId = undefined;
      await reply(chatId, `Could not start compaction: ${String(error)}`, signal);
    }
  });

  commandRegistry.register("new", async ({ chatId, signal, ctx }, args) => {
    if (!ctx) {
      await reply(chatId, "The Pi session is not ready yet.", signal);
      return;
    }
    if (args) {
      await reply(chatId, "Usage: /new", signal);
      return;
    }
    if (isSessionBusy(ctx)) {
      await reply(chatId, "A new session can be started after the current task finishes.", signal);
      return;
    }
    pendingNewChatId = chatId;
    await reply(chatId, "Creating a new Pi session…", signal);
    if (!signal.aborted) pi.sendUserMessage("/telegram-new", { expandPromptTemplates: true });
    else pendingNewChatId = undefined;
  });

  commandRegistry.register("reload", async ({ chatId, signal, ctx }) => {
    if (!ctx) {
      await reply(chatId, "The Pi session is not ready yet.", signal);
      return;
    }
    if (isSessionBusy(ctx)) {
      await reply(chatId, "Wait for the current task to finish before reloading.", signal);
      return;
    }
    await reply(chatId, "Reloading Pi extensions and resources…", signal);
    pi.sendUserMessage("/telegram-reload", { expandPromptTemplates: true });
  });

  commandRegistry.register("bash", async ({ chatId, signal, ctx }, args) => {
    if (!ctx) {
      await reply(chatId, "The Pi session is not ready yet.", signal);
      return;
    }
    if (!args) {
      await reply(chatId, "Specify a command: /bash <command>", signal);
      return;
    }
    if (isSessionBusy(ctx)) {
      await reply(chatId, "Pi is busy. Bash can run after the current task finishes.", signal);
      return;
    }
    const taskController = new AbortController();
    bashController = taskController;
    activeBashChatId = chatId;
    await reply(chatId, "Running Bash command…", signal);
    if (!signal.aborted) void runBashCommand(chatId, args, ctx.cwd, signal, taskController);
    else taskController.abort();
  });

  commandRegistry.register("cancel", async ({ chatId, signal, ctx }) => {
    if (bashController && activeBashChatId !== undefined) {
      bashController.abort();
      await reply(chatId, "Stopping the Bash command…", signal);
    } else if (activeCompactChatId !== undefined) {
      await reply(chatId, "Context is being compacted; please wait.", signal);
    } else if (!ctx || ctx.isIdle()) {
      await reply(chatId, "There is no active task.", signal);
    } else {
      cancelRequested = true;
      ctx.abort();
      await reply(chatId, "Stopping the current task…", signal);
    }
  });

  async function handleQueueCallback(update: TelegramUpdate, signal: AbortSignal): Promise<void> {
    const query = update.callback_query;
    if (!query) return;
    const chatId = query.message?.chat.id;
    const messageId = query.message?.message_id;
    const allowed = query.message?.chat.type === "private" && splitAllowedIds(process.env.PI_TELEGRAM_ALLOWED_USER_IDS).has(query.from.id);
    const callback = query.data?.startsWith("queue-remove:") ? query.data.slice("queue-remove:".length) : "";
    let notification = "This button has expired.";
    if (allowed && chatId !== undefined && messageId !== undefined && callback) {
      const removed = queuedTasks.remove(callback, chatId);
      if (removed) {
        notification = `Task ${removed.id} was cancelled.`;
        await closeQueuedTask(removed, "cancelled", "❌", signal);
      } else if (query.data?.startsWith("queue-remove:")) {
        notification = "This task is no longer in the queue.";
      }
    }
    await telegramRequest<unknown>(botToken!, "answerCallbackQuery", { callback_query_id: query.id, text: notification }, signal);
  }

  async function startTelegram(ctx: ExtensionContext): Promise<boolean> {
    if (controller && !controller.signal.aborted) return true;
    const token = process.env.PI_TELEGRAM_BOT_TOKEN?.trim();
    const allowedIds = splitAllowedIds(process.env.PI_TELEGRAM_ALLOWED_USER_IDS);
    if (!token || allowedIds.size === 0) {
      tellPi(ctx, "Telegram bot was not started: set PI_TELEGRAM_BOT_TOKEN and PI_TELEGRAM_ALLOWED_USER_IDS.");
      return false;
    }

    const nextController = new AbortController();
    try {
      await telegramRequest<unknown>(token, "getMe", {}, nextController.signal);
    } catch (error) {
      nextController.abort();
      tellPi(ctx, `Telegram bot was not started: token validation failed (${String(error)}).`);
      return false;
    }
    try {
      await telegramRequest<true>(token, "setMyCommands", { commands: getTelegramCommandMenu(pi.getCommands()) }, nextController.signal);
    } catch (error) {
      console.error("[pi-ad-telegram] Failed to register Telegram commands:", error);
      tellPi(ctx, `Telegram connected, but the command menu could not be updated: ${String(error)}`);
    }
    botToken = token;
    controller = nextController;
    pollTask = pollTelegram(token, allowedIds, nextController.signal).catch((error) => {
      if (!nextController.signal.aborted) console.error("[pi-ad-telegram] Polling stopped:", error);
    });
    tellPi(ctx, "Telegram bot is connecting to this Pi session.");
    return true;
  }

  async function stopTelegram(): Promise<void> {
    const activeController = controller;
    if (!activeController) return;
    const chatId = activityChatId;
    if (chatId !== undefined && botToken && !activeController.signal.aborted) {
      await deleteActivity(chatId, activeController.signal);
    }
    activeController.abort();
    await pollTask?.catch(() => undefined);
    if (controller === activeController) {
      controller = undefined;
      pollTask = undefined;
      botToken = undefined;
    }
    activeChatId = undefined;
    lastTelegramChatId = undefined;
    activityWorking = false;
    currentThinking = "";
    currentThinkingEntry = undefined;
    toolCalls.clear();
  }

  function queueActivity(chatId: number, signal: AbortSignal, action: () => Promise<void>): Promise<void> {
    activityChatId ??= chatId;
    activityQueue = activityQueue
      .then(async () => {
        if (!signal.aborted && botToken && (activityChatId === undefined || activityChatId === chatId)) await action();
      })
      .catch((error) => {
        if (!signal.aborted) console.error("[pi-ad-telegram] Failed to update Telegram activity:", error);
      });
    return activityQueue;
  }

  function renderAgentBoard(): string {
    const entries = backgroundAgents.all().reverse();
    if (entries.length === 0) return "🤖 Background agents\nNo active tasks.";
    const rows = entries.map((entry) => {
      const status = entry.status === "running" ? "⏳ running" : entry.status === "completed" ? "✅ completed" : entry.status === "failed" ? "❌ failed" : "⏹ stopped";
      const model = entry.model || "model unknown";
      const task = entry.task ? `: ${entry.task}` : "";
      const elapsed = formatDuration(((entry.finishedAt ?? Date.now()) - entry.startedAt) / 1000);
      const tokens = entry.tokenUsage === undefined ? "tokens: unavailable" : `tokens: ${compactTokens(entry.tokenUsage)}${entry.status === "running" ? " (provisional)" : ""}`;
      return `• <code>${escapeHtml(entry.id.slice(0, 8))}</code> <b>${escapeHtml(entry.agent)}</b>${escapeHtml(task)} · ${status} · ${elapsed} · ${tokens} · ${escapeHtml(model)}`;
    });
    return `🤖 <b>Background agents</b>\n${rows.join("\n")}`;
  }

  function ensureAgentBoardPolling(): void {
    if (agentBoardRefreshTimer || !backgroundAgents.hasRunning()) return;
    agentBoardRefreshTimer = setInterval(() => { void pollRunningAgentStatus(); }, 15_000);
    void pollRunningAgentStatus();
  }

  function refreshAgentBoard(chatId: number, signal: AbortSignal): Promise<void> {
    ensureAgentBoardPolling();
    agentBoardQueue = agentBoardQueue.then(async () => {
      if (signal.aborted || !botToken) return;
      const token = botToken;
      const text = renderAgentBoard();
      const errors = await agentBoardPublisher.refresh(chatId, text, backgroundAgents.hasRunning(), signal, {
        findPinnedBoard: async (targetChatId, requestSignal) => {
          const chat = await telegramRequest<TelegramChat>(token, "getChat", { chat_id: targetChatId }, requestSignal);
          const pinnedMessage = chat.pinned_message;
          const pinnedText = pinnedMessage?.text?.replace(/<\/?b>/g, "").replace(/\s+/g, " ").trim();
          return pinnedMessage && pinnedText?.startsWith("🤖 Background agents") ? pinnedMessage.message_id : undefined;
        },
        sendBoard: async (targetChatId, boardText, requestSignal) => {
          const [messageId] = await sendTelegramMessage(telegramRequest, token, targetChatId, {
            text: boardText, format: "html", disableWebPagePreview: true,
          }, requestSignal);
          return messageId;
        },
        editBoard: async (targetChatId, messageId, boardText, requestSignal) => editTelegramMessage(
          telegramRequest, token, targetChatId, messageId,
          { text: boardText, format: "html", disableWebPagePreview: true }, requestSignal,
        ),
        pinBoard: async (targetChatId, messageId, requestSignal) => {
          await telegramRequest<true>(token, "pinChatMessage", {
            chat_id: targetChatId, message_id: messageId, disable_notification: true,
          }, requestSignal);
        },
        unpinBoard: async (targetChatId, messageId, requestSignal) => {
          await telegramRequest<true>(token, "unpinChatMessage", { chat_id: targetChatId, message_id: messageId }, requestSignal);
        },
      });
      if (errors.staleUnpin && !signal.aborted) console.error("[pi-ad-telegram] Could not clear the previous pinned agent board:", errors.staleUnpin);
      if (errors.pin) {
        console.error("[pi-ad-telegram] Could not pin the background-agent board:", errors.pin);
        await reply(chatId, `Could not pin the agent board; it will remain a regular message. Telegram error: ${String(errors.pin).slice(0, 240)}`, signal);
      }
      if (errors.unpin) {
        console.error("[pi-ad-telegram] Could not unpin the background-agent board:", errors.unpin);
        await reply(chatId, `Could not automatically unpin the agent board. Telegram error: ${String(errors.unpin).slice(0, 240)}`, signal);
      }
    }).catch((error) => {
      if (!signal.aborted) console.error("[pi-ad-telegram] Failed to update background-agent board:", error);
    });
    return agentBoardQueue;
  }

  function formatDuration(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remainder = total % 60;
    return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${remainder}s` : `${remainder}s`;
  }

  async function readAgentStatus(asyncDir: string): Promise<{ model?: string; tokenUsage?: number; state?: string; endedAt?: number }> {
    if (typeof asyncDir !== "string" || !asyncDir) return {};
    try {
      const status = JSON.parse(await readFile(join(asyncDir, "status.json"), "utf8")) as Record<string, unknown>;
      const firstStep = Array.isArray(status.steps) ? status.steps[0] as Record<string, unknown> | undefined : undefined;
      const model = typeof firstStep?.model === "string" ? firstStep.model : typeof status.model === "string" ? status.model : typeof firstStep?.requestedModel === "string" ? firstStep.requestedModel : undefined;
      const usageValue = firstStep?.tokens ?? status.totalTokens ?? status.usage;
      const usage = usageValue && typeof usageValue === "object" ? usageValue as Record<string, unknown> : undefined;
      const input = typeof usage?.input === "number" ? usage.input : typeof usage?.inputTokens === "number" ? usage.inputTokens : 0;
      const output = typeof usage?.output === "number" ? usage.output : typeof usage?.outputTokens === "number" ? usage.outputTokens : 0;
      const total = typeof usage?.total === "number" ? usage.total : input + output;
      const tokenUsage = total > 0 ? total : undefined;
      return {
        model,
        tokenUsage,
        ...(typeof status.state === "string" ? { state: status.state } : {}),
        ...(typeof status.endedAt === "number" ? { endedAt: status.endedAt } : {}),
      };
    } catch {
      return {};
    }
  }

  async function pollRunningAgentStatus(): Promise<void> {
    if (agentBoardPolling) return;
    agentBoardPolling = true;
    try {
      const running = backgroundAgents.running();
      if (running.length === 0) {
        if (agentBoardRefreshTimer) clearInterval(agentBoardRefreshTimer);
        agentBoardRefreshTimer = undefined;
        return;
      }
      await Promise.all(running.map(async (entry) => {
        if (!entry.asyncDir) return;
        const status = await readAgentStatus(entry.asyncDir);
        if (status.model) entry.model = status.model;
        if (status.tokenUsage !== undefined) entry.tokenUsage = status.tokenUsage;
        if (status.state === "complete" || status.state === "completed") {
          entry.status = "completed";
          entry.finishedAt = status.endedAt ?? Date.now();
        } else if (status.state === "failed" || status.state === "partial" || status.state === "rejected") {
          entry.status = "failed";
          entry.finishedAt = status.endedAt ?? Date.now();
        } else if (status.state === "stopped") {
          entry.status = "stopped";
          entry.finishedAt = status.endedAt ?? Date.now();
        }
      }));
      if (!backgroundAgents.hasRunning() && agentBoardRefreshTimer) {
        clearInterval(agentBoardRefreshTimer);
        agentBoardRefreshTimer = undefined;
      }
      if (agentBoardPublisher.chatId !== undefined && controller) await refreshAgentBoard(agentBoardPublisher.chatId, controller.signal);
    } finally {
      agentBoardPolling = false;
    }
  }

  function renderActivity(): string[] {
    // Keep tool calls visible even if an event arrived before the activity timeline was initialized.
    const ordered = [...activityOrder];
    const orderedToolIds = new Set(ordered.flatMap((entry) => entry.type === "tool" ? [entry.id] : []));
    for (const id of toolCalls.keys()) {
      if (!orderedToolIds.has(id)) ordered.push({ type: "tool", id });
    }
    const visible = ordered.slice(-35);
    const hiddenCount = ordered.length - visible.length;
    const lines = visible.flatMap((entry) => {
      if (entry.type === "thinking") {
        const plain = entry.text
          .replace(/\*\*(.+?)\*\*/gs, "$1")
          .replace(/__(.+?)__/gs, "$1")
          .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
          .replace(/_([^_\n]+)_/g, "$1")
          .replace(/\r\n/g, "\n")
          .replace(/\n[ \t]*\n+/g, "\n")
          .trim();
        return plain ? [`• ${escapeHtml(plain.slice(-550))}`] : [];
      }
      const tool = toolCalls.get(entry.id);
      if (!tool) return [];
      const { summary, status, exitLabel } = tool;
      const bash = /^\n```bash\n([\s\S]*?)\n```$/.exec(summary);
      const label = bash
        ? (status === "running" ? "Running…" : `Exit: ${exitLabel ?? (status === "failed" ? "error" : "0")}`)
        : status === "running" ? "…" : status === "failed" ? "❌" : "✓";
      return [bash
        ? `<pre><code class="language-bash">${escapeHtml(bash[1])}</code></pre> ${label}`
        : `• ${escapeHtml(summary.slice(0, 550))} ${label}`];
    });
    const usage = currentContext?.getContextUsage();
    const contextWindow = usage?.contextWindow ?? 0;
    const contextPercent = usage?.percent;
    const stats = [
      activityInputTokens ? `↑${compactTokens(activityInputTokens)}` : "",
      activityOutputTokens ? `↓${compactTokens(activityOutputTokens)}` : "",
      activityCacheRead ? `R${compactTokens(activityCacheRead)}` : "",
      activityCacheWrite ? `W${compactTokens(activityCacheWrite)}` : "",
      activityCacheHitRate === undefined ? "" : `CH${activityCacheHitRate.toFixed(1)}%`,
      `$${activityCost.toFixed(3)}${currentContext?.model?.provider === "kimi-coding" ? " (sub)" : ""}`, 
      `${contextPercent === null || contextPercent === undefined ? "?" : `${contextPercent.toFixed(1)}%`}/${compactTokens(contextWindow)} (auto)`,
      currentContext?.model ? `${currentContext.model.id} • ${pi.getThinkingLevel()}` : "",
    ].filter(Boolean).join(" ");
    const footer = `${activityWorking ? "⏳ Working · " : "✓ Idle · "}${stats}`;
    const header = `🔧 Pi activity${hiddenCount ? ` (last ${visible.length})` : ""}:${hiddenCount ? `\n… ${hiddenCount} more events` : ""}`;
    const messages: string[] = [];
    let current = header;
    for (const line of lines) {
      const next = `${current}\n${line}`;
      if (next.length > MAX_MESSAGE_LENGTH - 100 && current !== header) {
        messages.push(current);
        current = `🔧 Pi activity (continued)\n${line}`;
      } else {
        current = next;
      }
    }
    if (`${current}\n\n${footer}`.length <= MAX_MESSAGE_LENGTH) current += `\n\n${footer}`;
    else {
      if (current !== header) messages.push(current);
      current = footer;
    }
    messages.push(current);
    return messages;
  }

  function refreshActivity(chatId: number, signal: AbortSignal): Promise<void> {
    return queueActivity(chatId, signal, async () => {
      if (!botToken) return;
      const parts = renderActivity();
      if (activityChatId !== undefined && activityChatId !== chatId) {
        activityMessageIds.length = 0;
        activityTexts.length = 0;
      }
      activityChatId = chatId;
      for (let index = 0; index < parts.length; index++) {
        const text = parts[index];
        if (activityMessageIds[index] === undefined) {
          const [messageId] = await sendTelegramMessage(telegramRequest, botToken, chatId, { text, format: "html" }, signal);
          activityMessageIds[index] = messageId;
          activityTexts[index] = text;
        } else if (activityTexts[index] !== text) {
          await editTelegramMessage(telegramRequest, botToken, chatId, activityMessageIds[index], { text, format: "html" }, signal);
          activityTexts[index] = text;
        }
      }
      for (let index = parts.length; index < activityMessageIds.length; index++) {
        try {
          await deleteTelegramMessage(botToken, chatId, activityMessageIds[index], signal);
        } catch (error) {
          if (signal.aborted) return;
          console.error("[pi-ad-telegram] Failed to delete extra Telegram activity message:", error);
        }
      }
      activityMessageIds.length = parts.length;
      activityTexts.length = parts.length;
    });
  }

  async function deleteActivity(chatId: number, signal: AbortSignal): Promise<void> {
    await activityQueue;
    if (botToken) {
      const messageIds = activityChatId === chatId ? [...activityMessageIds] : [];
      for (const messageId of messageIds) {
        try {
          await deleteTelegramMessage(botToken, chatId, messageId, signal);
        } catch (error) {
          if (signal.aborted) return;
          console.error("[pi-ad-telegram] Failed to delete Telegram activity:", error);
        }
      }
    }
    activityMessageIds.length = 0;
    activityTexts.length = 0;
    activityChatId = undefined;
    activityWorking = false;
    currentThinking = "";
    currentThinkingEntry = undefined;
    activityOrder.length = 0;
    toolCalls.clear();
  }

  async function runBashCommand(
    chatId: number,
    command: string,
    cwd: string,
    replySignal: AbortSignal,
    taskController: AbortController,
  ): Promise<void> {
    try {
      const result = await pi.exec("bash", ["-lc", command], {
        cwd,
        signal: taskController.signal,
        timeout: 120_000,
      });
      const sections = [`Command:\n\`\`\`bash\n${command}\n\`\`\``, `Exit code: ${result.code}${result.killed ? " (process stopped)" : ""}`];
      if (result.stdout) sections.push(`stdout:\n${result.stdout}`);
      if (result.stderr) sections.push(`stderr:\n${result.stderr}`);
      await reply(chatId, sections.join("\n\n"), replySignal);
    } catch (error) {
      await reply(chatId, `Command:\n\`\`\`bash\n${command}\n\`\`\`\nBash error: ${String(error)}`, replySignal);
    } finally {
      if (bashController === taskController) {
        bashController = undefined;
        activeBashChatId = undefined;
        void drainQueuedTasks();
      }
    }
  }

  async function drainQueuedTasks(): Promise<void> {
    const ctx = currentContext;
    if (drainingQueue || !ctx || !ctx.isIdle() || activeChatId !== undefined || activeBashChatId !== undefined || activeCompactChatId !== undefined || pendingNewChatId !== undefined) return;
    const task = queuedTasks.takeNext();
    if (!task) return;
    drainingQueue = true;
    try {
      const signal = controller?.signal ?? new AbortController().signal;
      await closeQueuedTask(task, "picked up", "✅", signal);
      await dispatchTask(task.chatId, task.text, ctx, signal);
    } finally {
      drainingQueue = false;
    }
  }

  async function handleUpdate(
    update: TelegramUpdate,
    signal: AbortSignal,
    groupedUpdates: TelegramUpdate[] = [update],
  ): Promise<void> {
    const message = update.message;
    const text = groupedUpdates
      .map((item) => item.message?.text?.trim() ?? item.message?.caption?.trim() ?? "")
      .find(Boolean) ?? "";
    const hasAttachments = groupedUpdates.some((item) => item.message?.document || item.message?.photo?.length);
    if (!message || (!text && !hasAttachments) || message.chat.type !== "private") return;

    const allowedIds = splitAllowedIds(process.env.PI_TELEGRAM_ALLOWED_USER_IDS);
    if (!message.from || !allowedIds.has(message.from.id)) return;

    const chatId = message.chat.id;
    lastTelegramChatId = chatId;
    let incomingAttachment = "";
    const attachments = groupedUpdates.flatMap((groupUpdate) => {
      const item = groupUpdate.message;
      const file = item?.document ?? item?.photo?.at(-1);
      return item && file ? [{ item, file }] : [];
    });
    if (attachments.length > 0) {
      try {
        const token = process.env.PI_TELEGRAM_BOT_TOKEN!.trim();
        const directory = join(currentContext?.cwd ?? process.cwd(), ".telegram-inbox");
        await mkdir(directory, { recursive: true });
        const paths: string[] = [];
        for (const [index, { item, file: telegramFile }] of attachments.entries()) {
          const file = await telegramRequest<{ file_path: string }>(token, "getFile", { file_id: telegramFile.file_id }, signal);
          const download = await fetch(`${TELEGRAM_API}/file/bot${token}/${file.file_path}`, { signal });
          if (!download.ok) throw new Error(`Download failed (${download.status})`);
          const name = basename(telegramFile.file_name || file.file_path);
          const target = join(directory, `${Date.now()}-${index}-${name}`);
          await writeFile(target, Buffer.from(await download.arrayBuffer()));
          paths.push(target);
        }
        incomingAttachment = `\n\nUser attached ${paths.length === 1 ? "file" : "files"}: ${paths.join(", ")}. Inspect ${paths.length === 1 ? "it" : "them"} as needed.`;
      } catch (error) {
        await reply(chatId, `Failed to download attachment: ${String(error)}`, signal);
        return;
      }
    }
    const commandMatch = /^\/([a-z0-9_-]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(text);
    const rawCommand = commandMatch?.[1]?.toLowerCase();
    const command = rawCommand ? normalizeTelegramCommand(rawCommand) ?? rawCommand : undefined;
    const args = commandMatch?.[2]?.trim() ?? "";
    const ctx = currentContext;

    if (await commandRegistry.dispatch(command, args, { chatId, signal, ctx })) return;

    if (command && ctx && isPluginTelegramCommand(command, pi.getCommands())) {
      const taskText = `/${command}${args ? ` ${args}` : ""}`;
      if (!ctx.isIdle() || activeChatId !== undefined || activeBashChatId !== undefined || activeCompactChatId !== undefined || pendingNewChatId !== undefined || drainingQueue) {
        const task = queuedTasks.enqueue(chatId, taskText, message.message_id);
        if (!task) {
          await reply(chatId, `Queue is full (maximum ${MAX_QUEUED_TASKS} tasks). The command was not added; try again later or use /clear_queue.`, signal);
          return;
        }
        await sendQueuedTask(chatId, task, signal);
        return;
      }
      await dispatchTask(chatId, taskText, ctx, signal);
      return;
    }

    if (command) {
      await reply(chatId, "Unknown command. Send /help for assistance.", signal);
      return;
    }

    if (!ctx) {
      await reply(chatId, "The Pi session is not ready yet. Please try again later.", signal);
      return;
    }
    const taskText = `${text || "Please inspect the attached file."}${incomingAttachment}`;
    if (!ctx.isIdle() || activeChatId !== undefined || activeBashChatId !== undefined || activeCompactChatId !== undefined || pendingNewChatId !== undefined || drainingQueue) {
      const task = queuedTasks.enqueue(chatId, taskText, message.message_id);
      if (!task) {
        await reply(chatId, `Queue is full (maximum ${MAX_QUEUED_TASKS} tasks). The task was not added; try again later or use /clear_queue.`, signal);
        return;
      }
      await sendQueuedTask(chatId, task, signal);
      return;
    }

    await dispatchTask(chatId, taskText, ctx, signal);
  }

  async function dispatchTask(chatId: number, taskText: string, ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
    activeChatId = chatId;
    activityWorking = true;
    currentThinking = "";
    currentThinkingEntry = undefined;
    activityOrder.length = 0;
    toolCalls.clear();
    cancelRequested = false;
    lastAssistantText = "";
    try {
      void refreshActivity(chatId, signal);
      if (signal.aborted) return;
      pi.sendUserMessage(taskText, { expandPromptTemplates: true });
    } catch (error) {
      activeChatId = undefined;
      await reply(chatId, `Failed to send the task to Pi: ${String(error)}`, signal);
      void drainQueuedTasks();
    }
  }

  async function pollTelegram(token: string, allowedIds: Set<number>, signal: AbortSignal): Promise<void> {
    let offset = 0;
    let initialized = false;
    let failures = 0;
    while (!signal.aborted) {
      try {
        if (!initialized) {
          // Skip updates accumulated while Pi was offline, so old commands are not replayed on startup.
          const pending = await telegramRequest<TelegramUpdate[]>(
            token,
            "getUpdates",
            { offset: -1, timeout: 0, allowed_updates: ["message", "callback_query"] },
            signal,
          );
          if (pending.length > 0) offset = pending[pending.length - 1].update_id + 1;
          initialized = true;
        }
        // Keep the long poll bounded; transient network/header timeouts are retried below.
        const updates = await telegramRequest<TelegramUpdate[]>(
          token,
          "getUpdates",
          { offset, timeout: 20, allowed_updates: ["message", "callback_query"] },
          signal,
        );
        failures = 0;
        const mediaGroups = new Map<string, TelegramUpdate[]>();
        for (const update of updates) {
          offset = update.update_id + 1;
          const groupId = update.message?.media_group_id;
          if (groupId) {
            const key = `${update.message?.chat.id}:${groupId}`;
            const group = mediaGroups.get(key) ?? [];
            group.push(update);
            mediaGroups.set(key, group);
          }
        }
        const handledGroups = new Set<string>();
        for (const update of updates) {
          if (update.callback_query) {
            await handleQueueCallback(update, signal);
            continue;
          }
          const message = update.message;
          if (!allowedIds.has(message?.from?.id ?? -1)) continue;
          const groupId = message?.media_group_id;
          if (!groupId) {
            await handleUpdate(update, signal);
            continue;
          }
          const key = `${message!.chat.id}:${groupId}`;
          if (handledGroups.has(key)) continue;
          handledGroups.add(key);
          await handleUpdate(update, signal, mediaGroups.get(key) ?? [update]);
        }
      } catch (error) {
        if (signal.aborted) return;
        const message = String(error);
        if (/\b(401|409)\b|unauthorized|conflict/i.test(message)) {
          console.error("[pi-ad-telegram] Telegram polling stopped:", error);
          const chatId = activeChatId ?? agentBoardPublisher.chatId;
          if (chatId !== undefined) await reply(chatId, `Telegram polling stopped: ${message}`, signal);
          if (currentContext) tellPi(currentContext, `Telegram polling stopped: ${message}`);
          if (controller?.signal === signal) {
            controller = undefined;
            pollTask = undefined;
            botToken = undefined;
          }
          return;
        }
        // Keep the offset unchanged and retry transient polling/network failures with capped exponential backoff.
        failures++;
        const retryDelay = Math.min(1000 * 2 ** Math.min(failures - 1, 5), 30_000);
        console.warn(`[pi-ad-telegram] Telegram polling request failed; retrying in ${retryDelay / 1000}s (attempt ${failures}).`, error);
        await sleep(retryDelay, signal);
      }
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    currentContext = ctx;
    activityInputTokens = 0;
    activityOutputTokens = 0;
    activityCacheRead = 0;
    activityCacheWrite = 0;
    activityCacheHitRate = undefined;
    activityCost = 0;
    for (const entry of ctx.sessionManager.getEntries()) {
      const value = entry as any;
      const usage = value.type === "message" ? value.message?.usage : value.usage;
      if (!usage) continue;
      activityInputTokens += usage.input ?? 0;
      activityOutputTokens += usage.output ?? 0;
      activityCacheRead += usage.cacheRead ?? 0;
      activityCacheWrite += usage.cacheWrite ?? 0;
      activityCost += usage.cost?.total ?? 0;
      if (value.type === "message" && value.message?.role === "assistant") {
        const promptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
        activityCacheHitRate = promptTokens > 0 ? ((usage.cacheRead ?? 0) / promptTokens) * 100 : undefined;
      }
    }

    // Replacing a session must not leave the previous polling loop running.
    await stopTelegram();
    if (pi.getFlag("telegram") === true || process.env.PI_TELEGRAM_ENABLED === "1") {
      await startTelegram(ctx);
    }
  });

  pi.on("tool_execution_start", async (event) => {
    if (activeChatId === undefined || !controller || !botToken) return;
    const chatId = activeChatId;
    const signal = controller.signal;
    currentThinking = "";
    currentThinkingEntry = undefined;
    activityOrder.push({ type: "tool", id: event.toolCallId });
    const summary = toolInputSummary(event.toolName, event.args);
    toolCalls.set(event.toolCallId, { summary, status: "running" });
    void refreshActivity(chatId, signal);
    if (event.toolName === "edit" && currentContext && event.args && typeof event.args === "object") {
      const args = event.args as Record<string, unknown>;
      const path = typeof args.path === "string" ? args.path : "";
      const oldText = typeof args.oldText === "string" ? args.oldText : "";
      if (path && oldText) {
        const cwd = currentContext.cwd;
        try {
          const contents = await readFile(resolve(cwd, path), "utf8");
          const index = contents.indexOf(oldText);
          if (index >= 0) {
            const startLine = contents.slice(0, index).split(/\r?\n/).length;
            const replacedLines = oldText.replace(/\r\n/g, "\n").split("\n");
            if (replacedLines.length > 1 && replacedLines[replacedLines.length - 1] === "") replacedLines.pop();
            const endLine = startLine + Math.max(1, replacedLines.length) - 1;
            const tracked = toolCalls.get(event.toolCallId);
            if (tracked) {
              tracked.summary = `${summary} · L${startLine}${endLine > startLine ? `–${endLine}` : ""}`;
              void refreshActivity(chatId, signal);
            }
          }
        } catch (error) {
          console.error("[pi-ad-telegram] Failed to locate edited lines:", error);
        }
      }
    }
  });

  pi.on("tool_execution_update", (event) => {
    if (activeChatId === undefined || !controller || !botToken) return;
    const chatId = activeChatId;
  });

  pi.on("message_update", (event) => {
    if (activeChatId === undefined || !controller || !botToken || event.message.role !== "assistant") return;
    const streamEvent = event.assistantMessageEvent;
    if (streamEvent.type === "thinking_start") {
      currentThinking = "";
      currentThinkingEntry = { type: "thinking", text: "" };
      activityOrder.push(currentThinkingEntry);
      return;
    }
    if (streamEvent.type === "thinking_delta") {
      currentThinkingEntry ??= { type: "thinking", text: "" };
      if (!activityOrder.includes(currentThinkingEntry)) activityOrder.push(currentThinkingEntry);
      currentThinking += streamEvent.delta;
      currentThinkingEntry.text = currentThinking.slice(-2500);
      void refreshActivity(activeChatId, controller.signal);
      return;
    }
    if (streamEvent.type === "thinking_end") {
      currentThinking = streamEvent.content;
      if (currentThinking.trim()) {
        currentThinkingEntry ??= { type: "thinking", text: "" };
        if (!activityOrder.includes(currentThinkingEntry)) activityOrder.push(currentThinkingEntry);
        currentThinkingEntry.text = currentThinking.slice(-2500);
        void refreshActivity(activeChatId, controller.signal);
      }
    }
  });

  let backgroundEventQueue: Promise<void> = Promise.resolve();
  installBackgroundAdapters(pi, (event: BackgroundWorkEvent) => {
    backgroundEventQueue = backgroundEventQueue.then(async () => {
      if (event.type === "started") {
        // Ignore background work not launched during a Telegram turn; never leak a TUI task to a remembered chat.
        if (activeChatId === undefined) return;
        // Flush a previous terminal-board update before a new batch can reset its state.
        await agentBoardQueue;
        const model = event.model || "determined by the agent preset";
        const chatId = activeChatId;
        const taskText = event.task || "task hidden";
        backgroundAgentLaunches.set(event.id, { chatId, agent: event.agent });
        const isNewBatch = backgroundAgents.start({
          id: event.id,
          agent: event.agent,
          model,
          task: compactTaskPreview(taskText),
          status: "running",
          asyncDir: event.statusDirectory,
          telegramChatId: chatId,
          startedAt: Date.now(),
        });
        if (isNewBatch) agentBoardPublisher.beginBatch();
        if (controller) {
          const launchSignal = controller.signal;
          await refreshAgentBoard(chatId, launchSignal);
          await reply(
            chatId,
            `🚀 Background agent started: ${event.agent}\nTask: ${backgroundAgents.get(event.id)?.task || "task hidden"}\nModel: ${backgroundAgents.get(event.id)?.model || model}\nList and status: ${agentBoardPublisher.isPinned ? "pinned board" : "/agents"}.`,
            launchSignal,
          );
          if (event.statusDirectory) {
            void readAgentStatus(event.statusDirectory).then((resolved) => {
              const entry = backgroundAgents.get(event.id);
              if (entry) {
                if (resolved.model) entry.model = resolved.model;
                if (resolved.tokenUsage !== undefined) entry.tokenUsage = resolved.tokenUsage;
                if (agentBoardPublisher.chatId !== undefined && controller) void refreshAgentBoard(agentBoardPublisher.chatId, controller.signal);
              }
            });
          }
          ensureAgentBoardPolling();
        }
        return;
      }

      const launch = backgroundAgentLaunches.get(event.id);
      const entry = backgroundAgents.finish(event.id, event.status);
      if (!backgroundAgents.hasRunning() && agentBoardRefreshTimer) {
        clearInterval(agentBoardRefreshTimer);
        agentBoardRefreshTimer = undefined;
      }
      const chatId = entry?.telegramChatId ?? launch?.chatId;
      if (chatId !== undefined && controller && botToken) {
        const signal = controller.signal;
        const agent = event.agent ?? entry?.agent ?? launch?.agent ?? "subagent";
        const state = event.status === "stopped" ? "stopped" : event.status === "failed" ? "failed" : "completed";
        const activityId = `background:${event.id}`;
        toolCalls.set(activityId, { summary: `🤖 Agent ${agent} ${state}`, status: event.status === "failed" ? "failed" : "done" });
        activityOrder.push({ type: "tool", id: activityId });
        if (entry) await refreshAgentBoard(chatId, signal);
        activityWorking = currentContext ? !currentContext.isIdle() : false;
        void refreshActivity(chatId, signal);
        // Don't dump a child report into the chat. Wake Pi so it can inspect the run and send a concise synthesis.
        const nudge = `Background agent ${agent} ${state} (run ID: ${event.id}). The user is waiting for a brief summary in English. Check the run status using the subagent tool for ID ${event.id}; summarize the result in your own words and do not copy the internal acceptance report or raw report.`;
        try {
          pi.sendUserMessage(nudge, currentContext?.isIdle() ? undefined : { deliverAs: "followUp" });
        } catch (error) {
          console.error("[pi-ad-telegram] Failed to queue subagent summary:", error);
        }
      }
      backgroundAgentLaunches.delete(event.id);
    }).catch((error) => console.error("[pi-ad-telegram] Failed to process background-agent event:", error));
  });

  pi.on("tool_execution_end", (event) => {
    if (activeChatId === undefined || !controller || !botToken) return;
    const chatId = activeChatId;
    const previous = toolCalls.get(event.toolCallId);
    const resultText = Array.isArray(event.result?.content)
      ? event.result.content.map((part: { text?: string }) => part.text ?? "").join("\n")
      : "";
    const exitCode = /Command exited with code (-?\d+)/i.exec(resultText)?.[1];
    const details = event.result?.details as Record<string, unknown> | undefined;
    const subagentId = typeof details?.asyncId === "string" ? details.asyncId : typeof details?.runId === "string" ? details.runId : undefined;
    const summary = previous?.summary ?? event.toolName;
    toolCalls.set(event.toolCallId, {
      summary: event.toolName === "subagent" && subagentId ? `${summary} · id ${subagentId.slice(0, 8)}` : summary,
      status: event.isError ? "failed" : "done",
      ...(event.toolName === "bash" ? { exitLabel: exitCode ?? (event.isError ? "error" : "0") } : {}),
    });
    void refreshActivity(chatId, controller.signal);
  });

  pi.on("session_before_compact", (event) => {
    if (activeChatId === undefined || !controller) return;
    const reason = event.reason === "threshold" ? "context threshold reached" :
      event.reason === "overflow" ? "recovering from context overflow" : "requested by Pi";
    void reply(activeChatId, `Pi started compacting context (${reason})…`, controller.signal);
  });

  pi.on("session_compact", (event) => {
    if (activeChatId === undefined || !controller) return;
    const reason = event.reason === "threshold" ? "automatically at the context threshold" :
      event.reason === "overflow" ? "to recover from context overflow" : "as requested";
    void reply(activeChatId, `Pi context compacted (${reason}).`, controller.signal);
    void refreshActivity(activeChatId, controller.signal);
  });

  pi.on("session_compact_failed", (event) => {
    if (activeChatId === undefined || !controller) return;
    const details = event.errorMessage ? `: ${event.errorMessage}` : event.aborted ? " (operation aborted)" : "";
    void reply(activeChatId, `Failed to compact Pi context${details}.`, controller.signal);
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    const text = assistantText(event.message);
    if (text) lastAssistantText = text;
    if (activeChatId !== undefined && controller) void refreshActivity(activeChatId, controller.signal);
    const usage = event.message.usage;
    if (usage && activeChatId !== undefined && controller) {
      activityInputTokens += usage.input;
      activityOutputTokens += usage.output;
      activityCacheRead += usage.cacheRead;
      activityCacheWrite += usage.cacheWrite;
      const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
      activityCacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
      activityCost += usage.cost.total;
      void refreshActivity(activeChatId, controller.signal);
    }
  });

  pi.on("agent_settled", async () => {
    const chatId = activeChatId ?? lastTelegramChatId;
    if (chatId !== undefined && botToken && controller) {
      const text = lastAssistantText || "Pi completed the task without a text response.";
      const message = cancelRequested ? `Task stopped.\n\n${text}` : text;
      cancelRequested = false;
      lastAssistantText = "";
      await activityQueue;
      await reply(chatId, message, controller.signal, true);
      activityWorking = false;
      await refreshActivity(chatId, controller.signal);
      await deleteActivity(chatId, controller.signal);
      activeChatId = undefined;
    }
    // Telegram tasks can also be waiting behind work started from the TUI/API.
    void drainQueuedTasks();
  });

  pi.on("session_shutdown", async () => {
    if (agentBoardRefreshTimer) clearInterval(agentBoardRefreshTimer);
    agentBoardRefreshTimer = undefined;
    const activityChat = activityChatId;
    await stopTelegram();
    bashController?.abort();
    await activityQueue;
    if (activityChat !== undefined && botToken) await deleteActivity(activityChat, AbortSignal.timeout(5000));
    controller = undefined;
    pollTask = undefined;
    botToken = undefined;
    currentContext = undefined;
    activeChatId = undefined;
    lastTelegramChatId = undefined;
    activeBashChatId = undefined;
    activeCompactChatId = undefined;
    pendingNewChatId = undefined;
    bashController = undefined;
    cancelRequested = false;
    lastAssistantText = "";
  });
}
