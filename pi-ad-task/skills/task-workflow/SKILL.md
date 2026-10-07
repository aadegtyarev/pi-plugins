---
name: task-workflow
description: Manage one bounded Pi task when the operator explicitly asks to start, inspect, pause, resume, finish, or stop a task. For substantial work, suggest task mode and wait for consent.
---

# Task workflow

Use this skill for the task extension's single active-branch task. Use `task_control` for operator-requested actions and `task_update` to record progress, completion, or blockers.

## Consent and start

- Start only after an explicit operator request, such as `/task <goal>` or “Start a task: …”. A large-looking request is not consent.
- For substantial multi-step work, briefly suggest task mode and wait for agreement.
- Pass the requested goal unchanged to `task_control` or the `/task` command. Confirm the start before proceeding.

## Manage the task

- Use `task_control` for clear operator requests to check status, pause, resume, complete, or stop. Do not report a state change until the tool confirms it; mark the task done only when its goal is complete.
- `/task resume [answer]` starts a fresh continuation cycle and resets continuations used to zero. `/task limit <N|off|default>` changes the current task's limit (default 40); N is a non-negative safe integer, `off` is unlimited, and `default` restores 40. These limit changes are available while the task is active, paused, or blocked. Use `/task status` to see continuations used and the limit.
- Use `task_update` while doing active task work. Mark blocked when user input is needed; do not present a blocked task as complete.
- `/task resume [answer]` adds the user's answer to the continuation context.
- Only one nonterminal task is allowed on a branch. Check its status before starting another.

## Continuation and cancellation

- After a successful Pi run, an active task can continue automatically up to its per-task limit (40 by default; unlimited when configured `off`).
- A failed or aborted run pauses the task. Reloading or navigating the session tree restores state but never starts background work.
- `/cancel` aborts the current Pi operation and pauses an interrupted task. `/task pause`, `/task done`, and `/task stop` prevent future continuations but do not cancel an in-flight operation.
- `/task stop` closes the task and frees its slot; it is not the same as cancelling the current run.
