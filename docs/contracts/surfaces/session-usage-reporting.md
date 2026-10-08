# Surface contract: session usage reporting

## Boundary and ownership

`pi-ad-session-usage/` is a standalone extension resource in the `pi-plugins` package. It owns aggregation and presentation of Pi-recorded usage from the active session branch. Provider billing is outside this surface.

## Observable behavior

- The `/cost` extension command posts a deterministic, English-language custom message with `triggerTurn: false`. It does not start a model turn or append assistant commentary. No report is emitted automatically after a model run.
- The model-callable `session_usage_report` tool is available for an operator's cost/usage question. It returns the same active-branch aggregate, compact English report text plus report JSON in model-visible content, and a structured `details` object.
- The report starts with approximate session age from the first available user-message timestamp. It then shows rows grouped by parent provider/model/effort and by subagent name/model/effort, followed by a total row. Each row shows invocation count when attribution is unambiguous, `↑` input tokens, `↓` output tokens, `R` cache-read tokens, `W` cache-write tokens, `CH` cache-hit rate, Pi-recorded cost, and model/effort labels when known. Tokens use compact `k` notation; incomplete cost values are prefixed with `~`. A positive cost too small to survive six-decimal formatting is shown as `<$0.000001`, never as zero.
- A metric is `{ value, complete }`; unavailable values are `null`. The visible report uses `—` for unavailable token/cache/cost values, missing labels, or uncertain counts. Missing or ambiguous data is not fabricated as zero or attributed to an assumed model. A known empty recognized child-result source can establish zero child invocations; no recognized source or ambiguous duplicates leave invocation counts unknown.
- Token semantics match `/status`: prompt = input + cache-read + cache-write; cached = cache-read; uncached = input + cache-write; output = output; total = prompt + output; cache-hit rate = cache-read / prompt. Cache-hit rate is unavailable if its inputs are incomplete or prompt is zero.
- Parent usage comes from assistant messages in the active branch. Recognized child records include `pi-subagents` slash-result custom messages and `subagent` tool results, using foreground `results[].usage`, background `results[].modelAttempts[].usage`, or reduced `results[].totalCost` fallback. They also include the strict version-1 `subagent-async-usage` custom entry, whose `data` contains a stable top-level `runId` and result records with stable `resultId` plus only allowed attribution and available usage/cost fields. Invalid async entries are ignored and never reinterpreted as legacy result data.
- Async records deduplicate by stable run/result identity and overlapping session-file aliases. Reconciliation with legacy records is order-independent: accounting-relevant attribution and metrics identify overlap, validated async evidence is preferred, and legacy-only fields such as `task` and `modelAttempts` do not create false async/legacy conflicts. Legacy-only fallback identity retains its original task/attempt signature; conflicting snapshots sharing a stable legacy session identity, including differing model-attempt attribution, remain ambiguous. Duplicate evidence contributes once; ambiguous child metrics are collapsed into one unattributed group and child invocation counts are unavailable rather than assigned to an arbitrary model or agent.
- Async accounting entries represent completed runs; pending/running work without a terminal usage entry, absent records, and omitted metric fields remain unknown, not known zero. The extension reads the active session branch only; it does not scan result artifacts or unrelated sessions for usage. Other subagent sources are not inferred.
- Persisted child aggregates do not retain per-field provenance and may default omitted provider fields to zero. Positive child aggregates are partial evidence; zero child fields are unavailable, never assumed to be measured zero.
- Cost uses Pi-reported usage only (`usage.cost.total` for parent messages, child attempt usage, or persisted `totalCost.costUsd`). No provider pricing is inferred. Cost is an estimated USD amount, not an invoice.
- When `pi-ad-telegram` is loaded, the bridge forwards the text of a Telegram-originated `/cost` custom message to the invoking chat. TUI-only and unrelated reports are not forwarded. Telegram delivery remains best-effort and may duplicate if the Bot API accepted a send but the response was lost. A model-tool result follows normal assistant response routing.

## Failure and privacy behavior

Tool failures return a safe English explanation with stable reference `PSU-TOOL-001`; command failures use `PSU-CMD-001` and attempt a visible safe message without triggering a model turn. Diagnostics are best-effort and log only the operation, stable code, and sanitized error class. Raw errors, stacks, credentials, transcript content, and prompt payloads are not logged or exposed. Failure-message delivery is best-effort.

## Non-goals and limits

The extension does not provide invoice accuracy, external billing lookups, pricing inference, PR publishing, or model-generated `/cost` summaries. Child usage may be absent or incomplete, especially for running/background work or providers that omit usage. A reduced `totalCost` record retains input/output totals and cost only, so cache categories remain unavailable. Context-window occupancy is not shown because it cannot be meaningfully attributed to historical model rows. Classification covers only active-branch records in recognized result formats.

## Related contracts

- [Pi extension authoring](pi-extension-authoring.md)
- [Pi plugin package distribution](pi-plugin-distribution.md)
- [Telegram bridge](pi-ad-telegram.md)
