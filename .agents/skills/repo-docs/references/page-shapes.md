# Page shapes

Use this reference before drafting. Choose pages by what readers are trying to do, not by a fixed file count.

## Choose the page type

| Reader's task | Page form | Keep out |
|---|---|---|
| Learn a workflow from zero | Tutorial: one verified path to a result | Alternative branches and reference catalogues |
| Complete a specific task | How-to: goal or symptom, then steps | Long rationale and unrelated options |
| Look up supported values | Reference: complete, ordered tables | Advice and extended narrative |
| Understand design or behavior | Explanation: mechanism, constraints, trade-offs | Copy-paste setup walkthroughs |
| Change the code safely | Contributor guide: module map, invariants, tests | User setup instructions |

A small project may need only a README and a reference. Add a page when an existing section is hard to scan or serves a different reader task. Do not split pages just to create a symmetrical tree.

## README: the entry point

Aim for 150 lines or fewer. In this repository, include:

1. One sentence describing the extension's user-visible result.
2. A short explanation of how it connects to Pi.
3. The shortest safe setup path and prerequisites.
4. A map to configuration, command, security, or behavior references.
5. Contributor checks and the applicable license.

Do not put the complete event catalogue, long settings tables, internal rationale, or repeated warnings in every README. Keep a short warning at the point of action and link to the complete explanation.

## Tutorial: a verified path

State the result at the top. List prerequisites, use one set of example names throughout, and finish each stage with a check and expected result taken from source or a real run. If a step needs several alternatives, it is probably a how-to instead.

## How-to: one concrete task

Use a title phrased as the reader's task. Keep steps actionable and ordered. Troubleshooting should start with a symptom the reader recognizes, then show a safe diagnostic and the corresponding fix.

## Reference: predictable lookup

Use a table of contents for long pages, ordered tables for settings and commands, and state defaults and units. Include all supported values when the page claims to be complete. Link to upstream Pi semantics where Pi, rather than this extension, defines the behavior.

## Explanation and contributor guide

Explain the flow before naming modules. Use diagrams only for non-obvious direction, ordering, state, or data shape. State which guarantees come from this repository and which are inherited from Pi or a provider. Contributor pages should identify ownership boundaries and tests that protect them.
