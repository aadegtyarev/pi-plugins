# Surface contract: authoring Pi extensions in this repository

## Boundary and ownership

This contract governs the executable Pi extensions in `pi-ad-telegram/`, `pi-ad-session-usage/`, `pi-ad-hooks/`, and `pi-ad-task/`. Each `index.ts` is the Pi-facing entry point and composition root. This contract covers extension implementation, not the design of Pi skills, prompts, themes, or MCP servers.

The `pi-plugins` package is the canonical distribution path. Its root manifest lists extension entry points; extension directories and extension-owned configuration/script paths use the `pi-ad-<name>` convention. See [package distribution](pi-plugin-distribution.md) for installation and legacy-path conflicts.

## Module boundaries

- Keep entry points focused on wiring, lifecycle coordination, and routing. Put substantial behavior in responsibility-specific modules with clear inputs and outputs.
- Add a module when a responsibility has independent behavior, state, or tests. Do not split trivial helpers or introduce a framework for hypothetical consumers.
- Inject external effects—network, filesystem, clocks/timers, and adapters—at boundaries that make behavior testable. Keep formatting, validation, and policy decisions independent of a live Pi process where practical.
- Keep provider-specific integration behind narrow adapters. Give each mutable queue, retry stream, timer, or message lifecycle one clear owner.

## Configuration and numeric values

- Parse environment variables and persisted settings once into a typed boundary. Validate values and report actionable errors. Keep secrets out of repository files, prompts, outbox records, and logs.
- Treat protocol/host limits as named constants with their source or rationale. Treat operator policy as named, typed settings with validated defaults, and document whether users can change them.
- Avoid scattered magic numbers and configuration sprawl. Keep invariants fixed and named; expose only settings users reasonably need to tune.
- Update affected contracts and tests when defaults or configuration semantics change.

## Lifecycle, compatibility, and failures

- Use public Pi APIs and host-provided packages. Do not bundle duplicate Pi runtime packages.
- Start long-lived work only from session lifecycle events or explicit operations, not module import or factory evaluation.
- Respect cancellation and session replacement. Make shutdown cleanup idempotent.
- Separate transient from permanent failures. Make retries and backoff named, testable, and documented when user-visible. Avoid unhandled rejections and secret-bearing diagnostics.
- Treat commands, tools, settings, persisted formats, and visible behavior as compatibility surfaces. Document and test behavior changes.
- Every operator-facing slash command in a first-party extension, except Telegram bridge lifecycle controls (`/telegram*`), must be available in the TUI and callable in Telegram when its extension is loaded and the Telegram bridge is enabled. Telegram use is limited to allow-listed users in private chats. Busy-session handling is command-specific: task status and lifecycle controls remain available without cancelling the current operation, task start/resume require an idle Pi session and Telegram bridge, and other generic extension commands are rejected rather than queued. Use unique Telegram-compatible names that do not collide with bot commands and account for Telegram's 100-command menu limit. Telegram-native bot commands and third-party extensions are outside this parity requirement; see [Telegram bridge](pi-ad-telegram.md) for name mapping and runtime constraints.

## Language and diagrams

- Write all extension-authored operator/model-facing messages, command and tool descriptions/help, bundled skills, and maintained project documentation in English. Preserve user-provided and configured text verbatim when it is passed through as data; this rule does not set the language of model-generated conversation.
- Use Mermaid diagrams in project documentation for architecture, lifecycle, or non-trivial data/control flows when they add information beyond adjacent prose. Base diagrams on verified implementation, identify relevant branches, and run `npm run docs:check`; do not add decorative diagrams to every reference page.

## Security and delivery

Extensions execute with the Pi process's operating-system permissions. Validate untrusted input, constrain authorization at boundaries, document file/network side effects, and persist only state required for recovery.

Use topic branches and pull requests; do not push directly to the default branch. Before merging, run the repository checks and obtain an independent read-only review.

## Tests and validation

Add regression tests for behavior changes. Use injected fakes rather than live network or real credentials. Cover cancellation, failures, authorization, persistence/restart, and compatibility where affected.

Run `npm test`, `npm run typecheck`, `npm run docs:check`, and `git diff --check`. Keep tests in root scripts and extension documentation aligned with source. Never commit credentials, Telegram inbox data, dependency folders, or local runtime state.

## Non-goals

- Mandating one architecture or module count for every extension.
- Exposing every invariant as a user setting.
- Adding speculative abstractions or compatibility layers without a real consumer.

## Related contracts

- [Telegram bridge](pi-ad-telegram.md)
- [Pi event hooks](pi-event-hooks.md)
- [Bounded Pi tasks](pi-ad-task.md)
- [Session usage reporting](session-usage-reporting.md)
- [Pi plugin package distribution](pi-plugin-distribution.md)
- [Contract lifecycle](../meta-contract.md)
