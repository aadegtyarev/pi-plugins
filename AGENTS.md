# Project guidance

## Repository checks

- Add meaningful regression tests for behavioral changes.
- `npm test`
- `npm run typecheck`
- `npm run docs:check`
- `git diff --check`

## Project structure

- `pi-ad-telegram/`, `pi-ad-session-usage/`, and `pi-ad-hooks/` are the first-party extensions; their entry points are declared in the root Pi package manifest.
- `.agents/skills/repo-docs/` contains the project documentation skill and its checker.
- Root `package.json` defines the extension tests, typecheck, and documentation checks.

## Extension naming and Git workflow
- Name each first-party Pi extension directory `pi-ad-<name>`; keep extension-owned configuration/script paths consistent with that prefix. Distribute extensions through the root `pi-plugins` package manifest; do not add a parallel bundled copy to another repository.
- Make repository changes on a topic branch and deliver them through a pull request. Do not commit or push directly to the default branch. Run the repository checks and obtain a read-only review before merging through the PR.

<!-- BEGIN ad-pi-addons contract workflow -->
## Contracts and feature work
- Read `docs/contracts/meta-contract.md` before implementing or reviewing a feature.
- Before implementation, agree on and save the approved feature contract under `docs/contracts/features/`; identify and read affected `docs/contracts/surfaces/` contracts.
- Give the exact contract paths to the planner, implementer, and reviewer. If working directly, use the same contracts as the source of truth.
- If implementation reveals a changed surface or acceptance scope, stop and get approval before proceeding. After verification, update affected surface contracts, mark the feature contract complete for final verification, then delete the temporary feature-contract file.
- Preserve existing instructions and surface contracts; never overwrite or delete them silently. Feature contracts are temporary task artifacts and must not remain after verified completion.
- Use available subagent roles only when configured. For nontrivial codebase or documentation reconnaissance, delegate bounded, read-only investigation to a suitable configured role when available; request relevant source paths and concise evidence, not whole-document dumps. Keep trivial lookups direct. The parent owns scope, decisions, synthesis, verification, and user communication. If no suitable role is available, work directly from the same contracts and checks, and state if independent review cannot be obtained. This rule does not require named Pi skills.
- End every task with a concise user-facing report of what changed, checks and outcomes, and remaining risks or blockers. Do not finish with tool output alone or end silently; this rule requires no installed skills.
<!-- END ad-pi-addons contract workflow -->
