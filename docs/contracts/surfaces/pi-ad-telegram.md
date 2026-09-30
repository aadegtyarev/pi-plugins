# Surface contract: pi-ad-telegram

## Boundary, consumers, and ownership

`pi-ad-telegram` connects one running Pi session to a Telegram bot using Bot API long polling. Its consumers are the configured Telegram user(s) and the active Pi session. The extension is loaded from `pi-ad-telegram/index.ts`; `~/.pi/agent/extensions/pi-ad-telegram` currently points to this directory.

The extension is opt-in: Pi must be started with `--telegram`, `PI_TELEGRAM_ENABLED=1`, or the session's `/telegram on` command. It requires `PI_TELEGRAM_BOT_TOKEN` and numeric `PI_TELEGRAM_ALLOWED_USER_IDS`. Only allowed users in private chats are handled. Do not expose the bot token or permit untrusted users to use the bridge: accepted users can invoke commands with the Pi process's permissions.

## Observable inputs and behavior

- Ordinary Telegram text is delivered to the current Pi session. While Pi or an associated operation is busy, tasks enter a FIFO queue (capacity configurable as `queueCapacity`, default 20), can be inspected/cancelled, and dispatch when the session is available.
- Supported built-in bot commands and eligible commands exposed by loaded Pi extensions are forwarded to their handlers. Unknown slash commands are rejected rather than sent as ordinary model prompts.
- Attachments are downloaded into `.telegram-inbox/` in the active project and their paths are included in the task.
- A reply or Telegram quote includes embedded original text/caption, sender, and quote text in a clearly delimited context block. If the original content is unavailable, that is stated. The plugin does not fetch arbitrary historical messages from Telegram.
- Messages queued by Telegram while Pi is offline are collected by chat and presented as one explicitly stale batch. Slash commands are excluded and never automatically replayed. After an outage of at least 30 seconds, recovered backlog is handled as stale in the same way. Pi asks whether ordinary stale requests are still relevant before acting.
- Activity and background-agent state are displayed in Telegram. While a Telegram-originated task is actively processing, the bot sends and refreshes Telegram's typing action; queued tasks do not show typing. Typing stops when the task settles, is cancelled, the session/connection is replaced, or the extension shuts down. API failures are logged and do not block Pi work.
- The existing Pi activity bubble ends with a local-time-only `Updated: HH:mm` footer, refreshed with the bubble (no date and no clock-only edits). Automatic and `/compact` compaction appear as one activity row transitioning from running to completed/failed; command callbacks and Pi lifecycle events are coalesced. Compaction lifecycle does not generate separate Telegram chat messages; `/compact` refusal/validation replies remain ordinary command responses.
- Background work is integrated through adapters and does not block new input after the parent turn settles.

## Configuration and policy values

The environment/flag surface remains:

- `PI_TELEGRAM_BOT_TOKEN`: bot credential.
- `PI_TELEGRAM_ALLOWED_USER_IDS`: comma-separated numeric allow-list.
- `PI_TELEGRAM_ENABLED=1` or the `--telegram` flag: opt in at startup; `/telegram on|off` controls the live session.

Operator-tunable settings are read from `<PI_CODING_AGENT_DIR>/pi-ad-telegram.json`, defaulting to `~/.pi/agent/pi-ad-telegram.json`. A missing file uses these validated defaults; unknown keys and invalid types/ranges fail with an actionable path-specific error. Relative `outboxPath` resolves under the agent directory. Credentials and authorization inputs remain outside this file.

| Setting | Default | Purpose |
| --- | ---: | --- |
| `queueCapacity` | 20 | Maximum pending Telegram tasks |
| `longPollTimeoutSeconds` | 20 | Telegram long-poll timeout |
| `staleBacklogThresholdMs` | 30000 | Outage duration before recovered messages are stale |
| `messageChunkLimit` | 3500 | Internal text/HTML chunk target |
| `retryBaseDelayMs` / `retryMaxDelayMs` | 1000 / 30000 | Polling and outbox retry backoff |
| `agentBoardRefreshIntervalMs` | 15000 | Background-agent status refresh |
| `typingRefreshIntervalMs` | 4000 | Typing-action refresh cadence |
| `commandTimeoutMs` | 120000 | Maximum `/bash` command runtime |
| `shutdownCleanupTimeoutMs` | 5000 | Activity cleanup bound during shutdown |
| `activityHistoryLimit` / `activityTextLimit` | 35 / 550 | Activity rows and per-summary text |
| `queuePreviewLimit` / `backgroundTaskPreviewLimit` | 180 / 82 | Queue and task preview text |
| `outboxPath` | `<agent-dir>/telegram-outbox.json` | Durable outbound message buffer |

Protocol constraints stay fixed and named in code: Telegram long polling accepts at most 50 seconds, update pages at most 100 results, and text messages at most 4096 characters; the typing action expires after about 5 seconds, so its refresh interval must be shorter. The message outbox applies only to `sendMessage` and `editMessageText`. Fixed presentation caps are centralized separately from the operator settings.

## Outbound delivery and failure behavior

- Outgoing Telegram text sends and edits are written to `~/.pi/agent/telegram-outbox.json`, replayed FIFO, and retried on transient network failures with backoff. Bot tokens are not stored in the buffer.
- Permanent API rejections are not retried indefinitely; buffered operations that are permanently rejected are dropped so they cannot block later messages.
- If Telegram accepted a send but the connection failed before the response arrived, a retry can produce a duplicate; Bot API sends have no idempotency key.
- Uploads, polling, and other side-effect operations are not covered by the outgoing text outbox guarantee.
- Network problems should not take down the Pi session; Telegram activity/status may lag while connectivity is unavailable.

## Interfaces and modularity

`config.ts` loads and validates agent-local settings; `telegram-format.ts` owns command/status summaries; `telegram-activity.ts` renders the shared activity timeline and compaction state; `typing-indicator.ts` manages active-task typing. `queue.ts`, `message-renderer.ts`, `outbox.ts`, `agent-board.ts`, `reply-context.ts`, and `background-adapters/` own their respective responsibilities. `index.ts` composes these modules and coordinates Pi lifecycle, Telegram polling, routing, and shared state. The user-facing command/API/configuration behavior is the contract; internal function and file names may change if the surface remains compatible.

## Non-goals and known limits

- No webhook or public Telegram endpoint; operation uses long polling.
- No arbitrary Telegram chat-history retrieval beyond content embedded in a reply/quote update.
- Stale slash commands are discarded, not executed later.
- No guarantee of exactly-once delivery after an ambiguous network disconnect.

## Related contracts

- [Pi extension authoring](pi-extension-authoring.md)
- [Authoring/Telegram contract task](../features/plugin-authoring-and-telegram-contracts.md)
