# Surface contract: session usage reporting

## Boundary, consumers, and ownership

`pi-ad-session-usage/` is a standalone Pi extension. Its model-callable `session_usage_report` tool reports usage from the active session branch for the orchestrator; it does not edit or publish pull requests. The extension owns aggregation, completeness labels, and presentation. Provider billing is outside this surface.

## Observable behavior

- The tool returns a human-readable summary followed by a JSON payload in model-visible content, plus a structured `details` object containing `parent`, `subagents`, and `total` usage, `subagentCount`, `complete`, and `partial` / `unavailable` paths.
- Parent usage is collected from assistant messages on the active branch. Recognized direct child records are collected from `pi-subagents` slash-result custom messages and `subagent` tool results, using foreground `results[].usage`, background `results[].modelAttempts[].usage`, or the reduced `results[].totalCost` fallback. These records are deduplicated by child session file when available, otherwise by their measured result signature. Conflicting or identity-ambiguous duplicates are counted once and marked partial. Unrecognized subagent sources are not inferred.
- Because persisted `pi-subagents` aggregates do not retain per-field provenance and can default omitted measurements to zero, positive child aggregates are reported as partial evidence and zero child fields are unavailable. Child values are never presented as exact branch measurements on this evidence alone.
- Token semantics match `/status`: prompt = input + cache-read + cache-write; cached = cache-read; uncached = input + cache-write; output = output; total = prompt + output; cache-hit rate = cache-read / prompt. Cache-hit rate is unavailable if its inputs are incomplete.
- Each token and cost metric is `{ value, complete }`; unavailable values are `null`. Totals are partial if parent usage or subagent attribution is unavailable. Overall `complete` is true only when no data paths are partial or unavailable. Ambiguous subagent counts are `null`.
- Cost uses only Pi-reported usage (`usage.cost.total` for parent messages, child attempt usage, or persisted `totalCost.costUsd`); no provider pricing is inferred. Values are USD estimates, not invoices. The visible summary labels them as estimates and renders missing or partial data explicitly rather than as an exact zero.
- After `agent_settled`, the extension sends a separate user-visible custom message (`display: true`, `triggerTurn: false`). It does not request another model turn.

## Failure and privacy behavior

Tool failures return a safe explanation with stable reference `PSU-TOOL-001` in text and structured details. Automatic summary failures attempt a visible safe message referencing `PSU-AUTO-001` without replacing the completed task result. Diagnostics are best-effort and log only operation, stable code, and a sanitized error class. Raw errors, stacks, credentials, and prompt payloads are not logged or exposed. Failure-message delivery is best-effort.

## Non-goals and limitations

- Provider invoice accuracy, external billing lookups, pricing inference, PR publishing, and model-generated summaries are not provided.
- Child usage may be absent or incomplete, especially for running/background work or providers that omit usage. The available aggregate schema cannot prove that zero means a measured zero; such child fields stay unavailable. The `totalCost` fallback retains only input/output token totals and cost, so cache categories remain unavailable.
- Parent/subagent classification covers only records on the active branch and recognized persisted result formats.

## Related contracts

- [Pi extension authoring](pi-extension-authoring.md)
