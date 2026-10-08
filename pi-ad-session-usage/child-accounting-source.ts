import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { ASYNC_USAGE_ACCOUNTING_ENTRY_TYPE, parseAsyncAccountingEnvelope } from "./async-accounting.ts";

export type ChildEvidenceSource = "async" | "legacy";
export interface ChildEvidenceRecord {
  result: Record<string, unknown> | undefined;
  source: ChildEvidenceSource;
}
export interface ChildEvidenceBatch {
  recognized: boolean;
  records: ChildEvidenceRecord[];
}

function legacyResults(details: unknown): unknown[] | undefined {
  if (!details || typeof details !== "object") return undefined;
  const record = details as { mode?: unknown; results?: unknown };
  return typeof record.mode === "string" && Array.isArray(record.results) ? record.results : undefined;
}

function legacyDetails(entry: SessionEntry): unknown {
  if (entry.type === "custom_message" && entry.customType === "subagent-slash-result") {
    const details = entry.details;
    if (details && typeof details === "object" && "result" in details) return (details as { result?: { details?: unknown } }).result?.details;
  }
  if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "subagent") return entry.message.details;
  return undefined;
}

export function childEvidenceForEntry(entry: SessionEntry): ChildEvidenceBatch {
  if (entry.type === "custom") {
    if (entry.customType !== ASYNC_USAGE_ACCOUNTING_ENTRY_TYPE) return { recognized: false, records: [] };
    const envelope = parseAsyncAccountingEnvelope(entry.data);
    return envelope
      ? { recognized: true, records: envelope.results.map((result) => ({ result: result as unknown as Record<string, unknown>, source: "async" })) }
      : { recognized: false, records: [] };
  }
  const results = legacyResults(legacyDetails(entry));
  return results
    ? { recognized: true, records: results.map((result) => ({ result: result && typeof result === "object" ? result as Record<string, unknown> : undefined, source: "legacy" })) }
    : { recognized: false, records: [] };
}
