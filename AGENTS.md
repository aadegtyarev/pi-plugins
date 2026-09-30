# Project guidance

## Repository checks

- Add meaningful regression tests for behavioral changes.
- `npm test`
- `npm run typecheck`
- `git diff --check`

## Project structure

- `pi-ad-telegram/` contains the Telegram bridge extension; `index.ts` is its entry point and `background-adapters/` contains provider-specific lifecycle adapters.
- Root `package.json` defines the extension's test and typecheck commands.

<!-- BEGIN ad-pi-addons contract workflow -->
## Contracts and feature work
- Read `docs/contracts/meta-contract.md` before implementing or reviewing a feature.
- Before implementation, agree on and save the approved feature contract under `docs/contracts/features/`; identify and read affected `docs/contracts/surfaces/` contracts.
- Give the exact contract paths to the planner, implementer, and reviewer. If working directly, use the same contracts as the source of truth.
- If implementation reveals a changed surface or acceptance scope, stop and get approval before proceeding. After verification, update affected surface contracts, mark the feature contract complete for final verification, then delete the temporary feature-contract file.
- Preserve existing instructions and surface contracts; never overwrite or delete them silently. Feature contracts are temporary task artifacts and must not remain after verified completion.
- Use available subagent roles only when configured. If roles or skills are unavailable, work directly from the same contracts and checks, and state any unavailable independent review.
- End every task with a concise user-facing report of what changed, checks and outcomes, and remaining risks or blockers. Do not finish with tool output alone or end silently; this rule requires no installed skills.
<!-- END ad-pi-addons contract workflow -->
