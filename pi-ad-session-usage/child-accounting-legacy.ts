export function legacyChildSignature(result: Record<string, unknown>): string {
  const usage = result.usage as Record<string, unknown> | undefined;
  const totalCost = result.totalCost as Record<string, unknown> | undefined;
  const attempts = Array.isArray(result.modelAttempts)
    ? result.modelAttempts.map((attempt) => {
      if (!attempt || typeof attempt !== "object") return null;
      const record = attempt as Record<string, unknown>;
      const attemptUsage = record.usage as Record<string, unknown> | undefined;
      return [record.model, record.requestedModel, record.provider, record.thinking ?? record.effort,
        attemptUsage?.input, attemptUsage?.output, attemptUsage?.cacheRead, attemptUsage?.cacheWrite, attemptUsage?.cost];
    })
    : null;
  return JSON.stringify([
    result.sessionFile, result.agent, result.task, result.provider, result.model, result.requestedModel, result.thinking,
    usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite, usage?.cost,
    totalCost?.inputTokens, totalCost?.outputTokens, totalCost?.costUsd, attempts,
  ]);
}
