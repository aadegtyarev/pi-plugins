import type { Metric, UsageReport } from "./usage.ts";

export const ERROR_CODES = { tool: "PSU-TOOL-001", automatic: "PSU-AUTO-001" } as const;
export const SAFE_ERRORS = {
  tool: `Не удалось собрать статистику расходов. Попробуйте повторить запрос. Код: ${ERROR_CODES.tool}.`,
  automatic: `Не удалось показать статистику расходов. Код: ${ERROR_CODES.automatic}.`,
} as const;
function compactTokenCount(value: number): string {
  const tokens = Math.max(0, Math.round(value));
  if (tokens < 1_000) return String(tokens);
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${Math.round(tokens / 1_000)}k`;
}
function usd(value: number): string {
  const milliDollars = Math.round((value + Number.EPSILON) * 1_000);
  return value > 0 && milliDollars === 0 ? "<$0.001" : `$${(milliDollars / 1_000).toFixed(3)}`;
}
function metricValue(metric: Metric, format: (value: number) => string): string {
  if (metric.value === null || (!metric.complete && metric.value === 0)) return "—";
  return `${format(metric.value)}${metric.complete ? "" : "?"}`;
}
function costValue(metric: Metric, approximate = false): string {
  if (metric.value === null || (!metric.complete && metric.value === 0)) return "—";
  return `${approximate ? "≈" : ""}${usd(metric.value)}${metric.complete ? "" : "?"}`;
}
function incompletenessExplanation(report: UsageReport): string[] {
  const paths = [...report.partial, ...report.unavailable];
  const notes: string[] = [];
  const parentFields = paths.filter((path) => path.startsWith("parent."));
  if (parentFields.includes("parent.usage")) {
    notes.push("? Основная сессия: в ветке нет сохранённой usage-статистики.");
  } else if (parentFields.length) {
    const fields = [
      parentFields.includes("parent.input") ? "входные токены" : "",
      parentFields.includes("parent.output") ? "выходные токены" : "",
      parentFields.includes("parent.cacheRead") ? "cache-read токены" : "",
      parentFields.includes("parent.cacheWrite") ? "cache-write токены" : "",
      parentFields.includes("parent.costUsd") ? "стоимость" : "",
    ].filter(Boolean);
    if (fields.length) notes.push(`? Основная сессия: не сохранены ${fields.join(", ")}.`);
  }

  const childFields = paths.filter((path) => path.startsWith("subagents."));
  if (childFields.includes("subagents.attribution")) {
    notes.push("? Сабагенты: не найдены отчёты в поддерживаемом формате.");
  } else if (childFields.includes("subagents.usage")) {
    notes.push("? Сабагенты: часть результатов не содержит usage-отчёта.");
  } else if (childFields.length) {
    const fields = [
      childFields.includes("subagents.input") ? "входные токены" : "",
      childFields.includes("subagents.output") ? "выходные токены" : "",
      childFields.some((path) => path === "subagents.cacheRead" || path === "subagents.cacheWrite") ? "кэш-токены" : "",
      childFields.includes("subagents.costUsd") ? "стоимость" : "",
    ].filter(Boolean);
    const count = report.subagentCount === null ? "" : ` (${report.subagentCount})`;
    const noChildCache = report.subagents.cached.value === null && report.subagents.cacheWrite.value === null;
    if (noChildCache) {
      const available: string[] = [];
      if (report.subagents.input.value !== null || report.subagents.output.value !== null) available.push("входные/выходные токены");
      if (report.subagents.costUsd.value !== null) available.push("стоимость");
      const retained = available.length ? `сохранены ${available.join(" и ")}` : "данные не сохранены";
      notes.push(`? Сабагенты${count}: ${retained}, но нет cache-read/cache-write токенов.`);
    } else {
      notes.push(`? Сабагенты${count}: агрегат Pi не помечает пропуски полей${fields.length ? ` (${fields.join(", ")})` : ""}; нули могут скрывать пропуски.`);
    }
    if (childFields.some((path) => path === "subagents.count" || path === "subagents.duplicateIdentity")) {
      notes.push("? Число сабагентов неоднозначно: обнаружены совпадающие записи без надёжного ID.");
    }
  }
  if (report.total.cacheHitRate === null) {
    notes.push(report.total.prompt.complete && report.total.prompt.value === 0
      ? "CH—: нет prompt-токенов для расчёта."
      : "CH—: cache hit нельзя вычислить без полных prompt- и cache-данных.");
  }
  return notes;
}
export function formatSummary(report: UsageReport): string {
  const fields = [
    `↑${metricValue(report.total.input, compactTokenCount)}`,
    `↓${metricValue(report.total.output, compactTokenCount)}`,
    `R${metricValue(report.total.cached, compactTokenCount)}`,
    ...(report.total.cacheWrite.value !== 0 || !report.total.cacheWrite.complete
      ? [`W${metricValue(report.total.cacheWrite, compactTokenCount)}`]
      : []),
    `CH${report.total.cacheHitRate === null ? "—" : `${report.total.cacheHitRate.toFixed(1)}%`}`,
    `Σ${metricValue(report.total.total, compactTokenCount)}`,
    costValue(report.total.costUsd, true),
  ];
  const childCount = report.subagentCount === null ? "—" : String(report.subagentCount);
  const summary = `${fields.join(" ")} · основная ${costValue(report.parent.costUsd)} + сабагенты ${costValue(report.subagents.costUsd)} / ${childCount}`;
  return [summary, ...incompletenessExplanation(report)].join("\n");
}

/** Include structured data in model-visible tool content; `details` remains available to extensions. */
export function formatToolContent(report: UsageReport): string {
  return `${formatSummary(report)}\n\nСтруктурированные данные (JSON):\n${JSON.stringify(report)}`;
}

export function diagnosticName(error: unknown): string {
  if (error && typeof error === "object" && "name" in error && typeof error.name === "string") return error.name.slice(0, 60).replace(/[^a-zA-Z0-9_.-]/g, "_");
  return "UnknownError";
}
