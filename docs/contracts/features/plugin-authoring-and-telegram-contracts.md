# Feature contract: plugin authoring and Telegram surfaces

- **Status:** implementing
- **Approved:** 2026-09-29
- **Goal:** Record durable contracts for authoring Pi extensions in this repository and for the existing `pi-ad-telegram` surface, then commit the accumulated requested work and publish the repository to a private MIT-licensed GitHub remote.
- **Affected surfaces:** [Pi extension authoring](../surfaces/pi-extension-authoring.md) and [Telegram bridge](../surfaces/pi-ad-telegram.md), both introduced by this task.

## Expected outcomes

1. The extension-authoring contract describes module boundaries that support incremental development without speculative frameworks, and gives explicit rules for typed configuration, named defaults, protocol constants, tests, lifecycle, security, and public behavior.
2. The Telegram surface contract accurately documents current runtime behavior, inputs, settings and fixed limits, errors/retries, security, and known delivery limitations. It distinguishes user-configurable settings from current hard-coded policy values slated for later review.
3. Documentation and contracts do not themselves refactor the Telegram runtime.
4. Commit the accumulated requested Telegram implementation and its tests separately from repository-preparation and contract/license documentation, keeping generated dependencies and local data out of commits.
5. Add a standard MIT `LICENSE`, create `github.com/aadegtyarev/pi-plugins` as a private repository, configure it as `origin`, and push the resulting commits.

## Non-goals

- Refactoring the Telegram extension or introducing new runtime settings in this task.
- Adding typing indicators or updating a status/activity bubble with a time-only timestamp. These are intended for a later, separately contracted refactor after the private remote is created.
- Changing the installed Pi extension symlink or credentials.

## Interfaces and constraints

- Repository: `github.com/aadegtyarev/pi-plugins`, private, MIT.
- Documentation path: `docs/contracts/`; semantic lowercase kebab-case filenames.
- Existing working-tree Telegram changes are user-requested and should be included in the code commit. Preserve them and keep `.telegram-inbox/` and `node_modules/` out of commits.
- The current repository has no configured remote; publication is authorized only to the private remote above.

## Acceptance criteria

- Both surface contracts are precise and consistent with the inspected source, README, and current settings.
- The authoring contract distinguishes application/operator configuration from protocol-defined limits and requires modular, testable seams without requiring abstractions for hypothetical needs.
- The Telegram contract clearly identifies values currently hard-coded in code as current behavior, not as a promise that they are configurable.
- `npm test`, `npm run typecheck`, and `git diff --check` pass before commit.
- A read-only reviewer reports no unresolved actionable contract/diff findings.
- The repo has two logical commits (Telegram code/tests; repo preparation/contracts/license), the GitHub remote is private, `origin` is configured, and pushed history matches the current local branch.
- The working tree is clean after push.

## Validation

- Run `npm test`, `npm run typecheck`, and `git diff --check`.
- Review both contracts against current source and README.
- Verify remote visibility, `origin`, and pushed commit SHA.
- Verify final Git status is clean and no token, inbox, or dependency artifacts were committed.
