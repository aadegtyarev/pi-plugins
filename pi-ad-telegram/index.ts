import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { installBackgroundAdapters } from "./background-adapters/index.ts";
import type { BackgroundWorkEvent } from "./background-adapters/types.ts";
import { AgentBoardPublisher, BackgroundAgentBatch } from "./agent-board.ts";
import { TelegramCommandRegistry } from "./command-registry.ts";
import { getPluginTelegramCommand, getTelegramCommandMenu, normalizeTelegramCommand, telegramHelpText } from "./commands.ts";
import { getTaskSummary, runTaskCommand } from "../pi-ad-task/task.ts";
import { editTelegramMessage, escapeHtml, sendTelegramMessage } from "./message-renderer.ts";
import { TelegramOutbox } from "./outbox.ts";
import { formatTelegramReplyContext } from "./reply-context.ts";
import { isTelegramSlashCommand } from "./stale-messages.ts";
import { getTelegramAgentDirectory, loadTelegramSettings, parseTelegramSettings, TELEGRAM_PRESENTATION_LIMITS, type TelegramSettings } from "./config.ts";
import { assistantText, availableEfforts, compactTaskPreview, contextUsageText, sessionReportText, splitAllowedIds, TELEGRAM_EFFORT_LEVELS, toolInputSummary, type TelegramEffortLevel } from "./telegram-format.ts";
import { CompactionActivityLifecycle, compactTokenCount as compactTokens, renderTelegramActivity, type TelegramActivityEntry, type TelegramActivityTool } from "./telegram-activity.ts";
import { TelegramTypingIndicator } from "./typing-indicator.ts";

const TELEGRAM_API = "https://api.telegram.org";
const TELEGRAM_UPDATE_PAGE_SIZE = 100; // Bot API getUpdates maximum result count.
const SESSION_USAGE_REPORT_TYPE = "pi-ad-session-usage:report";
interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
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
  date?: number;
  quote?: { text?: string; position?: number };
  reply_to_message?: TelegramMessage;
  media_group_id?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

interface BufferedTelegramRequest { method: string; body: Record<string, unknown>; }

let settings: TelegramSettings = parseTelegramSettings({}, getTelegramAgentDirectory());
let telegramOutbox = new TelegramOutbox(settings.outboxPath, settings.retryBaseDelayMs, settings.retryMaxDelayMs);
const BUFFERED_TELEGRAM_METHODS = new Set(["sendMessage", "editMessageText"]);

async function telegramRequest<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<T> {
  if (BUFFERED_TELEGRAM_METHODS.has(method)) {
    return telegramOutbox.request<T>(token, method, body, signal, telegramRequestDirect);
  }
  return telegramRequestDirect<T>(token, method, body, signal);
}

