import type { Metric, UsageReport } from "./usage.ts";

export const ERROR_CODES = { tool: "PSU-TOOL-001", automatic: "PSU-AUTO-001" } as const;
export const SAFE_ERRORS = {
  tool: `Не удалось собрать статистику расходов. Попробуйте повторить запрос. Код: ${ERROR_CODES.tool}.`,
  automatic: `Не удалось показать статистику расходов. Код: ${ERROR_CODES.automatic}.`,
} as const;
function tokenCount(metric: Metric): string {
  if (metric.value === null || (!metric.complete && metric.value === 0)) return "недоступно";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.round(metric.value));
}
function usd(value: number): string {
  const milliDollars = Math.round((value + Number.EPSILON) * 1_000);
  return value > 0 && milliDollars === 0 ? "<$0.001" : `$${(milliDollars / 1_000).toFixed(3)}`;
}
function cost(metric: Metric): string | undefined {
  if (metric.value === null || (!metric.complete && metric.value === 0)) return undefined;
  return usd(metric.value);
}
function hasSubagentData(report: UsageReport): boolean {
  return (report.subagentCount !== null && report.subagentCount > 0) || [
    report.subagents.prompt,
    report.subagents.input,
    report.subagents.cached,
    report.subagents.cacheWrite,
    report.subagents.uncached,
    report.subagents.output,
    report.subagents.total,
    report.subagents.costUsd,
  ].some((metric) => metric.value !== null && metric.value > 0);
}
function cacheHitRate(report: UsageReport): string {
  if (report.total.cacheHitRate === null) return "недоступен";
  const rate = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(report.total.cacheHitRate);
  return `${rate}%`;
}
export function formatSummary(report: UsageReport): string {
  const subagents = hasSubagentData(report)
    ? `; сабагенты ${cost(report.subagents.costUsd) ?? "нет данных"}, ${report.subagentCount === null ? "число не определено" : report.subagentCount}`
    : "";
  const attribution = `основной агент ${cost(report.parent.costUsd) ?? "нет данных"}${subagents}`;
  return [
    "Расходы текущей ветки сессии (оценка)",
    `Токены: prompt ${tokenCount(report.total.prompt)} (кеш ${tokenCount(report.total.cached)} / без кеша ${tokenCount(report.total.uncached)}), output ${tokenCount(report.total.output)}, всего ${tokenCount(report.total.total)}; cache hit ${cacheHitRate(report)}.`,
    `Стоимость: ${cost(report.total.costUsd) ?? "нет данных"} (${attribution}).`,
    "В отчёте только данные, которые Pi сохранил и удалось собрать; отсутствующая статистика не считается нулевой.",
  ].join("\n");
}

/** Include structured data in model-visible tool content; `details` remains available to extensions. */
export function formatToolContent(report: UsageReport): string {
  return `${formatSummary(report)}\n\nСтруктурированные данные (JSON):\n${JSON.stringify(report)}`;
}

export function diagnosticName(error: unknown): string {
  if (error && typeof error === "object" && "name" in error && typeof error.name === "string") return error.name.slice(0, 60).replace(/[^a-zA-Z0-9_.-]/g, "_");
  return "UnknownError";
}
