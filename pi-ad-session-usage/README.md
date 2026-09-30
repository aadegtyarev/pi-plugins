# pi-ad-session-usage

Reports token usage and Pi-estimated USD cost for the active session branch.

## Use

Install the repository package using the [root instructions](../README.md). The extension registers the model-callable `session_usage_report` tool and posts a separate visible summary after each settled run without starting another model turn.

The report separates parent usage from recognized direct subagent results. Missing or incomplete measurements are labeled partial or unavailable, never silently converted to zero. Cost uses only Pi-reported data; it is an estimate, not a provider invoice. The extension makes no network requests and does not publish or edit pull requests.

Run `npm test` and `npm run typecheck` from the repository root when changing the extension. See the [session usage surface contract](../docs/contracts/surfaces/session-usage-reporting.md) for field semantics, attribution limits, and failure behavior.
