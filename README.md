# Pi plugins

Коллекция расширений для Pi. Каждое расширение лежит в отдельной подпапке.

- `pi-ad-telegram/` — Telegram bridge extension.
- `web/` — public web search and page-fetch tools.
- `pi-subagents` установлен как пользовательский пакет Pi (`pi install npm:pi-subagents`). Его документация и обновления доступны через `pi-subagents`.

Для разработки `pi-ad-telegram` установи зависимости командой `npm install`; проверки: `npm run typecheck` и `npm test`. Проектные инструкции для Pi-агентов, включая acceptance-контракт для subagent-задач, записаны в [`AGENTS.md`](AGENTS.md).