async function telegramRequestDirect<T>(
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

export default function (pi: ExtensionAPI) {
  let controller: AbortController | undefined;
  let pollTask: Promise<void> | undefined;
  let currentContext: ExtensionContext | undefined;
  let botToken: string | undefined;
  let typingIndicator = createTypingIndicator();
  const compactionActivity = new CompactionActivityLifecycle();
  let activeChatId: number | undefined;
  let sessionUsageReportChatId: number | undefined;
  let pendingSessionUsageReportChatId: number | undefined;
  let telegramRunChatId: number | undefined;
  let pendingTelegramRunChatId: number | undefined;
  const pendingBackgroundSummaryRoutes: Array<{ runId: string; chatId: number; prompt: string }> = [];
  let activeBackgroundSummaryRoute: { runId: string; chatId: number; prompt: string } | undefined;
  let activeBashChatId: number | undefined;
  let activeCompactChatId: number | undefined;
  let activeCompactActivityId: string | undefined;
  let pendingNewChatId: number | undefined;
  let bashController: AbortController | undefined;
  let cancelRequested = false;
  let settingsLoadError: unknown;
  let lastAssistantText = "";
  const activityMessageIds: number[] = [];
  const activityTexts: string[] = [];
  let activityChatId: number | undefined;
  let currentThinking = "";
  let currentThinkingEntry: { type: "thinking"; text: string } | undefined;
  const activityOrder: TelegramActivityEntry[] = [];
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
  const toolCalls = new Map<string, TelegramActivityTool>();

  function clearPendingBackgroundSummaryRoute(route: { runId: string; chatId: number; prompt: string }): void {
    const index = pendingBackgroundSummaryRoutes.indexOf(route);
    if (index >= 0) pendingBackgroundSummaryRoutes.splice(index, 1);
  }

  function createTypingIndicator(): TelegramTypingIndicator {
    return new TelegramTypingIndicator(async (chatId, signal) => {
      if (!botToken) return;
      await telegramRequest<true>(botToken, "sendChatAction", { chat_id: chatId, action: "typing" }, signal);
    }, settings.typingRefreshIntervalMs);
  }

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
      await sendTelegramMessage(telegramRequest, botToken, chatId, { text, format: formatMarkdown ? "markdown" : "plain" }, signal, settings.messageChunkLimit);
    } catch (error) {
      if (!signal.aborted) console.error("[pi-ad-telegram] Failed to send Telegram message:", error);
    }
  }

  async function forwardSessionUsageReport(chatId: number, text: string, signal: AbortSignal): Promise<void> {
    const token = botToken;
    if (!token || signal.aborted) return;
    try {
      await sendTelegramMessage(telegramRequest, token, chatId, { text, format: "plain" }, signal, settings.messageChunkLimit);
    } catch {
      if (!signal.aborted) console.error("[pi-ad-telegram] Failed to forward the session-usage report.");
    }
  }

  async function markSteeringSubmission(chatId: number, messageId: number | undefined, signal: AbortSignal): Promise<void> {
    if (!botToken || messageId === undefined || signal.aborted) return;
    try {
      await telegramRequest<unknown>(botToken, "setMessageReaction", {
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: "emoji", emoji: "👀" }],
        is_big: false,
      }, signal);
    } catch {
      if (!signal.aborted) console.warn("[pi-ad-telegram] Failed to mark a submitted message.");
    }
  }

  const commandRegistry = new TelegramCommandRegistry<{ chatId: number; signal: AbortSignal; ctx: ExtensionContext | undefined }>();
  commandRegistry.register("start", async ({ chatId, signal }) => {
    await reply(chatId, telegramHelpText(pi.getCommands()), signal);
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
      const shown = models.slice(0, TELEGRAM_PRESENTATION_LIMITS.modelChoices).map((model) => {
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
    if (!(TELEGRAM_EFFORT_LEVELS as readonly string[]).includes(effort)) {
      await reply(chatId, `Unknown effort level. Available: ${levels.join(", ")}.`, signal);
      return;
    }
    if (!levels.includes(effort as TelegramEffortLevel)) {
      await reply(chatId, `Effort “${effort}” is not supported by this model. Available: ${levels.join(", ")}.`, signal);
      return;
    }
    pi.setThinkingLevel(effort as TelegramEffortLevel);
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
    const compactionId = startCompactionActivity(chatId, "🧹 Compacting context (requested)", signal);
    activeCompactActivityId = compactionId;
    if (signal.aborted) {
      finishCompactionActivity(compactionId, chatId, "failed", "🧹 Context compaction was cancelled", signal);
      return;
    }
    try {
      ctx.compact({
        ...(args ? { customInstructions: args } : {}),
        onComplete: () => finishCompactionActivity(
          compactionId, chatId, "done", "🧹 Context compacted", controller?.signal ?? signal,
        ),
        onError: (error) => finishCompactionActivity(
          compactionId, chatId, "failed", `🧹 Context compaction failed: ${error.message}`, controller?.signal ?? signal,
        ),
      });
    } catch (error) {
      finishCompactionActivity(compactionId, chatId, "failed", `🧹 Could not start context compaction: ${String(error)}`, signal);
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
      if (activeChatId !== undefined) typingIndicator.stop();
      ctx.abort();
      await reply(chatId, "Stopping the current task…", signal);
    }
  });

  async function startTelegram(ctx: ExtensionContext): Promise<boolean> {
    if (controller && !controller.signal.aborted) return true;
    if (settingsLoadError) {
      tellPi(ctx, `Telegram bot was not started: ${String(settingsLoadError)}`);
      return false;
    }
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
    void telegramOutbox.replay(token, nextController.signal, telegramRequestDirect).catch((error) => {
      if (!nextController.signal.aborted) console.error("[pi-ad-telegram] Failed to replay Telegram outbox:", error);
    });
    pollTask = pollTelegram(token, allowedIds, nextController.signal).catch((error) => {
      if (!nextController.signal.aborted) console.error("[pi-ad-telegram] Polling stopped:", error);
    });
    tellPi(ctx, "Telegram bot is connecting to this Pi session.");
    return true;
  }

  async function stopTelegram(): Promise<void> {
    const activeController = controller;
    if (!activeController) return;
    typingIndicator.stop();
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
    sessionUsageReportChatId = undefined;
    pendingSessionUsageReportChatId = undefined;
    telegramRunChatId = undefined;
    pendingTelegramRunChatId = undefined;
    pendingBackgroundSummaryRoutes.length = 0;
    activeBackgroundSummaryRoute = undefined;
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
    agentBoardRefreshTimer = setInterval(() => { void pollRunningAgentStatus(); }, settings.agentBoardRefreshIntervalMs);
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
          }, requestSignal, settings.messageChunkLimit);
          return messageId;
        },
        editBoard: async (targetChatId, messageId, boardText, requestSignal) => editTelegramMessage(
          telegramRequest, token, targetChatId, messageId,
          { text: boardText, format: "html", disableWebPagePreview: true }, requestSignal, settings.messageChunkLimit,
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
        await reply(chatId, `Could not pin the agent board; it will remain a regular message. Telegram error: ${String(errors.pin).slice(0, TELEGRAM_PRESENTATION_LIMITS.telegramError)}`, signal);
      }
      if (errors.unpin) {
        console.error("[pi-ad-telegram] Could not unpin the background-agent board:", errors.unpin);
        await reply(chatId, `Could not automatically unpin the agent board. Telegram error: ${String(errors.unpin).slice(0, TELEGRAM_PRESENTATION_LIMITS.telegramError)}`, signal);
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
    const usage = currentContext?.getContextUsage();
    return renderTelegramActivity({
      order: activityOrder,
      tools: toolCalls,
      working: activityWorking,
      inputTokens: activityInputTokens,
      outputTokens: activityOutputTokens,
      cacheRead: activityCacheRead,
      cacheWrite: activityCacheWrite,
      cacheHitRate: activityCacheHitRate,
      cost: activityCost,
      contextWindow: usage?.contextWindow ?? 0,
      contextPercent: usage?.percent,
      model: currentContext?.model ? { id: currentContext.model.id, provider: currentContext.model.provider } : undefined,
      thinkingLevel: pi.getThinkingLevel(),
      messageLimit: settings.messageChunkLimit,
      historyLimit: settings.activityHistoryLimit,
      textLimit: settings.activityTextLimit,
      updatedAt: new Date(),
    });
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
          const [messageId] = await sendTelegramMessage(telegramRequest, botToken, chatId, { text, format: "html" }, signal, settings.messageChunkLimit);
          activityMessageIds[index] = messageId;
          activityTexts[index] = text;
        } else if (activityTexts[index] !== text) {
          await editTelegramMessage(telegramRequest, botToken, chatId, activityMessageIds[index], { text, format: "html" }, signal, settings.messageChunkLimit);
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

  function startCompactionActivity(chatId: number, summary: string, signal: AbortSignal): string {
    if (activeChatId === undefined) activityWorking = true;
    const row = compactionActivity.begin(summary);
    if (!toolCalls.has(row.id)) activityOrder.push({ type: "tool", id: row.id });
    toolCalls.set(row.id, { summary: row.summary, status: row.status });
    void refreshActivity(chatId, signal);
    return row.id;
  }

  function finishCompactionActivity(
    id: string,
    chatId: number,
    status: "done" | "failed",
    summary: string,
    signal: AbortSignal,
  ): void {
    const row = compactionActivity.finish(id, status, summary);
    if (row) {
      toolCalls.set(row.id, { summary: row.summary, status: row.status });
      if (activeChatId === undefined && activeCompactChatId === chatId) activityWorking = false;
      void refreshActivity(chatId, signal);
    }
    if (activeCompactActivityId === id) {
      activeCompactActivityId = undefined;
      if (activeCompactChatId === chatId) {
        activeCompactChatId = undefined;
      }
    }
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
        timeout: settings.commandTimeoutMs,
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
      }
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
    const replyContext = message ? formatTelegramReplyContext(message) : "";
    if (!message || (!text && !hasAttachments && !replyContext) || message.chat.type !== "private") return;

    const allowedIds = splitAllowedIds(process.env.PI_TELEGRAM_ALLOWED_USER_IDS);
    if (!message.from || !allowedIds.has(message.from.id)) return;

    const chatId = message.chat.id;
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

    const pluginCommand = command && ctx ? getPluginTelegramCommand(command, pi.getCommands()) : undefined;
    if (pluginCommand && ctx) {
      if (pluginCommand.piCommand === "task") {
        const action = args.trim().split(/\s+/, 1)[0]?.toLowerCase();
        const currentTask = getTaskSummary(ctx);
        const isOwnedTask = !!currentTask && currentTask.telegramChatId === chatId;
        const isStart = !!action && (action === "start" || !["status", "pause", "resume", "limit", "done", "stop"].includes(action));
        const needsTaskState = ["status", "pause", "resume", "limit", "done", "stop"].includes(action ?? "") ||
          (isStart && !!currentTask && !["done", "stopped"].includes(currentTask.status));
        if (currentTask && needsTaskState && !isOwnedTask) {
          await reply(chatId, "This session already has a task created in Pi or associated with another Telegram chat. To protect its data, manage it in Pi or in the originating chat.", signal);
          return;
        }
        if ((isStart || action === "resume") && isSessionBusy(ctx)) {
          const canStopCurrentTask = isStart && isOwnedTask && currentTask && !["done", "stopped"].includes(currentTask.status);
          const recovery = canStopCurrentTask
            ? ` Current task ${currentTask.status}: ${currentTask.goal}. To replace it, use /task stop; this will not cancel the current operation. After it finishes, retry /task start <goal>.${currentTask.status === "blocked" ? " To resume it instead of replacing it, reply with /task resume <answer>." : ""}`
            : action === "resume" ? " Check /task status, wait for the current operation to finish, then retry /task resume [answer]."
              : " Wait for the current operation to finish, then retry /task <goal>.";
          await reply(chatId, `Cannot start or resume the task while Pi or Telegram is busy.${recovery}`, signal);
          return;
        }
        const outcome = runTaskCommand(pi, args, ctx, { telegramChatId: chatId, operationBusy: isSessionBusy(ctx) });
        if (outcome.prompt) {
          const prompt = outcome.prompt;
          const submitted = await dispatchTask(chatId, prompt, ctx, signal, async (error) => {
            const state = getTaskSummary(ctx);
            const recovery = state?.status === "active"
              ? runTaskCommand(pi, "pause", ctx, { operationBusy: isSessionBusy(ctx) }).message
              : state?.status === "blocked" ? "Reply to the blocker with /task resume <answer>."
                : state?.status === "paused" ? "Resume with /task resume or stop with /task stop."
                  : state && ["done", "stopped"].includes(state.status) ? "The task is complete or stopped; start another with /task start <goal>."
                    : "Check /task status; if there is no task, start one with /task start <goal>.";
            await reply(chatId, `Pi could not accept the task: ${String(error)}\n${recovery}`, signal);
          });
          if (!submitted) return;
        }
        await reply(chatId, outcome.message, signal);
        return;
      }
      const taskText = `/${pluginCommand.piCommand}${args ? ` ${args}` : ""}`;
      if (isSessionBusy(ctx)) {
        await reply(chatId, "Pi is busy and cannot handle this slash command now. It was not queued; please send it again when Pi is ready.", signal);
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
    const taskText = `${text || (hasAttachments ? "Please inspect the attached file." : "Please respond to the message I replied to.")}${incomingAttachment}${replyContext}`;
    if (activeBashChatId !== undefined || activeCompactChatId !== undefined || pendingNewChatId !== undefined) {
      await reply(chatId, "Pi is temporarily unable to accept this message. It was not queued; please try again when Pi is ready.", signal);
      return;
    }
    if (!ctx.isIdle()) {
      try {
        pi.events?.emit?.("pi-ad-telegram:run-chat", { chatId });
        pi.sendUserMessage(taskText, { expandPromptTemplates: true, deliverAs: "steer" });
      } catch {
        await reply(chatId, "Could not submit this message to Pi. Please try again.", signal);
        return;
      }
      sessionUsageReportChatId = chatId;
      pendingSessionUsageReportChatId = chatId;
      telegramRunChatId = chatId;
      pendingTelegramRunChatId = chatId;
      void markSteeringSubmission(chatId, message.message_id, signal);
      return;
    }
    if (activeChatId !== undefined || activeBashChatId !== undefined || activeCompactChatId !== undefined || pendingNewChatId !== undefined) {
      await reply(chatId, "Pi is temporarily unable to accept this message. It was not queued; please try again when Pi is ready.", signal);
      return;
    }

    await dispatchTask(chatId, taskText, ctx, signal);
  }

  async function dispatchTask(
    chatId: number,
    taskText: string,
    ctx: ExtensionContext,
    signal: AbortSignal,
    onSubmissionFailure?: (error: unknown) => Promise<void>,
  ): Promise<boolean> {
    activeChatId = chatId;
    sessionUsageReportChatId = chatId;
    pendingSessionUsageReportChatId = chatId;
    telegramRunChatId = chatId;
    pendingTelegramRunChatId = chatId;
    typingIndicator.start(chatId, signal);
    activityWorking = true;
    currentThinking = "";
    currentThinkingEntry = undefined;
    activityOrder.length = 0;
    toolCalls.clear();
    cancelRequested = false;
    lastAssistantText = "";
    const handleSubmissionFailure = async (error: unknown): Promise<void> => {
      typingIndicator.stop();
      if (activeChatId === chatId) activeChatId = undefined;
      if (sessionUsageReportChatId === chatId) sessionUsageReportChatId = undefined;
      if (pendingSessionUsageReportChatId === chatId) pendingSessionUsageReportChatId = undefined;
      if (telegramRunChatId === chatId) telegramRunChatId = undefined;
      if (pendingTelegramRunChatId === chatId) pendingTelegramRunChatId = undefined;
      activityWorking = false;
      await deleteActivity(chatId, signal);
      if (onSubmissionFailure) await onSubmissionFailure(error);
      else await reply(chatId, `Failed to send the task to Pi: ${String(error)}`, signal);
    };
    try {
      void refreshActivity(chatId, signal);
      if (signal.aborted) {
        await handleSubmissionFailure(new Error("Telegram session ended before submission."));
        return false;
      }
      pi.events?.emit?.("pi-ad-telegram:run-chat", { chatId });
      pi.sendUserMessage(taskText, { expandPromptTemplates: true, deliverAs: "steer" });
      return true;
    } catch (error) {
      await handleSubmissionFailure(error);
      return false;
    }
  }

  async function dispatchStaleBatch(updates: TelegramUpdate[], signal: AbortSignal): Promise<void> {
    if (!currentContext) return;
    const byChat = new Map<number, string[]>();
    for (const { message } of updates) {
      if (!message || message.chat.type !== "private") continue;
      const body = message.text ?? message.caption ?? (message.photo ? "[photo attachment]" : "[non-text message]");
      if (isTelegramSlashCommand(body)) continue;
      const messages = byChat.get(message.chat.id) ?? [];
      messages.push(`• ${body}`);
      byChat.set(message.chat.id, messages);
    }
    for (const [chatId, messages] of byChat) {
      const task = `The following Telegram messages arrived while Pi was offline. They are STALE; do not carry out their requests or commands yet. Present them together and ask the user whether they are still relevant.\n\n${messages.join("\n")}`;
      if (isSessionBusy(currentContext)) {
        await reply(chatId, "A stale Telegram batch cannot be submitted because Pi is busy. The batch was not queued; send any still-relevant requests again when Pi is ready.", signal);
      } else {
        await dispatchTask(chatId, task, currentContext, signal);
      }
    }
  }

  async function pollTelegram(token: string, allowedIds: Set<number>, signal: AbortSignal): Promise<void> {
    let offset = 0;
    let initialized = false;
    let failures = 0;
    let networkFailureStartedAt: number | undefined;
    let staleBacklog = false;
    let stalePending: TelegramUpdate[] = [];
    let startupPending: TelegramUpdate[] = [];
    let startupScanOffset = 0;
    while (!signal.aborted) {
      try {
        if (!initialized) {
          // Begin at the oldest unacknowledged update so offline messages can be presented together.
          let page: TelegramUpdate[];
          do {
            page = await telegramRequest<TelegramUpdate[]>(
              token,
              "getUpdates",
              { offset: startupScanOffset, timeout: 0, allowed_updates: ["message"] },
              signal,
            );
            if (page.length > 0) {
              startupPending.push(...page);
              startupScanOffset = page[page.length - 1]!.update_id + 1;
            }
          } while (page.length >= TELEGRAM_UPDATE_PAGE_SIZE && !signal.aborted);
          offset = startupScanOffset;
          const stale = startupPending.filter((update) => update.message?.chat.type === "private" && allowedIds.has(update.message.from?.id ?? -1));
          startupPending = [];
          if (stale.length > 0) await dispatchStaleBatch(stale, signal);
          initialized = true;
        }
        // Keep the long poll bounded; transient network/header timeouts are retried below.
        let updates = await telegramRequest<TelegramUpdate[]>(
          token,
          "getUpdates",
          { offset, timeout: settings.longPollTimeoutSeconds, allowed_updates: ["message"] },
          signal,
        );
        staleBacklog ||= networkFailureStartedAt !== undefined && Date.now() - networkFailureStartedAt >= settings.staleBacklogThresholdMs;
        const staleReconnectBatch = staleBacklog;
        failures = 0;
        networkFailureStartedAt = undefined;
        if (staleBacklog) {
          stalePending.push(...updates);
          if (updates.length > 0) offset = updates[updates.length - 1]!.update_id + 1;
          while (updates.length >= TELEGRAM_UPDATE_PAGE_SIZE && !signal.aborted) {
            updates = await telegramRequest<TelegramUpdate[]>(
              token,
              "getUpdates",
              { offset, timeout: 0, allowed_updates: ["message"] },
              signal,
            );
            if (updates.length > 0) {
              stalePending.push(...updates);
              offset = updates[updates.length - 1]!.update_id + 1;
            }
          }
          updates = stalePending;
          stalePending = [];
          staleBacklog = false;
        }
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
        const staleBatch = staleReconnectBatch;
        if (staleBatch) {
          const stale = updates.filter((update) => update.message?.chat.type === "private" && allowedIds.has(update.message.from?.id ?? -1));
          if (stale.length > 0) await dispatchStaleBatch(stale, signal);
          if (updates.length < TELEGRAM_UPDATE_PAGE_SIZE) staleBacklog = false;
        }
        for (const update of updates) {
          if (staleBatch && update.message && allowedIds.has(update.message.from?.id ?? -1)) continue;
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
        networkFailureStartedAt ??= Date.now();
        const maxExponent = Math.max(0, Math.ceil(Math.log2(settings.retryMaxDelayMs / settings.retryBaseDelayMs)));
        const retryDelay = Math.min(settings.retryBaseDelayMs * 2 ** Math.min(failures - 1, maxExponent), settings.retryMaxDelayMs);
        console.warn(`[pi-ad-telegram] Telegram polling request failed; retrying in ${retryDelay / 1000}s (attempt ${failures}).`, error);
        await sleep(retryDelay, signal);
      }
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    await stopTelegram();
    sessionUsageReportChatId = undefined;
    pendingSessionUsageReportChatId = undefined;
    telegramRunChatId = undefined;
    pendingTelegramRunChatId = undefined;
    pendingBackgroundSummaryRoutes.length = 0;
    activeBackgroundSummaryRoute = undefined;
    compactionActivity.reset();
    activeCompactChatId = undefined;
    activeCompactActivityId = undefined;
    currentContext = ctx;
    try {
      settings = await loadTelegramSettings();
      settingsLoadError = undefined;
      typingIndicator = createTypingIndicator();
      telegramOutbox = new TelegramOutbox(settings.outboxPath, settings.retryBaseDelayMs, settings.retryMaxDelayMs);
    } catch (error) {
      settingsLoadError = error;
      tellPi(ctx, `Telegram settings could not be loaded: ${String(error)}`);
      return;
    }
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
    const summary = toolInputSummary(event.toolName, event.args, settings.backgroundTaskPreviewLimit);
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
      currentThinkingEntry.text = currentThinking.slice(-settings.activityTextLimit);
      void refreshActivity(activeChatId, controller.signal);
      return;
    }
    if (streamEvent.type === "thinking_end") {
      currentThinking = streamEvent.content;
      if (currentThinking.trim()) {
        currentThinkingEntry ??= { type: "thinking", text: "" };
        if (!activityOrder.includes(currentThinkingEntry)) activityOrder.push(currentThinkingEntry);
        currentThinkingEntry.text = currentThinking.slice(-settings.activityTextLimit);
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
          task: compactTaskPreview(taskText, settings.backgroundTaskPreviewLimit),
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
        // Queue the Pi nudge before Telegram board I/O. During agent_settled, Pi can report idle but defer
        // the prompt until all settled handlers finish; its next-turn route must already be installed.
        const nudge = `Background agent ${agent} ${state} (run ID: ${event.id}). The user is waiting for a brief summary in English. Check the run status using the subagent tool for ID ${event.id}; summarize the result in your own words and do not copy the internal acceptance report or raw report.`;
        const startsIdleRun = currentContext?.isIdle() === true;
        const summaryRoute = startsIdleRun ? { runId: event.id, chatId, prompt: nudge } : undefined;
        if (summaryRoute) pendingBackgroundSummaryRoutes.push(summaryRoute);
        const onQueueError = (error: unknown) => {
          if (summaryRoute) clearPendingBackgroundSummaryRoute(summaryRoute);
          console.error("[pi-ad-telegram] Failed to queue subagent summary:", error);
        };
        try {
          pi.sendUserMessage(nudge, startsIdleRun ? undefined : { deliverAs: "followUp" });
        } catch (error) {
          onQueueError(error);
        }
        const activityId = `background:${event.id}`;
        toolCalls.set(activityId, { summary: `🤖 Agent ${agent} ${state}`, status: event.status === "failed" ? "failed" : "done" });
        activityOrder.push({ type: "tool", id: activityId });
        if (entry) void refreshAgentBoard(chatId, signal);
        activityWorking = currentContext ? !currentContext.isIdle() : false;
        void refreshActivity(chatId, signal);
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
    if (event.toolName.startsWith("task")) {
      const taskChatId = currentContext ? getTaskSummary(currentContext)?.telegramChatId : undefined;
      if (taskChatId !== undefined) {
        const feedback = [`🧭 ${summary}`, resultText || (event.isError ? "The operation failed." : "The command completed.")].join("\n");
        void reply(taskChatId, feedback, controller.signal);
      }
    }
    void refreshActivity(chatId, controller.signal);
  });

  pi.on("session_before_compact", (event) => {
    const chatId = activeChatId ?? activeCompactChatId;
    if (chatId === undefined || !controller) return;
    const reason = event.reason === "threshold" ? "context threshold reached" :
      event.reason === "overflow" ? "recovering from context overflow" : "requested by Pi";
    const id = startCompactionActivity(chatId, `🧹 Compacting context (${reason})`, controller.signal);
    if (activeCompactChatId === chatId && activeCompactActivityId === undefined) activeCompactActivityId = id;
  });

  pi.on("session_compact", (event) => {
    const chatId = activeChatId ?? activeCompactChatId;
    if (chatId === undefined || !controller) return;
    const reason = event.reason === "threshold" ? "automatically at the context threshold" :
      event.reason === "overflow" ? "to recover from context overflow" : "as requested";
    const id = compactionActivity.active?.id ?? startCompactionActivity(chatId, "🧹 Compacting context", controller.signal);
    finishCompactionActivity(id, chatId, "done", `🧹 Context compacted (${reason})`, controller.signal);
  });

  pi.on("session_compact_failed", (event) => {
    const chatId = activeChatId ?? activeCompactChatId;
    if (chatId === undefined || !controller) return;
    const details = event.errorMessage ? `: ${event.errorMessage}` : event.aborted ? " (operation aborted)" : "";
    const id = compactionActivity.active?.id ?? startCompactionActivity(chatId, "🧹 Compacting context", controller.signal);
    finishCompactionActivity(id, chatId, "failed", `🧹 Context compaction failed${details}`, controller.signal);
  });

  pi.on("before_agent_start", (event) => {
    const routeIndex = pendingBackgroundSummaryRoutes.findIndex((route) => route.prompt === event.prompt);
    activeBackgroundSummaryRoute = routeIndex < 0 ? undefined : pendingBackgroundSummaryRoutes.splice(routeIndex, 1)[0];
    if (!activeBackgroundSummaryRoute) return;
    sessionUsageReportChatId = activeBackgroundSummaryRoute.chatId;
    telegramRunChatId = activeBackgroundSummaryRoute.chatId;
  });

  pi.events?.on?.("pi-ad-task:telegram-route", (event) => {
    const route = event as { chatId?: unknown; clear?: unknown } | undefined;
    const chatId = route?.chatId;
    if (!Number.isSafeInteger(chatId) || Number(chatId) <= 0) return;
    if (route?.clear === true) {
      if (telegramRunChatId === Number(chatId)) telegramRunChatId = undefined;
      return;
    }
    telegramRunChatId = Number(chatId);
  });

  pi.on("agent_start", () => {
    lastAssistantText = "";
    if (activeBackgroundSummaryRoute) {
      pi.events?.emit?.("pi-ad-telegram:run-chat", { chatId: activeBackgroundSummaryRoute.chatId });
      return;
    }
    if (pendingSessionUsageReportChatId !== undefined) sessionUsageReportChatId = pendingSessionUsageReportChatId;
    else sessionUsageReportChatId = undefined;
    pendingSessionUsageReportChatId = undefined;
    if (pendingTelegramRunChatId !== undefined) telegramRunChatId = pendingTelegramRunChatId;
    else if (telegramRunChatId === undefined) telegramRunChatId = undefined;
    pendingTelegramRunChatId = undefined;
    pi.events?.emit?.("pi-ad-telegram:run-chat", { chatId: telegramRunChatId });
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "custom" && event.message.customType === SESSION_USAGE_REPORT_TYPE) {
      const chatId = sessionUsageReportChatId;
      sessionUsageReportChatId = undefined;
      pendingSessionUsageReportChatId = undefined;
      if (chatId === undefined || !controller) return;
      const text = typeof event.message.content === "string"
        ? event.message.content
        : event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      if (text.trim()) void forwardSessionUsageReport(chatId, text, controller.signal);
      return;
    }
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
    typingIndicator.stop();
    const activityTargetChatId = activeChatId;
    const chatId = telegramRunChatId ?? activeChatId;
    if (chatId !== undefined && botToken && controller) {
      const text = lastAssistantText || "Pi completed the task without a text response.";
      const message = cancelRequested ? `Task stopped.\n\n${text}` : text;
      cancelRequested = false;
      lastAssistantText = "";
      await activityQueue;
      await reply(chatId, message, controller.signal, true);
      if (activityTargetChatId !== undefined) {
        activityWorking = false;
        await refreshActivity(activityTargetChatId, controller.signal);
        await deleteActivity(activityTargetChatId, controller.signal);
      }
      activeChatId = undefined;
    }
    telegramRunChatId = undefined;
    activeBackgroundSummaryRoute = undefined;
    if (pendingBackgroundSummaryRoutes.length === 0) pendingTelegramRunChatId = undefined;
    // Summary nudges submitted during agent_settled start after settled handlers finish.
    // Their routes are matched by exact prompt so nested deferred starts cannot reorder destinations.
    // Telegram tasks can also be waiting behind work started from the TUI/API.
  });

  pi.on("session_shutdown", async () => {
    if (agentBoardRefreshTimer) clearInterval(agentBoardRefreshTimer);
    agentBoardRefreshTimer = undefined;
    const activityChat = activityChatId;
    await stopTelegram();
    sessionUsageReportChatId = undefined;
    pendingSessionUsageReportChatId = undefined;
    telegramRunChatId = undefined;
    pendingTelegramRunChatId = undefined;
    pendingBackgroundSummaryRoutes.length = 0;
    activeBackgroundSummaryRoute = undefined;
    bashController?.abort();
    await activityQueue;
    if (activityChat !== undefined && botToken) await deleteActivity(activityChat, AbortSignal.timeout(settings.shutdownCleanupTimeoutMs));
    controller = undefined;
    pollTask = undefined;
    botToken = undefined;
    currentContext = undefined;
    activeChatId = undefined;
    activeBashChatId = undefined;
    activeCompactChatId = undefined;
    activeCompactActivityId = undefined;
    compactionActivity.reset();
    pendingNewChatId = undefined;
    bashController = undefined;
    cancelRequested = false;
    lastAssistantText = "";
  });
}
