# Surface contract: authoring Pi extensions in this repository

## Boundary, consumers, and ownership

This contract governs executable Pi extensions maintained in this repository, currently centered on `pi-ad-telegram/`. It defines repository-level requirements for maintainers and delegated implementers. It is not a general contract for Pi skills, prompt templates, themes, MCP servers, or every package type.

An extension's `index.ts` is its Pi-facing entry point and composition root. It connects Pi lifecycle and public APIs to cohesive feature modules; it should not become the permanent home for unrelated business logic.

## Module boundaries and evolvability

- Organize each extension around cohesive responsibilities and stable seams. Examples in the Telegram extension include queue ownership, message rendering, persistent delivery, activity-board lifecycle, and provider-specific background adapters.
- Keep `index.ts` focused on wiring, lifecycle coordination, and routing. New substantial behavior belongs in a responsibility-specific module with an explicit input/output or transport interface, rather than further growth of one central handler.
- Inject external effects (Telegram/network, filesystem, clocks/timers, Pi adapters) at module boundaries where this makes behavior independently testable. Pure formatting, validation, and policy decisions should not require a live Pi process.
- Add a module when a responsibility has independent behavior, state, or tests. Do not split trivial helpers into files or introduce a generic plugin framework, registry, or abstraction for hypothetical future consumers.
- Keep provider-specific integration at adapter boundaries. Shared extension logic consumes a narrow normalized interface rather than importing provider internals throughout the core.
- State ownership and lifecycle must be clear: one module owns each mutable queue, retry stream, timer, or message lifecycle. Avoid duplicated state and hidden cross-module mutation.

## Configuration and numeric values

- Parse environment and persisted settings once into a typed configuration boundary; validate values and report invalid configuration clearly. Secrets such as tokens remain in environment/secret storage and must never be copied into repo files, outbox records, prompts, or logs.
- Classify every operational setting or numeric threshold as either:
  1. **Protocol/host constraint:** keep it as one named constant with a brief source/rationale; do not expose a knob that can violate the protocol.
  2. **Product/operator policy:** represent it as a named, typed setting with an explicit validated default and document whether/how users may override it.
- Do not scatter bare magic numbers, retry rules, capacities, timeouts, truncation limits, paths, or feature toggles through handlers. A literal is acceptable for an intrinsic algorithmic value only when its meaning is obvious or documented and it is not a product setting.
- Avoid configuration sprawl: expose values users reasonably need to tune; keep true invariants fixed and named.
- When defaults or configuration semantics change, update the affected surface contract and tests.

## Lifecycle, compatibility, and failure behavior

- Use public Pi extension APIs and declared host-provided packages; do not bundle duplicate copies of Pi runtime packages.
- Register commands, tools, and lifecycle handlers through the extension entry point. Start long-lived network activity, timers, and watchers only from session lifecycle or an explicit operation, not module import/factory evaluation.
- Respect `AbortSignal`, cancellation, and session replacement. Shutdown cleanup must be idempotent.
- Isolate transient failures from permanent errors; retry/backoff behavior must be named, testable, and documented where user-visible. Avoid unhandled promise rejections and log actionable errors without secrets.
- Treat command names, tool schemas, settings, persisted formats, and externally visible message behavior as compatibility surfaces. Make behavior changes explicit and update linked contracts.

## Security and data

Extensions execute with the Pi process's operating-system permissions. Validate untrusted input, constrain authorization at the boundary, avoid secret-bearing logs, and document file/network side effects. Persist only data required for recovery; use restrictive permissions for sensitive local state.

## Tests and validation

- Add meaningful regression tests for behavior changes; test module logic with injected fakes rather than live network or real credentials.
- Cover cancellation, transient/permanent failures, authorization boundaries, persistence/restart behavior, and compatibility cases when affected.
- For this repository run `npm test`, `npm run typecheck`, and `git diff --check`. Tests and source paths should be included in root scripts.
- Keep extension README setup and behavior aligned with implementation; do not commit credentials, inbox data, dependency folders, or local runtime state.

## Non-goals

- Mandating one architecture or a fixed number of modules for every extension.
- Turning every invariant into a user-facing option.
- Requiring speculative abstractions or backward-compatibility layers without an actual consumer.

## Related contracts

- [Telegram bridge](pi-ad-telegram.md)
- [Contract meta-rules](../meta-contract.md)
- [Authoring/Telegram contract task](../features/plugin-authoring-and-telegram-contracts.md)
