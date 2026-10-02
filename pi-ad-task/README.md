# pi-ad-task

Standalone Pi extension for one explicitly opted-in, bounded task per active session branch. It registers `/task`, model-callable task controls, and at most 20 automatic continuations. Task state follows the active branch and does not restart work in the background after reload.

## Commands

- `/task <goal>` starts a task; `/task start <goal>` is an explicit equivalent.
- `/task status`, `/task pause`, `/task resume [answer]`, `/task done`, `/task stop` inspect or manage it.
- `/cancel` stops the current Pi operation; an interrupted active task is paused. `/task stop` closes the task without cancelling an in-flight operation.

The model can also use `task_control` to carry out clear operator requests. It may suggest task mode for substantial scope, but must wait for the operator's agreement before starting. See the bundled [`task-workflow` skill](skills/task-workflow/SKILL.md).

Task goals/progress are persisted in the local session transcript and sent to the configured model as normal context. There are no background workers or external notifications. Telegram integrations should use the command and tool registrations exposed by this extension; the task's originating private-chat ID is retained for ownership checks when started from Telegram.
