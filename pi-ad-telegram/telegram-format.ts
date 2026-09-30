import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAX_EDIT_DIFF_COMPARISON_CELLS, TELEGRAM_PRESENTATION_LIMITS } from "./config.ts";
import { compactTokenCount } from "./telegram-activity.ts";

export const TELEGRAM_EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type TelegramEffortLevel = (typeof TELEGRAM_EFFORT_LEVELS)[number];

export function compactTaskPreview(task: string, previewLimit: number): string {
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
  return preview.slice(0, previewLimit) + (preview.length > previewLimit ? "…" : "");
}

export function countEditLines(oldText: string, newText: string): { added: number; removed: number } {
  const lines = (text: string) => {
    const result = text.replace(/\r\n/g, "\n").split("\n");
    if (result.length > 1 && result[result.length - 1] === "") result.pop();
    return result;
  };
  const oldLines = lines(oldText);
  const newLines = lines(newText);
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > MAX_EDIT_DIFF_COMPARISON_CELLS) {
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

export function toolInputSummary(name: string, input: unknown, backgroundTaskPreviewLimit: number): string {
  if (!input || typeof input !== "object") return name;
  const args = input as Record<string, unknown>;
  const preview = (value: unknown, maxLength: number): string => {
    if (typeof value !== "string") return "";
    const text = value.replace(/\s+/g, " ").trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
  };
  const urlPreview = (value: unknown): string => {
    const raw = preview(value, TELEGRAM_PRESENTATION_LIMITS.urlPreview);
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
    const task = typeof args.task === "string" ? compactTaskPreview(args.task, backgroundTaskPreviewLimit) : "";
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
  if (name === "bash") return `\n\`\`\`bash\n${String(args.command ?? "bash").slice(0, TELEGRAM_PRESENTATION_LIMITS.bashCommand)}\n\`\`\``;
  if (name === "grep" || name === "find") return `🔎 ${name}: ${String(args.pattern ?? args.query ?? "").slice(0, TELEGRAM_PRESENTATION_LIMITS.searchPattern)}${path ? ` — ${path}` : ""}`;
  if (name === "web_search") {
    const queries = Array.isArray(args.queries) ? args.queries.filter((query): query is string => typeof query === "string") : [];
    const query = queries.length ? queries.slice(0, TELEGRAM_PRESENTATION_LIMITS.webSearchQueryCount).map((item) => preview(item, TELEGRAM_PRESENTATION_LIMITS.webSearchQuery)).join(" · ") : preview(args.query, TELEGRAM_PRESENTATION_LIMITS.webSearchFallback);
    const extra = queries.length > TELEGRAM_PRESENTATION_LIMITS.webSearchQueryCount ? ` (+${queries.length - TELEGRAM_PRESENTATION_LIMITS.webSearchQueryCount})` : "";
    return `🌐 Search: ${query || "query unavailable"}${extra}`;
  }
  if (name === "fetch_content" || name === "web_fetch") {
    const urls = Array.isArray(args.urls) ? args.urls.filter((url): url is string => typeof url === "string") : [];
    const url = urls.length ? urls.slice(0, TELEGRAM_PRESENTATION_LIMITS.webFetchUrlCount).map(urlPreview).join(" · ") : urlPreview(args.url);
    const extra = urls.length > TELEGRAM_PRESENTATION_LIMITS.webFetchUrlCount ? ` (+${urls.length - TELEGRAM_PRESENTATION_LIMITS.webFetchUrlCount})` : "";
    return `🔗 Fetch: ${url || "URL unavailable"}${extra}`;
  }
  if (name === "source_check") return `🧾 Source check: ${preview(args.claim, TELEGRAM_PRESENTATION_LIMITS.sourceClaim) || "claim unavailable"}`;
  if (name === "get_search_content") {
    const target = args.url ? urlPreview(args.url) : preview(args.query ?? args.findText, TELEGRAM_PRESENTATION_LIMITS.retrieveQuery);
    return `📚 Retrieve: ${target || `response ${preview(args.responseId, TELEGRAM_PRESENTATION_LIMITS.responseId)}`}`;
  }
  return name;
}

export function splitAllowedIds(value: string | undefined): Set<number> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  );
}

export function assistantText(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text!)
    .join("")
    .trim();
}

export function availableEfforts(model: ExtensionContext["model"]): TelegramEffortLevel[] {
  if (!model?.reasoning) return ["off"];
  return TELEGRAM_EFFORT_LEVELS.filter((level) => {
    const mappedLevel = model.thinkingLevelMap?.[level];
    if (mappedLevel === null) return false;
    if (level === "xhigh" || level === "max") return mappedLevel !== undefined;
    return true;
  });
}

export function contextUsageText(ctx: ExtensionContext): string {
  const usage = ctx.getContextUsage();
  if (!usage) return "Context: no data yet.";

  const window = compactTokenCount(usage.contextWindow);
  if (usage.tokens === null) return `Context: unknown / ${window} tokens.`;

  const tokens = Math.max(0, usage.tokens);
  const percent = usage.percent === null ? "" : ` (${usage.percent.toFixed(1)}%)`;
  const remaining = compactTokenCount(usage.contextWindow - tokens);
  return `Context: ~${compactTokenCount(tokens)} / ${window} tokens${percent}; ~${remaining} remaining.`;
}

export function sessionReportText(ctx: ExtensionContext): string {
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
