import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type Metric = { value: number | null; complete: boolean };
export interface UsageTotals {
  prompt: Metric;
  input: Metric;
  cached: Metric;
  cacheWrite: Metric;
  uncached: Metric;
  output: Metric;
  total: Metric;
  costUsd: Metric;
  cacheHitRate: number | null;
}
export interface UsageGroup {
  kind: "parent" | "subagent";
  agent: string | null;
  provider: string | null;
  model: string | null;
  effort: string | null;
  calls: number | null;
  usage: UsageTotals;
}
export interface UsageReport {
  estimate: true;
  sessionDurationMs: number | null;
  parent: UsageTotals;
  subagents: UsageTotals;
  total: UsageTotals;
  rows: UsageGroup[];
  totalCalls: number | null;
  subagentCount: number | null;
  complete: boolean;
  unavailable: string[];
  partial: string[];
}

type Field = "input" | "output" | "cacheRead" | "cacheWrite" | "costUsd";
type RawUsage = {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  cost?: { total?: unknown } | number;
};
type Acc = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  known: Set<Field>;
  missing: Set<Field | "usage">;
  uncertain: Set<Field>;
  seen: boolean;
};
const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
const ALL_FIELDS: Field[] = [...TOKEN_FIELDS, "costUsd"];
const create = (): Acc => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd: 0,
  known: new Set(),
  missing: new Set(),
  uncertain: new Set(),
  seen: false,
});
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function markUsageMissing(target: Acc): void {
  target.missing.add("usage");
  for (const field of ALL_FIELDS) target.missing.add(field);
}

/**
 * pi-subagents aggregates child usage after defaulting omitted provider fields to zero.
 * Keep positive aggregates as partial evidence and treat zero aggregates as unavailable.
 */
function add(target: Acc, raw: unknown, aggregatedChild = false): void {
  if (!raw || typeof raw !== "object") {
    markUsageMissing(target);
    return;
  }
  target.seen = true;
  const usage = raw as RawUsage;
  for (const field of TOKEN_FIELDS) {
    const value = usage[field];
    if (!isNumber(value)) {
      target.missing.add(field);
      continue;
    }
    if (aggregatedChild && value === 0) {
      target.missing.add(field);
      continue;
    }
    target[field] += value;
    target.known.add(field);
    if (aggregatedChild) target.uncertain.add(field);
  }
  const cost = typeof usage.cost === "number" ? usage.cost : usage.cost?.total;
  if (!isNumber(cost) || (aggregatedChild && cost === 0)) {
    target.missing.add("costUsd");
  } else {
    target.costUsd += cost;
    target.known.add("costUsd");
    if (aggregatedChild) target.uncertain.add("costUsd");
  }
}

function metric(acc: Acc, fields: Field[], value: number): Metric {
  const hasValue = fields.some((field) => acc.known.has(field));
  const complete = acc.seen && fields.every((field) =>
    acc.known.has(field) && !acc.missing.has(field) && !acc.uncertain.has(field),
  );
  return { value: hasValue ? value : null, complete };
}

function totals(acc: Acc): UsageTotals {
  const prompt = acc.input + acc.cacheRead + acc.cacheWrite;
  const promptFields: Field[] = ["input", "cacheRead", "cacheWrite"];
  const promptMetric = metric(acc, promptFields, prompt);
  const cachedMetric = metric(acc, ["cacheRead"], acc.cacheRead);
  return {
    prompt: promptMetric,
    input: metric(acc, ["input"], acc.input),
    cached: cachedMetric,
    cacheWrite: metric(acc, ["cacheWrite"], acc.cacheWrite),
    uncached: metric(acc, ["input", "cacheWrite"], acc.input + acc.cacheWrite),
    output: metric(acc, ["output"], acc.output),
    total: metric(acc, [...promptFields, "output"], prompt + acc.output),
    costUsd: metric(acc, ["costUsd"], acc.costUsd),
    cacheHitRate: promptMetric.complete && cachedMetric.complete && prompt > 0
      ? acc.cacheRead / prompt * 100
      : null,
  };
}

