# Surface contract: pi-ad-telegram

## Boundary, consumers, and ownership

`pi-ad-telegram` connects one running Pi session to a Telegram bot using Bot API long polling. Its consumers are the configured Telegram user(s) and the active Pi session. The extension is loaded from `pi-ad-telegram/index.ts`; `~/.pi/agent/extensions/pi-ad-telegram` currently points to this directory.

The extension is opt-in: Pi must be started with `--telegram`, `PI_TELEGRAM_ENABLED=1`, or the session's `/telegram on` command. It requires `PI_TELEGRAM_BOT_TOKEN` and numeric `PI_TELEGRAM_ALLOWED_USER_IDS`. Only allowed users in private chats are handled. Do not expose the bot token or permit untrusted users to use the bridge: accepted users can invoke commands with the Pi process's permissions.

## Observable inputs and behavior

- Ordinary Telegram text is delivered to the current Pi session. While Pi or an associated operation is busy, tasks enter a FIFO queue (currently up to 20), can be inspected/cancelled, and dispatch when the session is available.
- Supported built-in bot commands and eligible commands exposed by loaded Pi extensions are forwarded to their handlers. Unknown slash commands are rejected rather than sent as ordinary model prompts.
- Attachments are downloaded into `.telegram-inbox/` in the active project and their paths are included in the task.
- A reply or Telegram quote includes embedded original text/caption, sender, and quote text in a clearly delimited context block. If the original content is unavailable, that is stated. The plugin does not fetch arbitrary historical messages from Telegram.
- Messages queued by Telegram while Pi is offline are collected by chat and presented as one explicitly stale batch. Slash commands are excluded and never automatically replayed. After an outage of at least 30 seconds, recovered backlog is handled as stale in the same way. Pi asks whether ordinary stale requests are still relevant before acting.
- Activity and background-agent state are displayed in Telegram. Background work is integrated through adapters and does not block new input after the parent turn settles.

## Configuration and current fixed policy values

The current documented environment/configuration surface is:

- `PI_TELEGRAM_BOT_TOKEN`: bot credential.
- `PI_TELEGRAM_ALLOWED_USER_IDS`: comma-separated numeric allow-list.
- `PI_TELEGRAM_ENABLED=1` or the `--telegram` flag: opt in at startup; `/telegram on|off` controls the live session.

The following operational values currently live as source constants/defaults rather than user settings. They are recorded here to make the behavior visible; the authoring contract requires classifying and centralizing them before future tuning or refactoring:

- Queue capacity: 20 pending tasks.
- Telegram long-poll timeout: 20 seconds; update pages use Telegram's 100-update API page size.
- A recovered polling outage becomes stale after 30 seconds.
- Text chunking uses a 3,500-character internal message limit (below Telegram's service limit).
- Polling and outbox retries use exponential backoff starting at 1 second and capped at 30 seconds; message outbox applies only to `sendMessage` and `editMessageText`.
- Background-agent status polling interval: 15 seconds; shutdown activity cleanup timeout: 5 seconds.
- Background-agent task previews show at most the first 82 characters, followed by an ellipsis when truncated (up to 83 displayed characters); queue listings cap task text at 180 characters; the activity history shows at most 35 entries, with displayed summaries capped at 550 characters. These are current fixed display limits.

These are current implementation facts, not promises that every value is independently configurable. Future changes must name protocol invariants separately from operator-tunable policy and keep settings centralized and validated.

## Outbound delivery and failure behavior

- Outgoing Telegram text sends and edits are written to `~/.pi/agent/telegram-outbox.json`, replayed FIFO, and retried on transient network failures with backoff. Bot tokens are not stored in the buffer.
- Permanent API rejections are not retried indefinitely; buffered operations that are permanently rejected are dropped so they cannot block later messages.
- If Telegram accepted a send but the connection failed before the response arrived, a retry can produce a duplicate; Bot API sends have no idempotency key.
- Uploads, polling, and other side-effect operations are not covered by the outgoing text outbox guarantee.
- Network problems should not take down the Pi session; Telegram activity/status may lag while connectivity is unavailable.

## Interfaces and modularity

`queue.ts`, `message-renderer.ts`, `outbox.ts`, `agent-board.ts`, `reply-context.ts`, and `background-adapters/` own separable responsibilities. `index.ts` currently coordinates the extension, commands, polling, and state; future work should preserve the responsibility boundaries and avoid unbounded growth of the entry point. The user-facing command/API/configuration behavior is the contract; internal function and file names may change if the surface remains compatible.

## Non-goals and known limits

- No webhook or public Telegram endpoint; operation uses long polling.
- No arbitrary Telegram chat-history retrieval beyond content embedded in a reply/quote update.
- Stale slash commands are discarded, not executed later.
- Typing indicators and a time-only “last activity updated” line in the Telegram bubble are not yet part of the current behavior; they are planned follow-up work for the later Telegram refactor.
- No guarantee of exactly-once delivery after an ambiguous network disconnect.

## Related contracts

- [Pi extension authoring](pi-extension-authoring.md)
- [Authoring/Telegram contract task](../features/plugin-authoring-and-telegram-contracts.md)
