import { escapeHtml } from "./message-renderer.ts";

export type TelegramActivityEntry =
  | { type: "tool"; id: string }
  | { type: "thinking"; text: string };

export interface TelegramActivityTool {
  summary: string;
  status: "running" | "done" | "failed";
  exitLabel?: string;
}

export interface TelegramActivityRenderInput {
  order: readonly TelegramActivityEntry[];
  tools: ReadonlyMap<string, TelegramActivityTool>;
  working: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  cacheHitRate?: number;
  cost: number;
  contextWindow: number;
  contextPercent?: number | null;
  model?: { id: string; provider: string };
  thinkingLevel: string;
  messageLimit: number;
  historyLimit: number;
  textLimit: number;
  updatedAt: Date;
}

const ACTIVITY_MESSAGE_RESERVE = 100;

export function formatLocalTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function compactTokenCount(value: number): string {
  const tokens = Math.max(0, Math.round(value));
  if (tokens < 1000) return String(tokens);
  if (tokens < 10_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${Math.round(tokens / 1000)}k`;
}

export function renderTelegramActivity(input: TelegramActivityRenderInput): string[] {
  const ordered = [...input.order];
  const orderedToolIds = new Set(ordered.flatMap((entry) => entry.type === "tool" ? [entry.id] : []));
  for (const id of input.tools.keys()) {
    if (!orderedToolIds.has(id)) ordered.push({ type: "tool", id });
  }
  const visible = ordered.slice(-input.historyLimit);
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
      return plain ? [`• ${escapeHtml(plain.slice(-input.textLimit))}`] : [];
    }
    const tool = input.tools.get(entry.id);
    if (!tool) return [];
    const { summary, status, exitLabel } = tool;
    const bash = /^\n```bash\n([\s\S]*?)\n```$/.exec(summary);
    const label = bash
      ? (status === "running" ? "Running…" : `Exit: ${exitLabel ?? (status === "failed" ? "error" : "0")}`)
      : status === "running" ? "…" : status === "failed" ? "❌" : "✓";
    return [bash
      ? `<pre><code class="language-bash">${escapeHtml(bash[1].slice(0, input.textLimit))}</code></pre> ${label}`
      : `• ${escapeHtml(summary.slice(0, input.textLimit))} ${label}`];
  });

  const stats = [
    input.inputTokens ? `↑${compactTokenCount(input.inputTokens)}` : "",
    input.outputTokens ? `↓${compactTokenCount(input.outputTokens)}` : "",
    input.cacheRead ? `R${compactTokenCount(input.cacheRead)}` : "",
    input.cacheWrite ? `W${compactTokenCount(input.cacheWrite)}` : "",
    input.cacheHitRate === undefined ? "" : `CH${input.cacheHitRate.toFixed(1)}%`,
    `$${input.cost.toFixed(3)}${input.model?.provider === "kimi-coding" ? " (sub)" : ""}`,
    `${input.contextPercent === null || input.contextPercent === undefined ? "?" : `${input.contextPercent.toFixed(1)}%`}/${compactTokenCount(input.contextWindow)} (auto)`,
    input.model ? `${input.model.id} • ${input.thinkingLevel}` : "",
  ].filter(Boolean).join(" ");
  const footer = `${input.working ? "⏳ Working · " : "✓ Idle · "}${stats}\nUpdated: ${formatLocalTime(input.updatedAt)}`;
  const header = `🔧 Pi activity${hiddenCount ? ` (last ${visible.length})` : ""}:${hiddenCount ? `\n… ${hiddenCount} more events` : ""}`;
  const messages: string[] = [];
  let current = header;
  for (const line of lines) {
    const next = `${current}\n${line}`;
    if (next.length > input.messageLimit - ACTIVITY_MESSAGE_RESERVE && current !== header) {
      messages.push(current);
      current = `🔧 Pi activity (continued)\n${line}`;
    } else {
      current = next;
    }
  }
  if (`${current}\n\n${footer}`.length <= input.messageLimit) current += `\n\n${footer}`;
  else {
    if (current !== header) messages.push(current);
    current = footer;
  }
  messages.push(current);
  return messages;
}

export interface CompactionActivityRow {
  id: string;
  summary: string;
  status: TelegramActivityTool["status"];
}

/** Associates manual command callbacks and Pi lifecycle events with one timeline row. */
export class CompactionActivityLifecycle {
  private sequence = 0;
  private activeRow?: CompactionActivityRow;
  private readonly finalized = new Set<string>();

  begin(summary: string): CompactionActivityRow {
    if (this.activeRow) {
      this.activeRow.summary = summary;
      return this.activeRow;
    }
    this.activeRow = { id: `compaction:${++this.sequence}`, summary, status: "running" };
    return this.activeRow;
  }

  finish(id: string, status: "done" | "failed", summary: string): CompactionActivityRow | undefined {
    if (this.finalized.has(id) || this.activeRow?.id !== id) return undefined;
    this.finalized.add(id);
    const row = { id, summary, status };
    this.activeRow = undefined;
    return row;
  }

  get active(): CompactionActivityRow | undefined {
    return this.activeRow;
  }

  reset(): void {
    this.sequence = 0;
    this.activeRow = undefined;
    this.finalized.clear();
  }
}