function childDetails(entry: SessionEntry): unknown {
  if (entry.type === "custom_message" && entry.customType === "subagent-slash-result") {
    const details = entry.details;
    if (details && typeof details === "object" && "result" in details) {
      return (details as { result?: { details?: unknown } }).result?.details;
    }
    return undefined;
  }
  if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "subagent") {
    return entry.message.details;
  }
  return undefined;
}

function subagentResults(details: unknown): unknown[] | undefined {
  if (!details || typeof details !== "object") return undefined;
  const record = details as { mode?: unknown; results?: unknown };
  return typeof record.mode === "string" && Array.isArray(record.results) ? record.results : undefined;
}

function usageSignature(result: Record<string, unknown>): string {
  const usage = result.usage as Record<string, unknown> | undefined;
  const totalCost = result.totalCost as Record<string, unknown> | undefined;
  const attempts = Array.isArray(result.modelAttempts)
    ? result.modelAttempts.map((attempt) => {
      if (!attempt || typeof attempt !== "object") return null;
      const attemptUsage = (attempt as { usage?: Record<string, unknown> }).usage;
      const attemptRecord = attempt as Record<string, unknown>;
      return [attemptRecord.model, attemptRecord.requestedModel, attemptRecord.provider, attemptRecord.thinking ?? attemptRecord.effort, attemptUsage?.input, attemptUsage?.output, attemptUsage?.cacheRead, attemptUsage?.cacheWrite, attemptUsage?.cost];
    })
    : null;
  return JSON.stringify([
    result.sessionFile,
    result.agent,
    result.task,
    result.provider,
    result.model,
    result.requestedModel,
    result.thinking,
    usage?.input,
    usage?.output,
    usage?.cacheRead,
    usage?.cacheWrite,
    usage?.cost,
    totalCost?.inputTokens,
    totalCost?.outputTokens,
    totalCost?.costUsd,
    attempts,
  ]);
}

function addChildUsage(target: Acc, result: Record<string, unknown>): void {
  if (result.usage && typeof result.usage === "object") {
    // Foreground pi-subagents results aggregate a child's direct model calls here.
    add(target, result.usage, true);
    return;
  }

  if (Array.isArray(result.modelAttempts)) {
    const attemptsWithUsage = result.modelAttempts.filter((attempt) =>
      !!attempt && typeof attempt === "object" && (attempt as { usage?: unknown }).usage && typeof (attempt as { usage?: unknown }).usage === "object",
    );
    if (attemptsWithUsage.length > 0) {
      for (const attempt of attemptsWithUsage) add(target, (attempt as { usage: unknown }).usage, true);
      if (attemptsWithUsage.length < result.modelAttempts.length) markUsageMissing(target);
      return;
    }
  }

  const totalCost = result.totalCost;
  if (totalCost && typeof totalCost === "object") {
    const summary = totalCost as { inputTokens?: unknown; outputTokens?: unknown; costUsd?: unknown };
    // Background results retain only input/output totals and cost, not cache categories.
    add(target, { input: summary.inputTokens, output: summary.outputTokens, cost: summary.costUsd }, true);
    return;
  }
  markUsageMissing(target);
}

