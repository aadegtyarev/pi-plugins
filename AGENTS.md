# Project guidance

## Delegated coding work (`pi-subagents`)

- An async code-writing subagent can be inferred as `reviewed` even when the caller requests `checked`; weaker explicit acceptance does not lower the inferred level. That contract requires non-empty `testsAddedOrUpdated` evidence. Reporting that existing tests passed is not a substitute for adding or updating a test.
- For behavioral code changes, include a meaningful regression-test change in the worker task. Require the final `acceptance-report` to name the changed test path, commands run, validation output, residual risks, and staged-file status. Run the project's `npm test` and `npm run typecheck` as applicable.
- Do not add an artificial test just to satisfy the gate. If a task genuinely has no meaningful test (for example, documentation-only work), explicitly choose a suitable acceptance policy before launching the worker; use `level: "none"` only with a clear reason and when losing the automatic acceptance checks is intentional.
- For async/risky implementation work, plan an independent review when the resolved acceptance contract requires one. Treat a subagent's failed acceptance gate separately from failed tests or a failed implementation, and inspect the structured report/runtime check before deciding on a follow-up.

## Repository checks

- `npm test`
- `npm run typecheck`
- `git diff --check`
