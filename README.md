# Pi plugins

Two small extensions for [Pi](https://github.com/earendil-works/pi). Everything runs on your machine: nothing is sent anywhere except what Pi already sends to your model.

| Extension | What it gives you |
|---|---|
| [`pi-ad-hooks`](pi-ad-hooks/README.md) | Add your own standing instructions to every request, or run your own script when something happens in Pi (a tool call, the end of a turn, and so on). |
| [`pi-ad-goal`](pi-ad-goal/README.md) | Give Pi a goal with `/goal <goal>` and let it keep working on its own, step after step, until the goal is done or a limit is reached. |
| [`pi-subagents`](https://www.npmjs.com/package/pi-subagents) | Third-party extension, installed with this package. Lets Pi hand work to helper agents (workers, reviewers). `pi-ad-goal` knows how to wait for them. |

The two own extensions are independent of each other.

## Install

Run:

```sh
pi install git:github.com/aadegtyarev/pi-plugins
```

This installs both extensions, the `goal-workflow` skill that teaches the model how to work toward a goal, and a pinned version of `pi-subagents` with its skills and prompts.

If `pi-subagents` is already installed on its own, remove it first, otherwise Pi loads two copies: run `pi list`, find the `npm:pi-subagents@…` entry, and pass that exact source to `pi remove` (for example `pi remove npm:pi-subagents@0.90.0`). The same goes for any separate copy or symlink of the other extensions.

Extensions run with the same permissions as Pi itself, so read the code before you install.

## For contributors

Run `npm install`, then:

- `npm test` — unit tests
- `npm run typecheck` — TypeScript check
- `npm run docs:check` — links and diagrams in the docs

Contribution rules are in [AGENTS.md](AGENTS.md). Precise behavior guarantees for each extension are in [`docs/contracts/surfaces/`](docs/contracts/surfaces/).
