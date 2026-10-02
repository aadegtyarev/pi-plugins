# pi-ad-session-usage

See what Pi recorded for the active session branch—without asking a model to explain the bill.

## Request a report

Install `pi-plugins` from the [root instructions](../README.md), then use:

- `/cost` for a deterministic visible report. It does not start a model turn.
- `session_usage_report` when the operator asks about usage or cost. The tool returns the same aggregate as compact text and structured metrics.

Nothing is reported automatically after a run.

```mermaid
flowchart LR
    Branch[Active session branch] --> Collect[Shared collector]
    Collect --> Group[Parent and subagent groups]
    Group --> Command[/cost]
    Group --> Tool[session_usage_report]
    Command --> Message[Visible report; no model turn]
    Tool --> Result[Compact text and structured metrics]
    Message -. Telegram /cost only .-> Chat[Invoking Telegram chat]
```

Rows group parent or subagent usage by model and effort. They show invocation counts, input (`↑`), output (`↓`), cache read (`R`), cache write (`W`), cache-hit rate (`CH`), and Pi-recorded cost. `—` means unavailable; `~` marks incomplete cost evidence. Tokens use compact `k` notation. Historical rows do not show live context-window occupancy.

## Limits

The extension uses only Pi-recorded data from the active branch; it does not query provider billing or infer prices. Cost is an estimate, not an invoice. Missing or ambiguous child data stays unknown or partial. The extension makes no network requests and does not publish or edit pull requests.

For exact token semantics, attribution rules, and failure behavior, see the [reporting contract](../docs/contracts/surfaces/session-usage-reporting.md). Run `npm test` and `npm run typecheck` after changing this extension.
