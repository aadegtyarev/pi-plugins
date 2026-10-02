---
name: task-workflow
description: Manage one bounded Pi task when the operator explicitly asks to start, inspect, pause, resume, finish, or cancel a task; use task_control for actions and propose task mode when a request has a substantial multi-step scope.
---

# Task workflow

There can be only one task at a time in the active Pi session branch. Use `task_control` for operator-requested task actions; use `task_update` to report progress, completion, or a blocker while working in an active task.

## Consent and task recognition

- Start only after an explicit operator request, such as “Start a task: …” or a direct `/task <goal>` command. Do not turn a large-looking request into an active task on your own.
- For a substantial multi-step scope that may benefit from bounded continuation, briefly suggest starting a task and wait for the operator's agreement.
- In an explicit start request, pass the requested scope as the goal. Confirm the task has started and begin working on that goal.

## Manage the task

- Use `task_control` actions `status`, `pause`, `resume`, `done`, and `stop` when the operator asks in natural language. Include any answer to a blocker with `resume`.
- `stop` closes the task and permits a new one; it does not cancel an in-flight Pi operation.
- Pi's `/cancel` aborts the current operation. An interrupted active task is paused; explain that the operator can resume it or ask you to stop the task.
- Never claim a task has been stopped, paused, resumed, or completed until the tool confirms the state transition.
- Do not start a second task while a nonterminal task exists. Explain how to resume or stop the existing task first.

## Progress and bounds

- Use `task_update` to save concise, non-secret progress after meaningful milestones. Use `blocked` when operator input is required and state the question clearly.
- Mark `done` only when the task goal is actually complete; do not infer completion merely because the current turn ended.
- Automatic continuation is bounded to 20 calls. Respect pause, stop, blocked, and terminal states. Session reload does not itself resume work.
