# Telegram configuration

## Credentials and startup

Credentials stay in environment variables, not in the settings file:

| Variable / flag | Purpose |
|---|---|
| `PI_TELEGRAM_BOT_TOKEN` | Telegram bot token from BotFather. Treat it as a secret. |
| `PI_TELEGRAM_ALLOWED_USER_IDS` | Comma-separated numeric Telegram user IDs allowed to use the bot. |
| `PI_TELEGRAM_ENABLED=1` | Opt in at startup. |
| `--telegram` | Equivalent startup opt-in flag. |

Without the opt-in, polling is off. `/telegram on` and `/telegram off` change it for the current session. Leave the opt-in unset in child Pi processes to avoid competing polling connections.

## Optional settings

Settings are read at `session_start` from `<PI_CODING_AGENT_DIR>/pi-ad-telegram.json`, or `~/.pi/agent/pi-ad-telegram.json` if `PI_CODING_AGENT_DIR` is unset. A missing file uses these defaults. Create it with owner-only permissions, such as `chmod 600 ~/.pi/agent/pi-ad-telegram.json`.

| Key | Default | Meaning |
|---|---:|---|
| `longPollTimeoutSeconds` | `20` | Telegram long-poll timeout. |
| `staleBacklogThresholdMs` | `30000` | Outage duration after which recovered messages are treated as stale. |
| `messageChunkLimit` | `3500` | Internal target for message chunks. |
| `retryBaseDelayMs` / `retryMaxDelayMs` | `1000` / `30000` | Retry backoff bounds. |
| `agentBoardRefreshIntervalMs` | `15000` | Background-agent status refresh interval. |
| `typingRefreshIntervalMs` | `4000` | Typing-action refresh interval. |
| `commandTimeoutMs` | `120000` | Maximum `/bash` runtime. |
| `shutdownCleanupTimeoutMs` | `5000` | Bound for activity cleanup at shutdown. |
| `activityHistoryLimit` / `activityTextLimit` | `35` / `550` | Maximum activity rows and summary characters. |
| `backgroundTaskPreviewLimit` | `82` | Maximum background task-preview characters. |
| `outboxPath` | `<agent-dir>/telegram-outbox.json` | Durable buffer for outgoing text sends and edits. |

Example:

```json
{
  "longPollTimeoutSeconds": 20,
  "outboxPath": "telegram-outbox.json"
}
```

Only include values you want to override. Unknown keys and invalid types or ranges are reported as errors. Relative `outboxPath` values resolve under the agent directory. The settings file must not contain the token, allowed-user IDs, or startup opt-in.

Settings are loaded when the extension starts for a session. Start a new Pi session after editing the file; `/reload` reloads resources but does not reload these session-start settings.
