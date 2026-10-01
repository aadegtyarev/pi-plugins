# Telegram delivery

## Task submission

Ordinary text and attachments received while Pi is running are submitted to Pi with `deliverAs: "steer"`, including when Pi is busy. The bridge best-effort adds 👀 to the source message after calling Pi's submission API; this marker does not confirm acceptance or processing. No Telegram-owned task FIFO, local task IDs, queue acknowledgements, cancellation buttons, or queue-management commands exist.

Eligible extension slash commands are forwarded directly to their Pi handlers only when Pi can handle them immediately. Built-in bridge commands retain their direct behavior. If Pi is busy in a way that cannot accept an input, or is occupied by a bridge-only operation, the bot explains that the input was not queued and asks the user to retry; it does not defer or replay the input. Stale/offline batches are still identified as stale, and are rejected with an explanation rather than being deferred when Pi cannot accept them. Stale slash commands are filtered.

## Offline and stale messages

On startup, messages received while Pi was offline are collected per chat and delivered together as one explicitly stale batch when Pi can accept it. Messages accumulated during a network outage of at least 30 seconds are handled the same way after reconnection. Pi asks whether ordinary stale requests are still relevant before acting. Stale slash commands are filtered and never replayed.

## Attachments and replies

Documents and photos are downloaded into `.telegram-inbox/` in the active project. Their paths are included in the task so Pi can inspect the files. A reply or quote includes the original text or caption, sender, and quoted text as delimited context. The extension does not fetch arbitrary Telegram history. Use the `telegram_send_file` tool when asking Pi to upload a local file.

## Outgoing message buffer

Text sends and edits are persisted FIFO at `<agent-dir>/telegram-outbox.json` by default and retried with backoff. The buffer does not contain bot tokens. Permanently rejected operations are dropped so they cannot block later messages. Uploads, polling, and other side effects are not buffered.

Telegram does not provide an idempotency key for these operations. If Telegram accepts a message but the connection drops before the response arrives, a retry can create a duplicate.

## Activity, usage, and background agents

While a Telegram-originated task is actively processing, the bot refreshes Telegram's typing action. A visible `pi-ad-session-usage:report` summary is forwarded once to the chat associated with that Telegram-originated run; TUI-only and unrelated reports are not sent. The report text can include estimated cost when available. Telegram delivery remains best-effort and is not guaranteed exactly once across transport retries.

The Pi activity bubble ends with a local-time `Updated: HH:mm` footer. Automatic and manual compaction update one activity row; they do not create separate lifecycle chat messages. Background agents do not hold the Telegram input lock after the parent turn settles. A shared, edited-in-place board shows each agent's effective model when available, a short task summary, status, elapsed time, and reported token usage. It does not display the full task prompt. Running token counts are provisional; missing usage is labeled unavailable. Completed rows remain as recent history. `/agents` refreshes the board.

The included `pi-subagents` adapter is the only provider-specific lifecycle integration. Telegram activity and delivery failures are best-effort and do not block Pi work.
