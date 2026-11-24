---
name: goal-workflow
description: Manage one bounded Pi goal when the operator explicitly asks to start, inspect, pause, resume, finish, or stop a goal. For substantial work, suggest goal mode and wait for consent.
---

# Goal workflow

Use this skill for the goal extension's single active-branch goal. Use `goal_control` for operator-requested actions and `goal_update` to record progress, completion, or blockers.

## Consent and start

- Start only after an explicit operator request, such as `/goal <goal>` or “Start a goal: …”. A large-looking request is not consent.
- For substantial multi-step work, briefly suggest goal mode and wait for agreement.
- Pass the requested goal unchanged to `goal_control` or the `/goal` command. Confirm the start before proceeding.

## Manage the goal

- Use `goal_control` for clear operator requests to check status, pause, resume, complete, or stop. Do not report a state change until the tool confirms it; mark the goal done only when it is complete.
- `/goal resume [answer]` starts a fresh continuation cycle and resets continuations used to zero. `/goal limit <N|off|default>` changes the current goal's limit (default 40); N is a non-negative safe integer, `off` is unlimited, and `default` restores 40. These limit changes are available while the goal is active, paused, or blocked. Use `/goal status` to see continuations used and the limit.
- Use `goal_update` while doing active goal work. Mark blocked when user input is needed; do not present a blocked goal as complete.
- `/goal resume [answer]` adds the user's answer to the continuation context.
- Only one nonterminal goal is allowed on a branch. Check its status before starting another.

## Continuation and cancellation

- After a successful Pi run, an active goal can continue automatically up to its per-goal limit (40 by default; unlimited when configured `off`).
- A failed or aborted run pauses the goal. Reloading or navigating the session tree restores state but never starts background work.
- `/cancel` aborts the current Pi operation and pauses an interrupted goal. `/goal pause`, `/goal done`, and `/goal stop` prevent future continuations but do not cancel an in-flight operation.
- `/goal stop` closes the goal and frees its slot; it is not the same as cancelling the current run.
