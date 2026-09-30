---
name: repo-docs
description: "Write, rewrite, and review documentation shipped with a repository: READMEs, guides, references, and contracts. Use when asked to improve repository docs, explain implemented behavior, organize pages, add diagrams, or check documentation accuracy and links. Read the source before writing and preserve documented limits. Not for code comments, docstrings, design plans for unimplemented features, commit messages, or PR descriptions."
---

# Repository documentation

Use this skill for documentation that ships with code. In this repository that includes the root README, extension READMEs, `docs/`, `AGENTS.md`, and contract files. Do not treat generated files, dependency directories, user settings, or runtime data as documentation.

## Workflow

1. **Read the implementation first.** Inspect the entry point, configuration parser, types, tests, and relevant public APIs. Treat current surface contracts as normative constraints, not as a substitute for checking the source.
2. **Inventory maintained pages.** Use `git ls-files '*.md'` and inspect untracked documentation relevant to the task. Before renaming or deleting a page, search source and docs for links to it.
3. **Agree scope before writing.** Follow the repository's contract workflow in `AGENTS.md` and `docs/contracts/meta-contract.md`. Do not create a feature contract or plan implementation before approval. Update durable surface contracts when observable behavior or an interface changes; remove completed temporary feature contracts only after verification.
4. **Choose pages by reader task.** Use the forms in `references/page-shapes.md`: tutorial, how-to, reference, or explanation. A README is an entry point, not a copy of every detail.
5. **Draft from verified facts.** Commands, paths, defaults, event names, error behavior, and example output must come from source or a real run. Never invent output. Move rationale out of step-by-step instructions, but do not change its meaning.
6. **Keep the repository's language.** Existing project pages are in English; keep them in English unless the user asks for another language. Use the language requested for the conversation and reports.
7. **Use diagrams only when they explain a real mechanism.** See `references/diagrams.md`. A diagram must add information that prose or a list does not convey.
8. **Edit for plain language.** Use `references/anti-slop.md` during the editing pass. Keep caveats, security warnings, failure modes, and explicit non-goals even when they complicate the prose.
9. **Run the documentation checker.** From this repository root, run `npm run docs:check`. It checks local Markdown links and heading anchors, fenced blocks, a subset of Mermaid structure and `linkStyle` bounds, references to missing `docs/*.md` pages from source, and dash-density warnings. It does not fetch external links or replace a real Mermaid renderer or human review.
10. **Run relevant project validation.** If source, tests, or package metadata changed, run the checks required by `AGENTS.md`. Review the final diff and obtain the required independent read-only review.

## Page structure

Keep README pages at or below 150 lines where practical. A README should identify the project, give the shortest safe first-use path, state requirements, link to task-specific references, and show contributor checks. Move a repeatedly consulted settings list or command catalogue into a reference page when that improves navigation. Do not add pages merely to make every extension look symmetrical.

For this repository, root installation belongs in the root README and `docs/contracts/surfaces/pi-plugin-distribution.md`. Extension-specific setup and behavior belong beside the extension. Surface contracts define current promises and constraints; do not duplicate them verbatim into user guides.

## Hard rules

- Do not carry claims from old documentation forward without checking them against current code.
- Do not quietly remove a limitation, security warning, compatibility note, or incomplete-data label.
- Do not turn implementation details into user guarantees unless the code and contract support them.
- Do not include secrets, raw prompts, or sensitive local paths in examples.
- Do not install or execute commands shown in documentation merely to reproduce sample output without authorization.
- Do not rewrite the meta-contract's process requirements as part of a prose cleanup.
- Follow the repository's branch and PR rules. Do not publish docs or change user-global Pi configuration.

## Review checklist

- [ ] Every factual claim was checked against current source or an actual run.
- [ ] Setup steps work from a clean, supported environment and name prerequisites.
- [ ] Internal links, anchors, code fences, and diagrams were checked.
- [ ] Security, privacy, failure, compatibility, and non-goal sections remain accurate.
- [ ] README pages point to the right next page and stay concise.
- [ ] The final diff passes the repository's checks and independent review.

## References

- `references/page-shapes.md` — choose and outline pages by reader task.
- `references/diagrams.md` — select and validate useful Mermaid diagrams.
- `references/anti-slop.md` — prose editing checklist, including English and Russian examples.
- `scripts/check_docs.py` — local Markdown consistency checker. Run through `npm run docs:check`.

## Attribution

Adapted from [`repo-docs`](https://github.com/aadegtyarev/ad-claude-marketplace/tree/main/plugins/repo-docs), distributed under the MIT License. See `LICENSE` in this skill directory.
