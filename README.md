# Pi plugins

A collection of extensions for Pi. Each extension lives in its own subdirectory.

- `pi-ad-telegram/` — Telegram bridge extension.
- `pi-ad-session-usage/` — active-branch usage and estimated-cost reporting extension.
- `pi-ad-hooks/` — user-global prompt and asynchronous side-effect hooks for public Pi events.
- `web/` — public web search and page-fetch tools.
- `pi-subagents` is installed as a user-level Pi package (`pi install npm:pi-subagents`). Its documentation and updates are available through `pi-subagents`.

To develop `pi-ad-telegram`, install dependencies with `npm install`; run checks with `npm run typecheck` and `npm test`. Project instructions for Pi agents, including the subagent acceptance contract, are in [`AGENTS.md`](AGENTS.md).
