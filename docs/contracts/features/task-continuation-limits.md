# Feature contract: task continuation limits

**Status:** complete/implemented pending final verification

## Goal

Make the maximum automatic continuations configurable per task while retaining a safe default of 40. Let operators reset the continuation count when deliberately resuming work.

## Scenarios and edge cases

- Starting a task uses a limit of 40; automatic continuations stop when the per-task limit is reached.
- `/task resume [answer]` resets automatic continuations used to zero and begins a new continuation cycle, with the optional answer handled as the resume input.
- `/task limit <N>` sets a per-task continuation limit; `/task limit off` disables the limit; `/task limit default` restores 40.
- Limit changes are accepted for active, paused, and blocked tasks.
- Status reports continuations used and the configured limit, or `unlimited` when disabled.
- Existing persisted task states without a limit remain readable and behave as limit 40.

## Non-goals

- A global continuation-limit setting.
- Changes to task count, other task lifecycle transitions, or continuation behavior beyond the limits and resume reset specified here.

## Affected surfaces

- [Bounded Pi tasks](../surfaces/pi-ad-task.md)

## Interfaces and constraints

- Management interface: `/task limit <N|off|default>`; scope is the current branch task.
- `/task resume [answer]` starts a new automatic-continuation cycle by resetting its used count.
- Persist the per-task limit in branch task state. The default is 40; `off` represents unlimited; `default` restores 40.
- Preserve compatibility with older task states by interpreting a missing limit as 40.
- Status distinguishes a numeric limit from unlimited and includes the used count.

## Acceptance criteria

- New tasks default to 40 automatic continuations.
- Resume resets the used count and starts a new cycle.
- Limit set/off/default commands work for active, paused, and blocked tasks.
- Limit configuration persists with branch task state and status exposes used/limit or used/unlimited.
- Older states lacking the new field load with the default limit of 40.
- No global setting is introduced.

## Validation

- Add or update regression tests for defaulting, limit command behavior by task state, persistence/restoration, status output, and resume reset.
- Run `npm test`, `npm run typecheck`, `npm run docs:check`, and `git diff --check`.
