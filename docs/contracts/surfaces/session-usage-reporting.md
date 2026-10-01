# Surface contract: session usage reporting

## Boundary and ownership

`pi-ad-session-usage/` is a standalone extension resource in the `pi-plugins` package. Its `session_usage_report` tool reports measured usage from the active session branch; it does not publish or edit pull requests. The extension owns aggregation, completeness labels, and presentation. Provider billing is outside this surface.

## Observable behavior

- The tool returns a human-readable summary and JSON payload in model-visible content, plus a structured `details` object with `parent`, `subagents`, and `total` usage, `subagentCount`, `complete`, and `partial` / `unavailable` paths.
- Parent usage comes from assistant messages in the active branch. Recognized direct child records come from `pi-subagents` slash-result custom messages and `subagent` tool results, using foreground `results[].usage`, background `results[].modelAttempts[].usage`, or the reduced `results[].totalCost` fallback. Records are deduplicated by child session file when available, otherwise by measured result signature. Conflicting or identity-ambiguous duplicates count once and are marked partial. Other subagent sources are not inferred.
- Persisted child aggregates do not retain per-field provenance and may default omitted measurements to zero. Positive child aggregates are partial evidence; zero child fields are unavailable, never assumed to be measured zero.
- Token semantics match `/status`: prompt = input + cache-read + cache-write; cached = cache-read; uncached = input + cache-write; output = output; total = prompt + output; cache-hit rate = cache-read / prompt. The structured report exposes input and cache-write metrics separately as well. Cache-hit rate is unavailable when its inputs are incomplete.
- Each token and cost metric is `{ value, complete }`; unavailable values are `null`. Totals are partial if parent usage or subagent attribution is unavailable. Overall `complete` is true only when no data path is partial or unavailable. Ambiguous subagent counts are `null`.
- Cost uses Pi-reported usage only (`usage.cost.total` for parent messages, child attempt usage, or persisted `totalCost.costUsd`). No provider pricing is inferred. Cost is an estimated USD amount, not an invoice.
- After `agent_settled`, the extension sends a separate visible custom message with `triggerTurn: false`; it does not request another model turn. The detailed Russian summary has separate lines for prompt tokens (cached/uncached breakdown), output, total, cache-hit rate, estimated cost, and parent/subagent cost and count. Unavailable metrics are labeled “недоступно”; absent subagent data is not rendered as a measured zero. Exactly one closing note says the report includes only usage data Pi saved and that could be collected; no repeated “частично” marker or per-field diagnostic is added. Subagent aggregates may still omit fields, so totals can be understated. Cache-hit rate remains unavailable when its inputs are incomplete. The estimate-not-invoice qualification remains in documentation, not every automatic summary.
- When `pi-ad-telegram` is loaded, its bridge associates this visible report with the Telegram-originated run that generated it and forwards its text once to that run's originating/latest Telegram chat. TUI-only and unrelated reports are not forwarded. Telegram delivery remains best-effort and may duplicate if the Bot API accepted a send but the response was lost.

## Failure and privacy behavior

Tool failures return a safe explanation with stable reference `PSU-TOOL-001`. Automatic summary failures attempt a visible safe message with `PSU-AUTO-001` without replacing the completed task result. Diagnostics are best-effort and log only the operation, stable code, and sanitized error class. Raw errors, stacks, credentials, and prompt payloads are not logged or exposed. Failure-message delivery is best-effort.

## Non-goals and limits

The extension does not provide invoice accuracy, external billing lookups, pricing inference, PR publishing, or model-generated summaries. Child usage may be absent or incomplete, especially for running/background work or providers that omit usage. A reduced `totalCost` record retains input/output totals and cost only, so cache categories remain unavailable. Classification covers only active-branch records in recognized result formats.

## Related contracts

- [Pi extension authoring](pi-extension-authoring.md)
- [Pi plugin package distribution](pi-plugin-distribution.md)
