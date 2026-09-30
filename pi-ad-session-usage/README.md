# pi-ad-session-usage

Reports token usage and Pi-estimated USD cost for the active session branch.

## Use

Install the repository package using the [root instructions](../README.md). The extension registers the model-callable `session_usage_report` tool and posts a separate visible summary after each settled run without starting another model turn.

The automatic summary uses compact usage notation: `↑` input, `↓` output, `R` cache-read, optional `W` cache-write, `CH` cache-hit rate, `Σ` total tokens, and estimated cost, followed by parent/subagent cost and count. A `?` marks a value whose completeness is uncertain; the next line explains why. Subagent aggregates may omit field-level completeness, so zero or absent values can mean “not reported,” and totals may be understated. Background fallbacks may retain only input/output and cost, without cache-read/write; in that case `CH` cannot be calculated. The structured tool result retains the full usage details. Cost uses only Pi-reported data; it is an estimate, not a provider invoice. The extension makes no network requests and does not publish or edit pull requests.

Run `npm test` and `npm run typecheck` from the repository root when changing the extension. See the [session usage surface contract](../docs/contracts/surfaces/session-usage-reporting.md) for field semantics, attribution limits, and failure behavior.
