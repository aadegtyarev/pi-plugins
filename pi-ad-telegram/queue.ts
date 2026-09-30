import { DEFAULT_TELEGRAM_SETTINGS } from "./config.ts";

export const MAX_QUEUED_TASKS = DEFAULT_TELEGRAM_SETTINGS.queueCapacity;

export type QueueTaskFinalState = "picked up" | "cancelled";
export type QueueTaskReaction = "👍" | "👎";

/** Telegram Bot API accepts these emoji as standard reactions (unlike the visual ✅/❌ status icons). */
export function reactionForQueueTask(state: QueueTaskFinalState): QueueTaskReaction {
  return state === "picked up" ? "👍" : "👎";
}

export interface QueuedTelegramTask {
  id: string;
  chatId: number;
  text: string;
  replyToMessageId?: number;
  noticeMessageId?: number;
}

/** FIFO storage and chat-scoped queue operations for Telegram's queued input. */
export class TelegramTaskQueue {
  private readonly tasks: QueuedTelegramTask[] = [];
  private nextId = 1;
  private capacity: number;

  constructor(capacity = DEFAULT_TELEGRAM_SETTINGS.queueCapacity) {
    this.capacity = capacity;
  }

  setCapacity(capacity: number): void {
    this.capacity = capacity;
  }

  get length(): number {
    return this.tasks.length;
  }

  enqueue(chatId: number, text: string, replyToMessageId?: number): QueuedTelegramTask | undefined {
    if (this.tasks.length >= this.capacity) return undefined;
    const task: QueuedTelegramTask = {
      id: `${Date.now().toString(36)}-${this.nextId++}`,
      chatId,
      text,
      replyToMessageId,
    };
    this.tasks.push(task);
    return task;
  }

  listForChat(chatId: number): QueuedTelegramTask[] {
    return this.tasks.filter((task) => task.chatId === chatId);
  }

  remove(id: string, chatId: number): QueuedTelegramTask | undefined {
    const index = this.tasks.findIndex((task) => task.id === id && task.chatId === chatId);
    if (index < 0) return undefined;
    return this.tasks.splice(index, 1)[0];
  }

  removeAllForChat(chatId: number): QueuedTelegramTask[] {
    const removed = this.listForChat(chatId);
    const removedIds = new Set(removed.map((task) => task.id));
    for (let index = this.tasks.length - 1; index >= 0; index--) {
      if (removedIds.has(this.tasks[index].id)) this.tasks.splice(index, 1);
    }
    return removed;
  }

  takeNext(): QueuedTelegramTask | undefined {
    return this.tasks.shift();
  }
}

export function formatQueueListing(tasks: QueuedTelegramTask[], previewLimit = DEFAULT_TELEGRAM_SETTINGS.queuePreviewLimit): string {
  if (tasks.length === 0) return "Your task queue is empty.";
  const rows = tasks.map((task) => `• ID \`${task.id}\`: ${task.text.replace(/\s+/g, " ").slice(0, previewLimit)}`);
  return `You have ${tasks.length} queued task(s):\n${rows.join("\n")}\n\nRemove a task: /queue_cancel <ID>`;
}

export function parseQueueCancelId(args: string): string | undefined {
  return args.trim().split(/\s+/)[0] || undefined;
}

export interface QueueNoticeFinalizer {
  signal: AbortSignal;
  react?: () => Promise<unknown>;
  deleteNotice: () => Promise<boolean>;
  editNotice: () => Promise<void>;
  onError?: (stage: "reaction" | "notice deletion", error: unknown) => void;
}

/** React to the source message, then delete the notice; if either fails, leave an inert status notice. */
export async function finalizeQueueNotice({ signal, react, deleteNotice, editNotice, onError }: QueueNoticeFinalizer): Promise<void> {
  if (signal.aborted) return;
  if (react) {
    let reactionSucceeded = false;
    try {
      await react();
      reactionSucceeded = true;
    } catch (error) {
      onError?.("reaction", error);
    }
    if (reactionSucceeded) {
      try {
        if (await deleteNotice()) return;
      } catch (error) {
        onError?.("notice deletion", error);
      }
      if (signal.aborted) return;
    }
  }
  if (!signal.aborted) await editNotice();
}
