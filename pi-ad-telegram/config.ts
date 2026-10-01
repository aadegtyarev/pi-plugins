import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_LONG_POLL_LIMIT_SECONDS = 50;
const TELEGRAM_CHAT_ACTION_LIFETIME_MS = 5000;
const MAX_STALE_BACKLOG_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;
const MAX_POLL_INTERVAL_MS = 10 * 60 * 1000;
const MIN_POLL_INTERVAL_MS = 1000;
const MAX_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_COMMAND_TIMEOUT_MS = 1000;
const MIN_DISPLAY_LIMIT = 1;
const MAX_ACTIVITY_HISTORY = 500;
const MIN_RETRY_DELAY_MS = 100;
const MIN_MESSAGE_CHUNK_LENGTH = 100;

/** Fixed presentation caps: named here so display behavior is auditable, not scattered magic numbers. */
export const TELEGRAM_PRESENTATION_LIMITS = {
  modelChoices: 50,
  bashCommand: 180,
  searchPattern: 120,
  webSearchQueryCount: 2,
  webSearchQuery: 130,
  webSearchFallback: 180,
  webFetchUrlCount: 2,
  sourceClaim: 180,
  retrieveQuery: 140,
  responseId: 24,
  urlPreview: 240,
  telegramError: 240,
} as const;

export const MAX_EDIT_DIFF_COMPARISON_CELLS = 1_000_000;

export interface TelegramSettings {
  longPollTimeoutSeconds: number;
  staleBacklogThresholdMs: number;
  messageChunkLimit: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  agentBoardRefreshIntervalMs: number;
  typingRefreshIntervalMs: number;
  commandTimeoutMs: number;
  shutdownCleanupTimeoutMs: number;
  activityHistoryLimit: number;
  activityTextLimit: number;
  backgroundTaskPreviewLimit: number;
  outboxPath: string;
}

export const DEFAULT_TELEGRAM_SETTINGS: Omit<TelegramSettings, "outboxPath"> = {
  longPollTimeoutSeconds: 20,
  staleBacklogThresholdMs: 30_000,
  messageChunkLimit: 3500,
  retryBaseDelayMs: 1000,
  retryMaxDelayMs: 30_000,
  agentBoardRefreshIntervalMs: 15_000,
  typingRefreshIntervalMs: 4000,
  commandTimeoutMs: 120_000,
  shutdownCleanupTimeoutMs: 5000,
  activityHistoryLimit: 35,
  activityTextLimit: 550,
  backgroundTaskPreviewLimit: 82,
};

export type TelegramSettingsInput = Partial<Omit<TelegramSettings, "outboxPath">> & { outboxPath?: string };

export function getTelegramSettingsPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  const agentDirectory = env.PI_CODING_AGENT_DIR?.trim() || join(homeDirectory, ".pi", "agent");
  return join(agentDirectory, "pi-ad-telegram.json");
}

export function getTelegramAgentDirectory(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  return env.PI_CODING_AGENT_DIR?.trim() || join(homeDirectory, ".pi", "agent");
}

export function parseTelegramSettings(value: unknown, agentDirectory: string): TelegramSettings {
  if (!isRecord(value)) throw new Error("Telegram settings must be a JSON object");

  const allowedKeys = new Set<keyof TelegramSettings>([
    "longPollTimeoutSeconds", "staleBacklogThresholdMs", "messageChunkLimit",
    "retryBaseDelayMs", "retryMaxDelayMs", "agentBoardRefreshIntervalMs", "typingRefreshIntervalMs",
    "commandTimeoutMs", "shutdownCleanupTimeoutMs", "activityHistoryLimit", "activityTextLimit",
    "backgroundTaskPreviewLimit", "outboxPath",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key as keyof TelegramSettings)) throw new Error(`Unknown Telegram setting: ${key}`);
  }

  const settings: TelegramSettings = {
    ...DEFAULT_TELEGRAM_SETTINGS,
    outboxPath: join(agentDirectory, "telegram-outbox.json"),
    ...parseNumericSettings(value),
  };

  if (value.outboxPath !== undefined) {
    if (typeof value.outboxPath !== "string" || value.outboxPath.trim() === "") {
      throw new Error("Telegram setting outboxPath must be a non-empty path");
    }
    settings.outboxPath = isAbsolute(value.outboxPath)
      ? value.outboxPath
      : resolve(agentDirectory, value.outboxPath);
  }

  if (settings.retryMaxDelayMs < settings.retryBaseDelayMs) {
    throw new Error("Telegram setting retryMaxDelayMs must be greater than or equal to retryBaseDelayMs");
  }
  return settings;
}