function compactModelName(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function rowKey(kind: UsageGroup["kind"], agent: string | null, provider: string | null, model: string | null, effort: string | null): string {
  return JSON.stringify([kind, agent, provider, model, effort]);
}

type MutableUsageGroup = Omit<UsageGroup, "usage"> & { acc: Acc };

function collectRows(branch: SessionEntry[]): { rows: UsageGroup[]; ambiguousChildIdentity: boolean } {
  const rows = new Map<string, MutableUsageGroup>();
  const getRow = (kind: UsageGroup["kind"], agent: string | null, provider: string | null, model: string | null, effort: string | null): MutableUsageGroup => {
    const key = rowKey(kind, agent, provider, model, effort);
    let row = rows.get(key);
    if (!row) {
      row = { kind, agent, provider, model, effort, calls: 0, acc: create() };
      rows.set(key, row);
    }
    return row;
  };
  const seenChildren = new Map<string, { stableIdentity: boolean; signature: string }>();
  let ambiguousChildIdentity = false;

  for (const entry of branch) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      const message = entry.message as typeof entry.message & { model?: unknown; responseModel?: unknown; provider?: unknown; providerThinkingLevel?: unknown };
      const row = getRow("parent", null, compactModelName(message.provider), compactModelName(message.responseModel) ?? compactModelName(message.model), compactModelName(message.providerThinkingLevel));
      row.calls++;
      add(row.acc, message.usage);
    }

    const results = subagentResults(childDetails(entry));
    if (!results) continue;
    for (const item of results) {
      if (!item || typeof item !== "object") {
        const row = getRow("subagent", null, null, null, null);
        row.calls++;
        markUsageMissing(row.acc);
        continue;
      }
      const result = item as Record<string, unknown>;
      const signature = usageSignature(result);
      const sessionFile = typeof result.sessionFile === "string" ? result.sessionFile.trim() : "";
      const stableIdentity = sessionFile.length > 0;
      const identity = stableIdentity ? `session:${sessionFile}` : `value:${signature}`;
      const previous = seenChildren.get(identity);
      if (previous) {
        if (!stableIdentity || !previous.stableIdentity || previous.signature !== signature) ambiguousChildIdentity = true;
        continue;
      }
      seenChildren.set(identity, { stableIdentity, signature });
      const agent = compactModelName(result.agent);
      const resultModel = compactModelName(result.model ?? result.requestedModel);
      const resultProvider = compactModelName(result.provider);
      const resultEffort = compactModelName(result.thinking);
      const attempts = Array.isArray(result.modelAttempts) ? result.modelAttempts.filter((attempt) => !!attempt && typeof attempt === "object") as Array<Record<string, unknown>> : [];
      const attemptsWithUsage = attempts.filter((attempt) => !!attempt.usage && typeof attempt.usage === "object");
      if (attemptsWithUsage.length > 0) {
        const countedRows = new Set<MutableUsageGroup>();
        for (const attempt of attemptsWithUsage) {
          const row = getRow("subagent", agent, compactModelName(attempt.provider) ?? resultProvider, compactModelName(attempt.model) ?? resultModel, compactModelName(attempt.thinking ?? attempt.effort) ?? resultEffort);
          if (!countedRows.has(row)) {
            row.calls++;
            countedRows.add(row);
          }
          add(row.acc, attempt.usage, true);
        }
        if (attemptsWithUsage.length < attempts.length) {
          const row = getRow("subagent", agent, null, null, null);
          row.calls++;
          markUsageMissing(row.acc);
        }
        continue;
      }
      const row = getRow("subagent", agent, resultProvider, resultModel, resultEffort);
      row.calls++;
      if (result.usage && typeof result.usage === "object") {
        add(row.acc, result.usage, true);
      } else if (result.totalCost && typeof result.totalCost === "object") {
        const totalCost = result.totalCost as { inputTokens?: unknown; outputTokens?: unknown; costUsd?: unknown };
        add(row.acc, { input: totalCost.inputTokens, output: totalCost.outputTokens, cost: totalCost.costUsd }, true);
      } else {
        markUsageMissing(row.acc);
      }
    }
  }

  let sourceRows = [...rows.values()];
  if (ambiguousChildIdentity) {
    const childRows = sourceRows.filter((row) => row.kind === "subagent");
    if (childRows.length > 0) {
      const unattributed = create();
      for (const row of childRows) combineInto(unattributed, row.acc);
      sourceRows = sourceRows.filter((row) => row.kind === "parent");
      sourceRows.push({ kind: "subagent", agent: null, provider: null, model: null, effort: null, calls: null, acc: unattributed });
    }
  }
  const ordered = sourceRows.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "parent" ? -1 : 1;
    return (a.agent ?? "").localeCompare(b.agent ?? "") || (a.provider ?? "").localeCompare(b.provider ?? "") ||
      (a.model ?? "").localeCompare(b.model ?? "") || (a.effort ?? "").localeCompare(b.effort ?? "");
  });
  return { rows: ordered.map(({ acc, ...row }) => ({ ...row, usage: totals(acc) })), ambiguousChildIdentity };
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function sessionDuration(branch: SessionEntry[], now: number): number | null {
  for (const entry of branch) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const item = entry as unknown as { timestamp?: unknown };
    const started = timestampMs(item.timestamp) ?? timestampMs((entry.message as unknown as { timestamp?: unknown }).timestamp);
    if (started !== undefined && now >= started) return now - started;
  }
  return null;
}

