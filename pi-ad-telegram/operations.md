# Telegram input and delivery

```mermaid
sequenceDiagram
    actor User
    participant Bot as Telegram bridge
    participant Pi as Pi session
    participant Outbox as Text outbox
    participant API as Telegram Bot API
    User->>Bot: Private message or command
    Bot->>Bot: Check allow-list and route
    alt Ordinary text or attachment
        Bot->>Pi: Submit with deliverAs=steer
    else Eligible extension command
        Bot->>Pi: Direct command dispatch
    end
    alt Pi accepts input
        Pi-->>Bot: Assistant response or visible custom report
        Bot->>Outbox: Persist send/edit
        Outbox->>API: Deliver with retry
    else Pi cannot accept input
        Bot-->>User: Refuse; do not queue
    end
```

## Input and offline messages

Ordinary text and attachments use Pi's steering delivery, even during a run. A best-effort 👀 reaction is not an acknowledgement; Telegram has no queue controls. With `pi-ad-task`, `/task status`, `pause`, `done`, and `stop` are handled immediately during another operation; they inspect or change task state but do not cancel the operation. Busy feedback tells the operator to wait before starting another task. `/task start` and `/task resume`, plus other generic extension commands, require Pi to be ready and are rejected rather than queued.

At startup, or after a network outage reaches the configured threshold (30 seconds by default), updates are grouped by chat into an explicitly stale batch. Pi asks whether ordinary requests remain relevant; stale slash commands are never replayed. If Pi is busy, the batch is rejected, not queued.

## Attachments and replies

Documents and photos are downloaded to `.telegram-inbox/` in the active project; their paths are sent to Pi. Replies and quotes include original text or caption, sender, and quoted text. No arbitrary history is fetched. Use `telegram_send_file` to upload a local file.

## Outgoing delivery

Text sends and edits are persisted FIFO to `<agent-dir>/telegram-outbox.json` and retried with backoff; tokens are not stored. Permanent failures are dropped. Uploads and polling are not buffered. Telegram has no idempotency key, so a retry after a lost response can duplicate a message.

## Activity and background work

While a Telegram task is active, the bot refreshes its typing action. Final assistant responses for a Telegram-owned task are routed to its owner chat through automatic continuations and explicit TUI resumption. Unrelated TUI-only responses are not forwarded. Only a manually requested `/cost` is forwarded to its invoking chat; unrelated usage reports are not. Delivery is best-effort.

The activity bubble shows progress and local time (`Updated: HH:mm`); it is separate from the final response message. Compaction updates one row. Background agents release Pi's input lock after the parent turn settles. Their edited board shows known model, task preview, status, elapsed time, and tokens—never the full prompt. Running token counts are provisional; unavailable usage is labeled. `/agents` refreshes the board, and completed rows remain in chat.

Only the `pi-subagents` adapter supplies provider-specific lifecycle events. Delivery failures do not block Pi.
