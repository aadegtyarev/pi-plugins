import type { Metric, UsageGroup, UsageReport, UsageTotals } from "./usage.ts";

export const ERROR_CODES = { tool: "PSU-TOOL-001", command: "PSU-CMD-001" } as const;
export const SAFE_ERRORS = {
  tool: `Could not collect session usage. Please retry the request. Reference: ${ERROR_CODES.tool}.`,
  command: `Could not collect session usage. Please retry /cost. Reference: ${ERROR_CODES.command}.`,
} as const;

function compactTokens(metric: Metric): string {
  if (metric.value === null || (!metric.complete && metric.value === 0)) return "—";
  const tokens = Math.max(0, Math.round(metric.value));
  if (tokens < 1_000) return String(tokens);
  return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
}

function money(metric: Metric): string {
  if (metric.value === null || (!metric.complete && metric.value === 0)) return "—";
  const amount = metric.value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  if (metric.value > 0 && Number(amount) === 0) return `${metric.complete ? "" : "~"}<$0.000001`;
  return `${metric.complete ? "" : "~"}$${amount}`;
}

function cacheHitRate(totals: UsageTotals): string {
  return totals.cacheHitRate === null ? "—" : `${totals.cacheHitRate.toFixed(1)}%`;
}

function duration(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return "duration unavailable";
  const minutes = Math.floor(value / 60_000);
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  const remaining = minutes % 60;
  return days > 0 ? `${days}d ${String(hours).padStart(2, "0")}h ${String(remaining).padStart(2, "0")}m` : `${hours}h ${String(remaining).padStart(2, "0")}m`;
}

function modelLabel(row: UsageGroup): string {
  const model = row.model
    ? row.provider && !row.model.includes("/") ? `${row.provider}/${row.model}` : row.model
    : "unknown model";
  return `${model} • ${row.effort ?? "effort unknown"}`;
}

function rowText(row: UsageGroup): string {
  const owner = row.kind === "parent" ? "parent" : `subagent/${row.agent ?? "unknown"}`;
  const usage = row.usage;
  return `${owner} ×${row.calls ?? "—"} ↑${compactTokens(usage.input)} ↓${compactTokens(usage.output)} R${compactTokens(usage.cached)} W${compactTokens(usage.cacheWrite)} CH${cacheHitRate(usage)} ${money(usage.costUsd)} ${modelLabel(row)}`;
}

export function formatSummary(report: UsageReport): string {
  const rows = report.rows.length > 0 ? report.rows.map(rowText) : ["Usage data unavailable"];
  const total = report.total;
  const totalRow = `Total ×${report.totalCalls ?? "—"} ↑${compactTokens(total.input)} ↓${compactTokens(total.output)} R${compactTokens(total.cached)} W${compactTokens(total.cacheWrite)} CH${cacheHitRate(total)} ${money(total.costUsd)}`;
  return [`Session: ${duration(report.sessionDurationMs)} · Pi-recorded usage (estimated USD)`, ...rows, totalRow].join("\n");
}

/** Model-visible compact rows plus structured aggregates; no transcript data is included. */
export function formatToolContent(report: UsageReport): string {
  return `${formatSummary(report)}\n\nReport data (JSON):\n${JSON.stringify(report)}`;
}

export function diagnosticName(error: unknown): string {
  if (error && typeof error === "object" && "name" in error && typeof error.name === "string") return error.name.slice(0, 60).replace(/[^a-zA-Z0-9_.-]/g, "_");
  return "UnknownError";
}
