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
