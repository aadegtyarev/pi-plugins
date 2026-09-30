# Surface contract: pi-ad-telegram

## Boundary and ownership

`pi-ad-telegram` connects one running Pi session to a Telegram bot through Bot API long polling. It is distributed with the other first-party extensions in the [pi-plugins Git package](pi-plugin-distribution.md). The consumers are configured Telegram users and the active Pi session.

The bridge is opt-in: start Pi with `--telegram` or `PI_TELEGRAM_ENABLED=1`, or enable polling in-session with `/telegram on`. It requires `PI_TELEGRAM_BOT_TOKEN` and comma-separated numeric `PI_TELEGRAM_ALLOWED_USER_IDS`. Only those users in private chats are accepted. Each allowed user can run commands with the Pi process's permissions.

## Observable inputs and flows

- Ordinary Telegram text is sent to the active Pi session. While Pi or an associated operation is busy, tasks enter a per-chat FIFO queue. Its default capacity is 20 pending tasks; tasks can be inspected, cancelled, or cleared without cancelling the active task.
- Built-in bot commands and eligible commands from loaded Pi extensions are forwarded to their handlers. Unknown slash commands are rejected rather than sent as ordinary prompts.
- Documents and photos are downloaded into `.telegram-inbox/` in the active project. A reply or quote includes the original text/caption, sender, and quoted text as delimited context. If original content is unavailable, that is stated. The extension does not fetch arbitrary Telegram history.
- Messages accumulated while Pi is offline are grouped by chat and presented as one explicitly stale batch. Messages accumulated during a network outage of at least 30 seconds are handled the same way after reconnection. Pi asks whether ordinary stale requests remain relevant before acting; stale slash commands are filtered and never replayed.
- While a Telegram-originated task is active, the bot refreshes Telegram's typing action; queued tasks do not show typing. Failures are best-effort and do not block Pi.
- The existing activity bubble ends with a local-time-only `Updated: HH:mm` footer. Automatic and `/compact` compaction transition one activity row and do not create separate lifecycle chat messages. Validation/refusal text from `/compact` remains an ordinary command response.
- Background work is integrated through adapters. It does not hold the input lock after the parent turn settles. A shared, edited-in-place board shows each agent's effective model when available, short task summary, running/terminal state, elapsed time, and reported token usage. It never displays the full task prompt. Running token counts are provisional; unavailable usage is labeled. Completed rows remain as recent history. `/agents` refreshes the board.

## Configuration

Credentials remain outside the settings file. Operator settings load at `session_start` from `<PI_CODING_AGENT_DIR>/pi-ad-telegram.json`, defaulting to `~/.pi/agent/pi-ad-telegram.json`. A missing file uses defaults; invalid keys/types/ranges produce an actionable error. Relative `outboxPath` resolves under the agent directory.

| Setting | Default | Purpose |
|---|---:|---|
| `queueCapacity` | 20 | Maximum pending Telegram tasks |
| `longPollTimeoutSeconds` | 20 | Long-poll timeout |
| `staleBacklogThresholdMs` | 30000 | Outage threshold for stale handling |
| `messageChunkLimit` | 3500 | Internal target for text/HTML chunks |
| `retryBaseDelayMs` / `retryMaxDelayMs` | 1000 / 30000 | Retry backoff bounds |
| `agentBoardRefreshIntervalMs` | 15000 | Background-board refresh interval |
| `typingRefreshIntervalMs` | 4000 | Typing-action refresh interval |
| `commandTimeoutMs` | 120000 | Maximum `/bash` runtime |
| `shutdownCleanupTimeoutMs` | 5000 | Shutdown cleanup bound |
| `activityHistoryLimit` / `activityTextLimit` | 35 / 550 | Activity row and text limits |
| `queuePreviewLimit` / `backgroundTaskPreviewLimit` | 180 / 82 | Queue/task preview text limits |
| `outboxPath` | `<agent-dir>/telegram-outbox.json` | Durable outgoing text buffer |

Protocol limits stay fixed in code: Telegram long polling accepts at most 50 seconds, update pages at most 100 results, and text messages at most 4096 characters. Typing actions expire after about five seconds, so their refresh interval must be shorter. The outbox covers only `sendMessage` and `editMessageText`.

## Delivery and failure behavior

Outgoing text sends and edits are persisted FIFO in the configured outbox (default `~/.pi/agent/telegram-outbox.json`) and retried with backoff. Bot tokens are not stored there. Permanently rejected operations are dropped so they cannot block later messages. Uploads, polling, and other side effects are not covered by the outbox. If Telegram accepted a send but the response was lost, a retry may create a duplicate; the Bot API provides no idempotency key.

Network and Telegram API failures must not take down Pi. Activity/status can lag while connectivity is unavailable.

## Security and non-goals

`/bash` executes arbitrary shell commands with Pi's operating-system permissions and has no interactive TTY. Never send secrets through Telegram. Only trusted user IDs belong in the allow-list.

The extension does not use a webhook or public endpoint, fetch arbitrary Telegram history, replay stale slash commands, guarantee exactly-once delivery, or forward provider-specific background events without an adapter.

## Related contracts

- [Pi extension authoring](pi-extension-authoring.md)
- [Pi plugin package distribution](pi-plugin-distribution.md)
