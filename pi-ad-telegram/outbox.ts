import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_TELEGRAM_SETTINGS, getTelegramAgentDirectory } from "./config.ts";

export type TelegramOutboxRequester = <T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<T>;

export interface TelegramOutboxEntry {
  id: string;
  method: string;
  body: Record<string, unknown>;
}

const DEFAULT_OUTBOX_PATH = join(getTelegramAgentDirectory(), "telegram-outbox.json");
const DEFAULT_RETRY_BASE_DELAY_MS = DEFAULT_TELEGRAM_SETTINGS.retryBaseDelayMs;
const DEFAULT_RETRY_MAX_DELAY_MS = DEFAULT_TELEGRAM_SETTINGS.retryMaxDelayMs;
const SERVER_ERROR_STATUS = 500;
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429]);

function isTransient(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number") return TRANSIENT_HTTP_STATUSES.has(status) || status >= SERVER_ERROR_STATUS;
  const cause = (error as { cause?: { code?: unknown } }).cause;
  const code = typeof cause?.code === "string" ? cause.code : "";
  return error instanceof TypeError || /^(?:ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ETIMEDOUT|UND_ERR_)/.test(code);
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Durable, FIFO buffer for retryable Telegram message API operations.
 * The JSON file contains only operation method/body and an opaque ID; bot tokens
 * are supplied at call time and are never written to disk.
 */
export class TelegramOutbox {
  private entries: TelegramOutboxEntry[] = [];
  private loaded?: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly path: string;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;

  constructor(
    path = DEFAULT_OUTBOX_PATH,
    retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    retryMaxDelayMs = DEFAULT_RETRY_MAX_DELAY_MS,
  ) {
    this.path = path;
    this.retryBaseDelayMs = retryBaseDelayMs;
    this.retryMaxDelayMs = retryMaxDelayMs;
  }

  /** Submit and await one operation. Transient errors retry until success or abort. */
  request<T>(
    token: string,
    method: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
    requester: TelegramOutboxRequester,
  ): Promise<T> {
    const result = this.tail.then(async () => {
      await this.ensureLoaded();
      await this.replayEntries(token, signal, requester);
      const entry: TelegramOutboxEntry = { id: randomUUID(), method, body };
      this.entries.push(entry);
      await this.persist();
      try {
        const value = await this.sendWithRetry<T>(token, entry, signal, requester);
        this.entries = this.entries.filter(({ id }) => id !== entry.id);
        await this.persist();
        return value;
      } catch (error) {
        if (!isTransient(error) && !signal.aborted) {
          this.entries = this.entries.filter(({ id }) => id !== entry.id);
          await this.persist();
        }
        throw error;
      }
    });
    this.tail = result.catch(() => undefined);
    return result as Promise<T>;
  }

  /** Replay persisted operations in FIFO order, usually immediately after bot startup. */
  replay(token: string, signal: AbortSignal, requester: TelegramOutboxRequester): Promise<void> {
    const result = this.tail.then(async () => {
      await this.ensureLoaded();
      await this.replayEntries(token, signal, requester);
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async replayEntries(token: string, signal: AbortSignal, requester: TelegramOutboxRequester): Promise<void> {
    while (this.entries.length > 0) {
      const entry = this.entries[0]!;
      try {
        await this.sendWithRetry(token, entry, signal, requester);
      } catch (error) {
        if (isTransient(error) || signal.aborted) throw error;
        console.warn(`[pi-ad-telegram] Dropping permanently rejected buffered Telegram ${entry.method} operation:`, error);
      }
      this.entries.shift();
      await this.persist();
    }
  }

  private async sendWithRetry<T>(
    token: string,
    entry: TelegramOutboxEntry,
    signal: AbortSignal,
    requester: TelegramOutboxRequester,
  ): Promise<T> {
    let attempt = 0;
    while (true) {
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      try {
        return await requester<T>(token, entry.method, entry.body, signal);
      } catch (error) {
        if (!isTransient(error) || signal.aborted) throw error;
        const maxExponent = Math.max(0, Math.ceil(Math.log2(this.retryMaxDelayMs / this.retryBaseDelayMs)));
        const delay = Math.min(this.retryBaseDelayMs * 2 ** Math.min(attempt++, maxExponent), this.retryMaxDelayMs);
        await abortableSleep(delay, signal);
      }
    }
  }

  private ensureLoaded(): Promise<void> {
    this.loaded ??= this.load();
    return this.loaded;
  }

  private async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("Telegram outbox must be a JSON array");
      this.entries = parsed.map((entry) => {
        if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || typeof entry.method !== "string" || !entry.body || typeof entry.body !== "object" || Array.isArray(entry.body)) {
          throw new Error("Invalid entry in Telegram outbox");
        }
        return { id: entry.id, method: entry.method, body: entry.body as Record<string, unknown> };
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const serialized = JSON.stringify(this.entries.map(({ id, method, body }) => ({ id, method, body })), null, 2);
    try {
      await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.path);
    } catch (error) {
      await import("node:fs/promises").then(({ rm }) => rm(temporaryPath, { force: true })).catch(() => undefined);
      throw error;
    }
  }
}

export const DEFAULT_TELEGRAM_OUTBOX_PATH = DEFAULT_OUTBOX_PATH;
