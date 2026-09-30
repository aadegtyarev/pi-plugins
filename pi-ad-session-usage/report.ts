import type { UsageReport, UsageTotals } from "./usage.ts";

export const ERROR_CODES = { tool: "PSU-TOOL-001", automatic: "PSU-AUTO-001" } as const;
export const SAFE_ERRORS = {
  tool: `Не удалось собрать статистику расходов. Попробуйте повторить запрос. Код: ${ERROR_CODES.tool}.`,
  automatic: `Не удалось показать статистику расходов. Код: ${ERROR_CODES.automatic}.`,
} as const;
function metric(metric: { value: number | null; complete: boolean }, format: (n: number) => string): string {
  if (metric.value === null) return "недоступно";
  if (!metric.complete && metric.value === 0) return "недоступно (частично)";
  return `${format(metric.value)}${metric.complete ? "" : " (частично)"}`;
}
const tokens = (n: number) => Math.trunc(n).toLocaleString("ru-RU");
const usd = (n: number) => `$${n.toFixed(3)}`;
function tokenLine(t: UsageTotals): string {
  const rate = t.cacheHitRate === null ? "недоступен" : `${t.cacheHitRate.toFixed(1)}%`;
  return `Токены: prompt ${metric(t.prompt, tokens)} (кеш ${metric(t.cached, tokens)} / без кеша ${metric(t.uncached, tokens)}), output ${metric(t.output, tokens)}, всего ${metric(t.total, tokens)}; cache hit ${rate}.`;
}
export function formatSummary(report: UsageReport): string {
  const parent = metric(report.parent.costUsd, usd);
  const child = metric(report.subagents.costUsd, usd);
  const childCount = report.subagentCount === null ? "недоступно" : String(report.subagentCount);
  return [
    "Расходы текущей ветки сессии (оценка)",
    tokenLine(report.total),
    `Стоимость: ${metric(report.total.costUsd, usd)} (основной агент ${parent}; сабагенты ${child}, ${childCount}).`,
    "Оценка по данным Pi, не счет провайдера.",
  ].join("\n");
}

/** Include JSON in model-visible tool content; `details` remains available to extensions. */
export function formatToolContent(report: UsageReport): string {
  return `${formatSummary(report)}\n\nСтруктурированные данные (JSON):\n${JSON.stringify(report)}`;
}

export function diagnosticName(error: unknown): string {
  if (error && typeof error === "object" && "name" in error && typeof error.name === "string") return error.name.slice(0, 60).replace(/[^a-zA-Z0-9_.-]/g, "_");
  return "UnknownError";
}
