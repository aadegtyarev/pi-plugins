# Surface contract: bounded Pi tasks

## Boundary and ownership

`pi-ad-task/` is the standalone first-party Pi extension for one explicitly opted-in, bounded task per active session branch. It registers `/task`, model-callable task tools, branch restoration, and continuation at Pi's public agent settle event. It is included in the canonical `pi-plugins` package. Declarative hooks are separately owned by `pi-ad-hooks`.

## Inputs and behavior

- `/task <goal>` starts a task; `/task start <goal>` is an explicit form for goals beginning with reserved management words. `/task` with no arguments shows help. `/task status`, `pause`, `resume [answer]`, `done`, and `stop` inspect/control the task.
- A model-callable `task_control` tool carries out clear operator requests to start/status/pause/resume/done/stop. A start requires an explicit operator request; the assistant can suggest task mode for substantial scope but must wait for agreement. `task_update` records progress, done, or blocked states.
- Exactly one task may be nonterminal on a branch. A new start is refused until the current task is stopped or terminal. Task transitions are validated by the extension.
- After a completed run, an active task receives one hidden continuation. Failed/aborted runs pause it. At most 20 automatic continuations are allowed. Session load/tree navigation restores state but never starts background work.
- `/cancel` remains Pi's current-operation cancellation. An aborted active task is paused. `/task stop` closes the task and frees the single-task slot but does not cancel an in-flight Pi operation.

## Persistence and compatibility

Task state is stored in custom session entries and reconstructed from the active branch. Goals/progress remain model context. The version-1 entry schema, custom entry type `pi-ad-hooks-task`, and continuation message type `pi-ad-hooks-task-continuation` are retained across extraction so existing transcripts remain readable. Telegram-originated tasks persist a numeric private-chat ID solely for owner checks and result routing; it is not a credential.

## Telegram and failure behavior

`pi-ad-telegram` discovers `/task` through public Pi extension-command discovery and routes it to the registered handler. Telegram task tools/commands retain chat ownership protection; a natural-language tool action from Telegram is associated with the originating run chat and cannot inspect or control a task owned by another chat or TUI. Task-specific rejections explain a viable next action. Telegram task status/progress is not disclosed to another authorized chat.

## Security and non-goals

Task goals and progress are persisted locally and sent to the configured model as ordinary task context. No external task notifications or background workers are provided. The extension supports one task only: no multiple-task list, IDs, or switching. The skill may suggest task mode but may not autonomously start a task.

## Related contracts

- [Pi event hooks](pi-event-hooks.md)
- [Telegram bridge](pi-ad-telegram.md)
- [Pi plugin package distribution](pi-plugin-distribution.md)
- [Pi extension authoring](pi-extension-authoring.md)
