# Telegram queues and delivery

## Queue behavior

Ordinary messages received while Pi is busy enter a per-chat FIFO queue. The default capacity is 20 pending tasks and can be changed with `queueCapacity`. Each task is acknowledged with its ID and can be removed with `/queue_cancel <ID>`; `/clear_queue` removes all pending tasks for that chat. The active task is not cancelled by clearing the queue. When the queue is full, the bot rejects the new item explicitly.

Queued tasks start one at a time after the current Pi, Bash, compaction, or new-session operation settles. The bot marks the original Telegram message with ✅ when its task starts and ❌ when cancelled. If Telegram rejects reactions, it edits the queue acknowledgement instead.

## Offline and stale messages

On startup, messages received while Pi was offline are collected per chat and delivered together as one explicitly stale batch. Messages accumulated during a network outage of at least 30 seconds are handled the same way after reconnection. Pi asks whether ordinary stale requests are still relevant before acting. Stale slash commands are filtered and never replayed.

## Attachments and replies

Documents and photos are downloaded into `.telegram-inbox/` in the active project. Their paths are included in the task so Pi can inspect the files. A reply or quote includes the original text or caption, sender, and quoted text as delimited context. The extension does not fetch arbitrary Telegram history. Use the `telegram_send_file` tool when asking Pi to upload a local file.

## Outgoing message buffer

Text sends and edits are persisted FIFO at `<agent-dir>/telegram-outbox.json` by default and retried with backoff. The buffer does not contain bot tokens. Permanently rejected operations are dropped so they cannot block later messages. Uploads, polling, and other side effects are not buffered.

Telegram does not provide an idempotency key for these operations. If Telegram accepts a message but the connection drops before the response arrives, a retry can create a duplicate.

## Activity and background agents

While a Telegram-originated task is actively processing, the bot refreshes Telegram's typing action. Queued tasks do not show typing. The Pi activity bubble ends with a local-time `Updated: HH:mm` footer. Automatic and manual compaction update one activity row; they do not create separate lifecycle chat messages.

Background agents do not hold the Telegram input lock after the parent turn settles. A shared, edited-in-place board shows each agent's effective model when available, a short task summary, status, elapsed time, and reported token usage. It does not display the full task prompt. Running token counts are provisional; missing usage is labeled unavailable. Completed rows remain as recent history. `/agents` refreshes the board.

The included `pi-subagents` adapter is the only provider-specific lifecycle integration. Telegram activity and delivery failures are best-effort and do not block Pi work.
