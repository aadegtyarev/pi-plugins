import type { ChildEvidenceRecord } from "./child-accounting-source.ts";
import { legacyChildSignature } from "./child-accounting-legacy.ts";

export interface ChildEvidenceIdentity {
  stable: boolean;
  aliases: string[];
  signature: string;
  legacySignature: string;
}

const recordValue = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const NUMBER_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "cost"] as const;

function metrics(result: Record<string, unknown>): Record<string, number> {
  const usage = recordValue(result.usage) ? result.usage : undefined;
  if (usage) {
    const values: Record<string, number> = {};
    for (const field of NUMBER_FIELDS) {
      const raw = field === "cost" && recordValue(usage.cost) ? usage.cost.total : usage[field];
      if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) values[field] = raw;
    }
    return values;
  }
  if (recordValue(result.totalCost)) {
    const cost = result.totalCost;
    return Object.fromEntries([
      ["input", cost.inputTokens], ["output", cost.outputTokens], ["cacheRead", cost.cacheReadTokens],
      ["cacheWrite", cost.cacheWriteTokens], ["cost", cost.costUsd],
    ].filter((item): item is [string, number] => typeof item[1] === "number" && Number.isFinite(item[1]) && item[1] >= 0));
  }
  if (Array.isArray(result.modelAttempts)) {
    const values: Record<string, number> = {};
    for (const attempt of result.modelAttempts) {
      if (!recordValue(attempt) || !recordValue(attempt.usage)) continue;
      for (const field of NUMBER_FIELDS) {
        const value = attempt.usage[field];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) values[field] = (values[field] ?? 0) + value;
      }
    }
    return values;
  }
  return {};
}

export function identityForChild(record: ChildEvidenceRecord): ChildEvidenceIdentity {
  const result = record.result ?? {};
  const sessionFile = typeof result.sessionFile === "string" ? result.sessionFile.trim() : "";
  const accountingIdentity = typeof result.accountingIdentity === "string" ? result.accountingIdentity : "";
  const aliases = [
    ...(sessionFile ? [`session:${sessionFile}`] : []),
    ...(accountingIdentity ? [`accounting:${accountingIdentity}`] : []),
  ];
  const attribution = ["agent", "provider", "model", "requestedModel", "thinking"]
    .map((key) => result[key] ?? null);
  return {
    stable: aliases.length > 0,
    aliases,
    signature: JSON.stringify([attribution, metrics(result)]),
    legacySignature: record.source === "legacy" ? legacyChildSignature(result) : "",
  };
}

export function conflictsWith(left: ChildEvidenceRecord, right: ChildEvidenceRecord): boolean {
  const leftResult = left.result ?? {};
  const rightResult = right.result ?? {};
  if (left.source === "legacy" && right.source === "legacy") {
    return legacyChildSignature(leftResult) !== legacyChildSignature(rightResult);
  }
  for (const key of ["agent", "provider", "model", "requestedModel", "thinking", "sessionFile"] as const) {
    if (leftResult[key] !== undefined && rightResult[key] !== undefined && leftResult[key] !== rightResult[key]) return true;
  }
  const leftMetrics = metrics(leftResult);
  const rightMetrics = metrics(rightResult);
  return Object.keys(leftMetrics).some((key) => rightMetrics[key] !== undefined && leftMetrics[key] !== rightMetrics[key]);
}
