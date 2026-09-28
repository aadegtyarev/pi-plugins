export interface BackgroundAgentEntry {
  id: string;
  agent: string;
  model: string;
  task: string;
  status: "running" | "completed" | "failed" | "stopped";
  asyncDir?: string;
  startedAt: number;
  finishedAt?: number;
  tokenUsage?: number;
  telegramChatId?: number;
}

/** Keeps only one parallel run-batch; finished entries stay visible until the next batch starts. */
export class BackgroundAgentBatch {
  private readonly agents = new Map<string, BackgroundAgentEntry>();

  start(entry: BackgroundAgentEntry): boolean {
    const isNewBatch = !this.hasRunning();
    if (isNewBatch) this.agents.clear();
    this.agents.set(entry.id, entry);
    return isNewBatch;
  }

  finish(id: string, status: Exclude<BackgroundAgentEntry["status"], "running">, finishedAt = Date.now()): BackgroundAgentEntry | undefined {
    const entry = this.agents.get(id);
    if (entry) {
      entry.status = status;
      entry.finishedAt = finishedAt;
    }
    return entry;
  }

  get(id: string): BackgroundAgentEntry | undefined {
    return this.agents.get(id);
  }

  all(): BackgroundAgentEntry[] {
    return [...this.agents.values()];
  }

  running(): BackgroundAgentEntry[] {
    return this.all().filter((agent) => agent.status === "running");
  }

  hasRunning(): boolean {
    return this.running().length > 0;
  }
}

export interface AgentBoardTransport {
  findPinnedBoard(chatId: number, signal: AbortSignal): Promise<number | undefined>;
  sendBoard(chatId: number, text: string, signal: AbortSignal): Promise<number>;
  editBoard(chatId: number, messageId: number, text: string, signal: AbortSignal): Promise<void>;
  pinBoard(chatId: number, messageId: number, signal: AbortSignal): Promise<void>;
  unpinBoard(chatId: number, messageId: number, signal: AbortSignal): Promise<void>;
}

export interface AgentBoardRefreshErrors {
  staleUnpin?: unknown;
  pin?: unknown;
  unpin?: unknown;
}

/** Owns Telegram message/pin lifecycle; each completed batch leaves history and the next gets a new message. */
export class AgentBoardPublisher {
  private current?: { chatId: number; messageId: number; text: string };
  private pinned = false;
  private pinUnavailable = false;

  get chatId(): number | undefined {
    return this.current?.chatId;
  }

  get isPinned(): boolean {
    return this.pinned;
  }

  hasMessage(): boolean {
    return this.current !== undefined;
  }

  beginBatch(): void {
    this.current = undefined;
    this.pinned = false;
    this.pinUnavailable = false;
  }

  async refresh(
    chatId: number,
    text: string,
    hasRunningAgents: boolean,
    signal: AbortSignal,
    transport: AgentBoardTransport,
  ): Promise<AgentBoardRefreshErrors> {
    const errors: AgentBoardRefreshErrors = {};
    if (signal.aborted || (!hasRunningAgents && !this.current)) return errors;

    if (!this.current || this.current.chatId !== chatId) {
      try {
        const previousMessageId = await transport.findPinnedBoard(chatId, signal);
        if (previousMessageId !== undefined) await transport.unpinBoard(chatId, previousMessageId, signal);
      } catch (error) {
        errors.staleUnpin = error;
      }
      const messageId = await transport.sendBoard(chatId, text, signal);
      this.current = { chatId, messageId, text };
      this.pinned = false;
      this.pinUnavailable = false;
    } else if (this.current.text !== text) {
      await transport.editBoard(chatId, this.current.messageId, text, signal);
      this.current.text = text;
    }

    if (hasRunningAgents && !this.pinned && !this.pinUnavailable) {
      try {
        await transport.pinBoard(chatId, this.current.messageId, signal);
        this.pinned = true;
      } catch (error) {
        errors.pin = error;
        this.pinUnavailable = true;
      }
    } else if (!hasRunningAgents && this.current) {
      try {
        if (this.pinned) await transport.unpinBoard(chatId, this.current.messageId, signal);
      } catch (error) {
        errors.unpin = error;
      } finally {
        this.current = undefined;
        this.pinned = false;
        this.pinUnavailable = false;
      }
    }
    return errors;
  }
}
