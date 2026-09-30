export interface TypingTimerApi {
  setInterval(callback: () => void, delayMs: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
}

export type TypingActionRequest = (chatId: number, signal: AbortSignal) => Promise<void>;

const systemTimers: TypingTimerApi = {
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (timer) => clearInterval(timer),
};

/** Keeps Telegram's short-lived typing action alive only for an active Telegram task. */
export class TelegramTypingIndicator {
  private chatId?: number;
  private parentSignal?: AbortSignal;
  private abortListener?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: AbortController;
  private generation = 0;
  private readonly request: TypingActionRequest;
  private readonly refreshIntervalMs: number;
  private readonly timers: TypingTimerApi;
  private readonly onError: (error: unknown) => void;

  constructor(
    request: TypingActionRequest,
    refreshIntervalMs: number,
    timers: TypingTimerApi = systemTimers,
    onError: (error: unknown) => void = (error) => {
      console.warn("[pi-ad-telegram] Failed to refresh Telegram typing indicator:", error);
    },
  ) {
    this.request = request;
    this.refreshIntervalMs = refreshIntervalMs;
    this.timers = timers;
    this.onError = onError;
  }

  start(chatId: number, signal: AbortSignal): void {
    if (this.chatId === chatId && this.parentSignal === signal && !signal.aborted) return;
    this.stop();
    if (signal.aborted) return;

    this.chatId = chatId;
    this.parentSignal = signal;
    const generation = ++this.generation;
    this.abortListener = () => this.stop();
    signal.addEventListener("abort", this.abortListener, { once: true });
    void this.send(generation);
    this.timer = this.timers.setInterval(() => { void this.send(generation); }, this.refreshIntervalMs);
  }

  stop(): void {
    this.generation++;
    if (this.timer !== undefined) this.timers.clearInterval(this.timer);
    this.timer = undefined;
    if (this.parentSignal && this.abortListener) this.parentSignal.removeEventListener("abort", this.abortListener);
    this.parentSignal = undefined;
    this.abortListener = undefined;
    this.chatId = undefined;
    this.inFlight?.abort(new DOMException("Typing indicator stopped", "AbortError"));
    this.inFlight = undefined;
  }

  private async send(generation: number): Promise<void> {
    const chatId = this.chatId;
    const parentSignal = this.parentSignal;
    if (chatId === undefined || !parentSignal || parentSignal.aborted || generation !== this.generation || this.inFlight) return;

    const controller = new AbortController();
    this.inFlight = controller;
    const abort = () => controller.abort(parentSignal.reason ?? new DOMException("Aborted", "AbortError"));
    parentSignal.addEventListener("abort", abort, { once: true });
    try {
      await this.request(chatId, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted && generation === this.generation) this.onError(error);
    } finally {
      parentSignal.removeEventListener("abort", abort);
      if (this.inFlight === controller) this.inFlight = undefined;
    }
  }
}
