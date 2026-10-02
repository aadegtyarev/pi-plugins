# Feature contract: bounded task continuation in `pi-ad-hooks`

**Status:** Complete; independent review approved and required local checks passed

## Goal

Add an opt-in, session-scoped task mode that continues a requested task after a completed agent run until the agent marks it done/blocked, the user pauses it, or a fixed continuation budget is exhausted.

## Scenarios

- `/task start <goal>` stores the goal and starts the initial agent turn. `/task status`, `/task pause`, `/task resume`, `/task done`, and `/task stop` provide explicit user control. Starting a replacement is rejected while the current task is nonterminal.
- While a task is active, `task_update` lets the agent record progress, mark the task done, or mark it blocked pending user input.
- At `agent_before_settle`, only a successfully completed run with an active task and remaining budget receives one hidden continuation message and `continue: true`. Each continuation count is persisted before the next request.
- A blocked/done/paused/stopped task, or a run that was aborted/errored, does not auto-continue. Abort/error pauses the task. The fixed maximum of 20 automatic continuations pauses the task and notifies the user rather than looping or spending indefinitely.
- Task state is persisted as extension-owned session entries and restored from the active session branch after reload/resume/tree navigation. Tasks in another session or branch are not accidentally resumed. Reload itself does not launch background work; an active task continues only after a new user/command turn begins.

## Non-goals

- Automatically applying task mode to every ordinary user prompt.
- Background workers, cross-session queues, scheduled execution, external notifications, or automatic retries of failed/uncertain operations.
- Replacing Pi's system/developer instructions or using `agent_end` to start a recursive event loop.

## Affected surface contracts

- [`docs/contracts/surfaces/pi-event-hooks.md`](../surfaces/pi-event-hooks.md)

## Interfaces and constraints

- Use Pi's public `agent_before_settle` boundary, which can append session entries and request one next provider call. Do not trigger continuations from `agent_end` or spawn detached work.
- Persist versioned, validated task state in a `pi-ad-hooks` custom session entry; do not log the task goal or progress note. Restore only from the current branch.
- Expose an agent tool only while a task is active when supported by the public tool API. Tool and command actions update persisted state before reporting success.
- The fixed 20-continuation budget is a safety invariant, not an unlimited setting. Users can pause/stop at any time; blocked tasks wait for explicit resume.
- Do not add a package, dependency, network service, or modify global extension settings. The existing globally loaded `pi-ad-hooks` entry point will provide the behavior after Pi reloads the extension.

## Acceptance and validation

- Tests prove start/status/pause/resume/done/stop behavior, task-tool state transitions, initial task dispatch, and persistence/restoration for the active session branch without cross-session leakage.
- Tests prove exactly one continuation is requested per eligible settle, while done/blocked/paused/aborted/error/exhausted tasks do not continue; the 20th continuation cap is enforced.
- Tests prove task state and hidden continuation messages use the expected custom entry types, and task text/progress is not written to diagnostics.
- Run `npm test`, `npm run typecheck`, `npm run docs:check`, and `git diff --check`.