export async function loadTelegramSettings(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): Promise<TelegramSettings> {
  const agentDirectory = getTelegramAgentDirectory(env, homeDirectory);
  const settingsPath = getTelegramSettingsPath(env, homeDirectory);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(settingsPath, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return parseTelegramSettings({}, agentDirectory);
    }
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in Telegram settings file ${settingsPath}: ${error.message}`);
    throw new Error(`Could not read Telegram settings file ${settingsPath}: ${String(error)}`);
  }
  try {
    return parseTelegramSettings(parsed, agentDirectory);
  } catch (error) {
    throw new Error(`Invalid Telegram settings in ${settingsPath}: ${String(error)}`);
  }
}

function parseNumericSettings(value: Record<string, unknown>): Partial<TelegramSettings> {
  const integer = (key: keyof Omit<TelegramSettings, "outboxPath">, min: number, max: number): number | undefined => {
    const candidate = value[key];
    if (candidate === undefined) return undefined;
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
      throw new Error(`Telegram setting ${key} must be an integer between ${min} and ${max}`);
    }
    return candidate;
  };

  const longPollTimeoutSeconds = integer("longPollTimeoutSeconds", 0, TELEGRAM_LONG_POLL_LIMIT_SECONDS);
  const staleBacklogThresholdMs = integer("staleBacklogThresholdMs", 0, MAX_STALE_BACKLOG_AGE_MS);
  const messageChunkLimit = integer("messageChunkLimit", MIN_MESSAGE_CHUNK_LENGTH, TELEGRAM_TEXT_LIMIT);
  const retryBaseDelayMs = integer("retryBaseDelayMs", MIN_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS);
  const retryMaxDelayMs = integer("retryMaxDelayMs", MIN_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS);
  const agentBoardRefreshIntervalMs = integer("agentBoardRefreshIntervalMs", MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS);
  const typingRefreshIntervalMs = integer("typingRefreshIntervalMs", MIN_POLL_INTERVAL_MS, TELEGRAM_CHAT_ACTION_LIFETIME_MS - 1);
  const commandTimeoutMs = integer("commandTimeoutMs", MIN_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS);
  const shutdownCleanupTimeoutMs = integer("shutdownCleanupTimeoutMs", MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS);
  const activityHistoryLimit = integer("activityHistoryLimit", MIN_DISPLAY_LIMIT, MAX_ACTIVITY_HISTORY);
  const activityTextLimit = integer("activityTextLimit", MIN_DISPLAY_LIMIT, TELEGRAM_TEXT_LIMIT);
  const backgroundTaskPreviewLimit = integer("backgroundTaskPreviewLimit", MIN_DISPLAY_LIMIT, TELEGRAM_TEXT_LIMIT);

  return {
    ...(longPollTimeoutSeconds === undefined ? {} : { longPollTimeoutSeconds }),
    ...(staleBacklogThresholdMs === undefined ? {} : { staleBacklogThresholdMs }),
    ...(messageChunkLimit === undefined ? {} : { messageChunkLimit }),
    ...(retryBaseDelayMs === undefined ? {} : { retryBaseDelayMs }),
    ...(retryMaxDelayMs === undefined ? {} : { retryMaxDelayMs }),
    ...(agentBoardRefreshIntervalMs === undefined ? {} : { agentBoardRefreshIntervalMs }),
    ...(typingRefreshIntervalMs === undefined ? {} : { typingRefreshIntervalMs }),
    ...(commandTimeoutMs === undefined ? {} : { commandTimeoutMs }),
    ...(shutdownCleanupTimeoutMs === undefined ? {} : { shutdownCleanupTimeoutMs }),
    ...(activityHistoryLimit === undefined ? {} : { activityHistoryLimit }),
    ...(activityTextLimit === undefined ? {} : { activityTextLimit }),
    ...(backgroundTaskPreviewLimit === undefined ? {} : { backgroundTaskPreviewLimit }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error) && typeof error === "object" && "code" in error;
}
