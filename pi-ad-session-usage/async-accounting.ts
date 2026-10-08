export const ASYNC_USAGE_ACCOUNTING_ENTRY_TYPE = "subagent-async-usage";

export interface AsyncAccountingResult {
	accountingIdentity: string;
	agent?: string;
	provider?: string;
	model?: string;
	requestedModel?: string;
	thinking?: string | boolean;
	sessionFile?: string;
	usage?: Record<string, number>;
	totalCost?: Record<string, number>;
}

export interface AsyncAccountingEnvelope {
	runId: string;
	results: AsyncAccountingResult[];
}

const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"] as const;
const TOTAL_COST_FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"] as const;
const RESULT_FIELDS = new Set(["resultId", "agent", "provider", "model", "requestedModel", "thinking", "sessionFile", "usage", "totalCost"]);

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strictMetrics(value: unknown, fields: readonly string[]): Record<string, number> | undefined | false {
	if (!record(value) || Object.keys(value).some((key) => !fields.includes(key))) return false;
	const metrics: Record<string, number> = {};
	for (const [key, field] of Object.entries(value)) {
		if (typeof field !== "number" || !Number.isFinite(field) || field < 0) return false;
		metrics[key] = field;
	}
	return Object.keys(metrics).length ? metrics : false;
}

/** Accept only the producer's sanitized, versioned custom-entry payload. */
export function parseAsyncAccountingEnvelope(value: unknown): AsyncAccountingEnvelope | undefined {
	if (!record(value) || Object.keys(value).some((key) => !["version", "runId", "results"].includes(key))
		|| value.version !== 1 || typeof value.runId !== "string" || !value.runId.trim() || !Array.isArray(value.results)) return undefined;
	const results: AsyncAccountingResult[] = [];
	for (const item of value.results) {
		if (!record(item) || Object.keys(item).some((key) => !RESULT_FIELDS.has(key))
			|| typeof item.resultId !== "string" || !item.resultId.trim()) return undefined;
		const usage = item.usage === undefined ? undefined : strictMetrics(item.usage, USAGE_FIELDS);
		const totalCost = item.totalCost === undefined ? undefined : strictMetrics(item.totalCost, TOTAL_COST_FIELDS);
		if (usage === false || totalCost === false || (!usage && !totalCost)) return undefined;
		for (const key of ["agent", "provider", "model", "requestedModel", "sessionFile"] as const) {
			if (item[key] !== undefined && typeof item[key] !== "string") return undefined;
		}
		if (item.thinking !== undefined && typeof item.thinking !== "string" && typeof item.thinking !== "boolean") return undefined;
		results.push({
			accountingIdentity: JSON.stringify([value.runId, item.resultId]),
			...(typeof item.agent === "string" ? { agent: item.agent } : {}),
			...(typeof item.provider === "string" ? { provider: item.provider } : {}),
			...(typeof item.model === "string" ? { model: item.model } : {}),
			...(typeof item.requestedModel === "string" ? { requestedModel: item.requestedModel } : {}),
			...(typeof item.thinking === "string" || typeof item.thinking === "boolean" ? { thinking: item.thinking } : {}),
			...(typeof item.sessionFile === "string" ? { sessionFile: item.sessionFile } : {}),
			...(usage ? { usage } : {}),
			...(totalCost ? { totalCost } : {}),
		});
	}
	return results.length ? { runId: value.runId, results } : undefined;
}
