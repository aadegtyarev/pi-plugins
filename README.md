# Pi plugins

Four first-party Pi extensions, distributed together as a Git package: a Telegram bridge, session-usage reporting, event hooks, and bounded task continuation.

## Install

The repository is private. Make sure GitHub access is configured, then run:

```sh
pi install git:github.com/aadegtyarev/pi-plugins
```

The package exposes all four extensions. If any are already loaded from standalone files or symlinks, resolve that duplicate before installing the package. Do not remove an existing extension path until you have confirmed what it points to.

Extensions run with the permissions of the Pi process. Review the source and the security notes for the extensions you enable. Telegram also requires a bot token and an explicit startup opt-in.

## Extensions

| Extension | What it does | Read next |
|---|---|---|
| `pi-ad-telegram` | Connects one Pi session to a private Telegram bot. | [Setup](pi-ad-telegram/README.md), [commands](pi-ad-telegram/commands.md), [settings](pi-ad-telegram/configuration.md), [delivery behavior](pi-ad-telegram/operations.md) |
| `pi-ad-session-usage` | Reports active-branch token usage and Pi-estimated cost. | [README](pi-ad-session-usage/README.md), [surface contract](docs/contracts/surfaces/session-usage-reporting.md) |
| `pi-ad-hooks` | Adds advisory prompt context or runs trusted local scripts on public Pi events. | [Setup](pi-ad-hooks/README.md), [configuration and event reference](pi-ad-hooks/reference.md) |
| `pi-ad-task` | Manages one operator-approved task with bounded continuation and natural-language controls. | [README](pi-ad-task/README.md), [task workflow skill](pi-ad-task/skills/task-workflow/SKILL.md) |

## Development

Node.js and npm are needed for repository checks. From the repository root:

```sh
npm install
npm test
npm run typecheck
npm run docs:check
```

See [`AGENTS.md`](AGENTS.md) for project workflow and contract requirements. The [`docs/contracts/surfaces/`](docs/contracts/surfaces/) pages define the current behavior and limits of each extension.
