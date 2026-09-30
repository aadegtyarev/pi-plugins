# Diagrams in repository documentation

Draw a diagram only when it explains real behavior more clearly than a list or paragraph. Suitable subjects include who connects to whom, event ordering, retry/fallback flows, a lifecycle state machine, or data relationships.

Do not use a diagram as a directory tree, a page outline, or a linear checklist. If covering the adjacent prose leaves the diagram with no information, remove it.

## Choose a Mermaid type

| Need | Type |
|---|---|
| Connections and direction | `flowchart LR` |
| Ordering, parallel work, retry, or fallback | `sequenceDiagram` with `alt` / `par` where useful |
| Lifecycle, loop, or state transition | `stateDiagram-v2` or `flowchart TD` with a back edge |
| Data entities and relationships | `erDiagram` |

Label edges with human-readable actions. Name participants by role, keep nodes concise, and show only paths that the implementation supports. Mark optional or error paths explicitly. Never invent a sequence to make a diagram look complete.

## GitHub rendering

GitHub renders Mermaid in Markdown. Keep colors optional and readable in both light and dark themes. Mermaid's default theme is usually safer than hard-coded node fills. If using `linkStyle`, count edges in declaration order from zero; a wrong index can make GitHub fail to render the diagram.

## Validation

`npm run docs:check` verifies fenced Mermaid blocks have a recognized diagram type and heuristically checks `linkStyle` indices in flowcharts. This is not a full Mermaid parser and does not prove that GitHub renders the result. For a new or materially changed diagram, inspect the rendered result in the PR after validation.
