# Feature contract: async subagent usage accounting

- Status: complete/implemented; pending final verification
- Scope: cross-repository contract for `pi-subagents` producer and `pi-ad-session-usage` consumer.

## Goal

Make completed asynchronous `pi-subagents` work visible in `pi-ad-session-usage` reports from the active parent session branch, without scanning unrelated artifacts or counting usage more than once.

## Scenarios and behavior

- On async child completion, the producer persists a usage-bearing result into the active parent session branch. The result preserves stable run identity and the model, token, cache, and cost usage available from the completion envelope.
- The consumer recognizes the async completion and includes its usage in `/cost` and the session usage report. Re-reading or encountering the same run through recognized records must contribute exactly once.
- Pending/running work has unknown usage; absence of a completion record is not known zero and must not be reported as a measured zero.
- Existing foreground child results and existing persisted result formats remain compatible and continue to be accounted for as before.
- Regression coverage uses a sanitized real completion-envelope shape, not a fabricated reduced fixture that omits relevant envelope structure.

## Non-goals

- Global filesystem/artifact discovery or scanning outside the active parent session branch.
- Provider billing or inferred pricing, new reporting surfaces, or changes to foreground result semantics.
- Treating pending, missing, or incomplete usage as measured zero.

## Affected surfaces

- Consumer surface: [session usage reporting](../surfaces/session-usage-reporting.md) in `pi-plugins` (`pi-ad-session-usage`).
- Producer: `pi-subagents` async completion/result persistence in `/home/adegtyarev/.pi/agent/worktrees/pi-subagents-session-usage`. That repository has no `docs/contracts/meta-contract.md`; this approved cross-repository feature contract is the shared source of truth for this change. `pi-subagents` `VISION.md` remains its acceptance policy.

## Interfaces and constraints

- The producer must preserve a stable run identity sufficient for consumer deduplication, together with available model attribution and token/cache/cost metrics.
- Usage-bearing completion data is persisted in the active parent branch in a form the consumer can recognize; do not require a global artifact scan.
- Preserve compatibility with existing foreground and persisted result formats. Keep missing/incomplete metric values unknown rather than fabricating zero.
- Keep persisted completion data and regression fixtures sanitized: no credentials, private transcript content, or prompt payloads.

## Acceptance criteria

- A newly completed async child with usage appears in `/cost` from the active parent branch.
- Repeated or overlapping recognized records for one run do not duplicate invocation or metric totals; distinct runs remain distinct.
- Pending work and unavailable usage are not represented as known-zero usage.
- Foreground results and existing persisted formats remain covered and compatible.
- A sanitized real-envelope regression test proves the async completion path, identity, usage extraction, and deduplication.
- Changes pass relevant checks and read-only reviews in both repositories; deliver as two PRs and verify the consumer with the producer change installed.

## Validation and delivery

Run relevant `pi-subagents` producer tests/typecheck and `pi-plugins` `npm test`, `npm run typecheck`, `npm run docs:check`, and `git diff --check`. Obtain read-only review for both PRs, install the producer change when validating the consumer, and confirm `/cost` behavior and no duplicates before completion.