function combineInto(target: Acc, source: Acc): void {
  if (!source.seen && source.missing.size === 0) return;
  target.seen ||= source.seen;
  for (const field of TOKEN_FIELDS) target[field] += source[field];
  target.costUsd += source.costUsd;
  for (const field of source.known) target.known.add(field);
  for (const field of source.missing) target.missing.add(field);
  for (const field of source.uncertain) target.uncertain.add(field);
}

/** Collect active-branch assistant usage and persisted direct-child results. */
export function collectUsage(branch: SessionEntry[], now = Date.now()): UsageReport {
  const parent = create();
  const children = create();
  const seenChildren = new Map<string, { stableIdentity: boolean; signature: string }>();
  let childCount = 0;
  let childMetadata = false;
  let ambiguousDuplicate = false;

  for (const entry of branch) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      add(parent, entry.message.usage);
    }
    const results = subagentResults(childDetails(entry));
    if (!results) continue;
    childMetadata = true;
    for (const item of results) {
      if (!item || typeof item !== "object") {
        childCount++;
        markUsageMissing(children);
        continue;
      }
      const result = item as Record<string, unknown>;
      const signature = usageSignature(result);
      const sessionFile = typeof result.sessionFile === "string" ? result.sessionFile.trim() : "";
      const hasStableIdentity = sessionFile.length > 0;
      const identity = hasStableIdentity ? `session:${sessionFile}` : `value:${signature}`;
      const previous = seenChildren.get(identity);
      if (previous) {
        if (!hasStableIdentity || !previous.stableIdentity || previous.signature !== signature) ambiguousDuplicate = true;
        continue;
      }
      seenChildren.set(identity, { stableIdentity: hasStableIdentity, signature });
      childCount++;
      addChildUsage(children, result);
    }
  }

  // A recognized, empty subagent result is evidence that this supported source had no children.
  if (childMetadata && childCount === 0) {
    children.seen = true;
    for (const field of ALL_FIELDS) children.known.add(field);
  }

  const combined = create();
  combineInto(combined, parent);
  combineInto(combined, children);
  const unavailable = new Set<string>();
  const partial = new Set<string>();

  if (!parent.seen) {
    unavailable.add("parent.usage");
    markUsageMissing(combined);
  }
  if (!childMetadata) {
    unavailable.add("subagents.attribution");
    markUsageMissing(combined);
  } else if (childCount > 0 && !children.seen) {
    unavailable.add("subagents.usage");
    markUsageMissing(combined);
  }

  for (const [owner, acc] of [["parent", parent], ["subagents", children]] as const) {
    for (const field of acc.missing) partial.add(`${owner}.${field}`);
    for (const field of acc.uncertain) partial.add(`${owner}.${field}`);
  }
  if (ambiguousDuplicate) {
    partial.add("subagents.duplicateIdentity");
    partial.add("subagents.count");
    for (const field of ALL_FIELDS) combined.uncertain.add(field);
  }
  for (const item of unavailable) partial.delete(item);

  const parentReport = totals(parent);
  const subagentReport = totals(children);
  const totalReport = totals(combined);
  const unavailableList = [...unavailable].sort();
  const partialList = [...partial].sort();
  const collectedRows = collectRows(branch);
  const rows = collectedRows.ambiguousChildIdentity
    ? collectedRows.rows.map((row) => row.kind === "subagent" ? { ...row, calls: null } : row)
    : collectedRows.rows;
  const parentCalls = rows.reduce((sum, row) => sum + (row.kind === "parent" ? row.calls ?? 0 : 0), 0);
  const totalCalls = !childMetadata || ambiguousDuplicate || collectedRows.ambiguousChildIdentity
    ? null
    : parentCalls + childCount;
  return {
    estimate: true,
    sessionDurationMs: sessionDuration(branch, now),
    parent: parentReport,
    subagents: subagentReport,
    total: totalReport,
    rows,
    totalCalls,
    subagentCount: childMetadata && !ambiguousDuplicate ? childCount : null,
    complete: partialList.length === 0 && unavailableList.length === 0,
    unavailable: unavailableList,
    partial: partialList,
  };
}
