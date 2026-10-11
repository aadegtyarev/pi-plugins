# Surface contract: bounded Pi tasks

## Boundary and ownership

`pi-ad-task/` is the standalone first-party Pi extension for one explicitly opted-in, bounded task per active session branch. It registers `/task`, model-callable task tools, branch restoration, and continuation at Pi's public agent settle event. It is included in the canonical `pi-plugins` package. Operator-facing help, command feedback, and tool-authored explanations are in English; goals, progress, and user replies remain user data and are preserved. Declarative hooks are separately owned by `pi-ad-hooks`.

## Inputs and behavior

- `/task <goal>` starts a task; `/task start <goal>` is an explicit form for goals beginning with reserved management words. `/task` with no arguments shows help. `/task status`, `pause`, `resume [answer]`, `limit <N|off|default>`, `done`, and `stop` inspect/control the task. Each task defaults to a limit of 40 automatic continuations; `off` makes it unlimited and `default` restores 40.
- A model-callable `task_control` tool carries out clear operator requests to start/status/pause/resume/done/stop. A start requires an explicit operator request; the assistant can suggest task mode for substantial scope but must wait for agreement. `task_update` records progress, done, or blocked states. The bundled task-workflow skill says to report state changes only after tool confirmation and to mark a task done only when its goal is complete.
- Exactly one task may be nonterminal on a branch. A new start is refused until the current task is stopped or terminal. Task transitions are validated by the extension.
- After a completed run, an active task receives one hidden continuation until its per-task limit is reached. Failed/aborted runs pause it. The default is 40; `off` disables the limit. `/task resume [answer]` resets continuations used to zero and begins a new continuation cycle. Session load/tree navigation restores state but never starts background work.
- Review rejection limit: within one task cycle (since start or the latest resume), after 2 reviewer verdicts requesting changes the next settle blocks the task, notifies the operator, and injects one final hidden instruction to stop delegating (no new/resumed/steered workers or reviewers, no PR open/merge) and report outstanding findings, per-round fixes, current state, active background runs, and options. A rejection is counted only from a completed async notice naming `**reviewer**` (single `Background task completed:`, batched `Background tasks completed (N):`, or `Detached foreground task completed:`) or from a top-level `subagent` tool result whose call targeted `agent: "reviewer"`; each reviewer result counts at most once (a grouped notice once per `N. reviewer` block; other agents' blocks are ignored), and it is a rejection when, at its first review heading carrying a verdict, `REQUEST_CHANGES` appears before any `APPROVE` within the following 400 characters. Failed runs, chain/parallel calls, assistant/user text, and status/transcript views are not counted (they can only delay the block; the continuation limit still applies). The branch count at cycle start is persisted as `reviewRejectionBaseline`; a legacy state without it starts counting at its next settle. In-flight subagent runs are not cancelled.
- `/cancel` remains Pi's current-operation cancellation. An aborted active task is paused. `/task stop` closes the task and frees the single-task slot but does not cancel an in-flight Pi operation.
- `/task status`, `pause`, `limit`, `done`, and `stop` may be used while a Pi or Telegram operation is in progress. Status is observational; pause/limit/done/stop affect task state and future continuation only. Their feedback must make clear when the current operation continues. In particular, while an operation is busy, `/task stop` must tell the operator to wait before starting another task. Slash-command `/task start` and `/task resume` require an idle session and are rejected rather than queued; `/cancel` is the way to abort current Pi work. A `task_control` tool call made during the current run is not a separate queued slash command and retains its explicit-operator-consent rule.

## Persistence and compatibility

Task state, including its per-task continuation limit, is stored in custom session entries and reconstructed from the active branch. A missing limit in an older state defaults to 40; numeric limits and `off` (unlimited) persist per task. Status reports continuations used and the configured numeric limit or `unlimited`. Goals/progress remain model context. The version-1 entry schema, custom entry type `pi-ad-hooks-task`, and continuation message type `pi-ad-hooks-task-continuation` are retained across extraction so existing transcripts remain readable. Telegram-originated tasks persist a numeric private-chat ID solely for owner checks and result routing; it is not a credential.

## Telegram and failure behavior

`pi-ad-telegram` discovers `/task` through public Pi extension-command discovery and routes it to the registered handler. Telegram task tools/commands retain chat ownership protection; a natural-language tool action from Telegram is associated with the originating run chat and cannot inspect or control a task owned by another chat or TUI. For a Telegram-owned task, the persisted owner route is restored for automatic continuations and explicit TUI resumption so the final assistant response reaches the owner chat; it is cleared after the run settles. TUI-only tasks and unrelated TUI runs remain private. Task-specific rejections explain a viable next action. Telegram task status/progress is not disclosed to another authorized chat.

## Security and non-goals

Task goals and progress are persisted locally and sent to the configured model as ordinary task context. No external task notifications or background workers are provided. The extension supports one task only: no multiple-task list, IDs, or switching. The skill may suggest task mode but may not autonomously start a task.

## Related contracts

- [Pi event hooks](pi-event-hooks.md)
- [Telegram bridge](pi-ad-telegram.md)
- [Pi plugin package distribution](pi-plugin-distribution.md)
- [Pi extension authoring](pi-extension-authoring.md)
