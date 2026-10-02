# Telegram configuration

## Credentials and opt-in

Set credentials in the environment, not the settings file:

| Variable or flag | Purpose |
|---|---|
| `PI_TELEGRAM_BOT_TOKEN` | Secret token from BotFather. |
| `PI_TELEGRAM_ALLOWED_USER_IDS` | Comma-separated numeric user IDs allowed to use the bot. |
| `PI_TELEGRAM_ENABLED=1` or `--telegram` | Enable polling at startup. |

Without opt-in, polling is off. `/telegram on` and `/telegram off` change it for the current session. Leave the opt-in unset in child Pi processes to avoid competing pollers.

## Optional settings

Pi reads `<PI_CODING_AGENT_DIR>/pi-ad-telegram.json` at `session_start`; without `PI_CODING_AGENT_DIR`, it uses `~/.pi/agent/pi-ad-telegram.json`. A missing file uses defaults. Restrict file access, for example: `chmod 600 ~/.pi/agent/pi-ad-telegram.json`.

| Key | Default | Purpose |
|---|---:|---|
| `longPollTimeoutSeconds` | `20` | Telegram long-poll timeout. |
| `staleBacklogThresholdMs` | `30000` | Outage duration before recovered messages are treated as stale. |
| `messageChunkLimit` | `3500` | Internal message-chunk target. |
| `retryBaseDelayMs` / `retryMaxDelayMs` | `1000` / `30000` | Retry backoff bounds. |
| `agentBoardRefreshIntervalMs` | `15000` | Background-agent board refresh interval. |
| `typingRefreshIntervalMs` | `4000` | Typing-action refresh interval. |
| `commandTimeoutMs` | `120000` | Maximum `/bash` runtime. |
| `shutdownCleanupTimeoutMs` | `5000` | Shutdown-cleanup bound. |
| `activityHistoryLimit` / `activityTextLimit` | `35` / `550` | Maximum timeline rows and summary characters. |
| `backgroundTaskPreviewLimit` | `82` | Maximum task-preview characters. |
| `outboxPath` | `<agent-dir>/telegram-outbox.json` | Durable buffer for outgoing text sends and edits. |

Example:

```json
{ "longPollTimeoutSeconds": 20, "outboxPath": "telegram-outbox.json" }
```

Only override values you need. Unknown keys, invalid types, and out-of-range values are errors. Relative `outboxPath` values resolve under the agent directory. Do not put the token, user IDs, or startup opt-in in this file. Settings load at session start: start a new session after editing; `/reload` does not reload them.
