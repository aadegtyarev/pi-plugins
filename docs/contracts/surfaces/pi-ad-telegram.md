# Surface contract: pi-ad-telegram

## Boundary and ownership

`pi-ad-telegram` connects one running Pi session to a Telegram bot through Bot API long polling. It is distributed with the other first-party extensions in the [pi-plugins Git package](pi-plugin-distribution.md). The consumers are configured Telegram users and the active Pi session.

The bridge is opt-in: start Pi with `--telegram` or `PI_TELEGRAM_ENABLED=1`, or enable polling in-session with `/telegram on`. It requires `PI_TELEGRAM_BOT_TOKEN` and comma-separated numeric `PI_TELEGRAM_ALLOWED_USER_IDS`. Only those users in private chats are accepted. Each allowed user can run commands with the Pi process's permissions.

## Observable inputs and flows

- Ordinary Telegram text and attachments are submitted with Pi's `sendUserMessage` and `deliverAs: "steer"`, including while Pi is busy. The bridge best-effort marks the source message 👀 after submission; that marker is not confirmation of acceptance or processing. Pi's steering queue is not exposed through Telegram controls.
- There is no Telegram-owned task FIFO, task IDs, local queue acknowledgements, cancellation buttons, `/queue`, `/queue_cancel`, or `/clear_queue` controls. If Pi cannot accept ordinary input, the bridge fails clearly rather than deferring it. Eligible extension slash commands use direct handling only when Pi can handle them immediately; otherwise they fail clearly rather than being deferred. Built-in bot commands retain their direct handling.
- When ordinary task input from multiple allowed chats enters one Pi run, its final assistant response and usage report go to the chat associated with the latest such message. Bridge commands alone do not change that target; the activity bubble remains associated with the chat where the Telegram task began.
- Built-in bot commands and eligible commands from loaded Pi extensions are forwarded to their handlers. Unknown slash commands are rejected rather than sent as ordinary prompts. When `pi-ad-task` is available, `/task <goal>` starts a bounded task; `/task` with no arguments returns help, and status/pause/resume/done/stop controls return explicit Telegram feedback. `/task start <goal>` is also accepted. `/task resume [answer]` carries an optional user reply into the resumed task context. Natural-language operator requests can be handled by the task extension's model-callable control tool; the assistant may suggest task mode but must wait for consent. Every task-specific error, busy refusal, or rejected transition states a relevant next action.
- Telegram-originated task state stores the originating private-chat ID in the local Pi session branch. Task status/control responses and task-prefixed tool results are restricted to that chat; the active Telegram run route is shared with `pi-ad-task` for natural-language tool actions. Other allow-listed chats receive a generic refusal without goal/progress details. This local ID is routing metadata, not a Telegram credential.
- Documents and photos are downloaded into `.telegram-inbox/` in the active project. A reply or quote includes the original text/caption, sender, and quoted text as delimited context. If original content is unavailable, that is stated. The extension does not fetch arbitrary Telegram history.
- Messages accumulated while Pi is offline are grouped by chat and presented as one explicitly stale batch when Pi can accept it. Messages accumulated during a network outage of at least 30 seconds are handled the same way after reconnection. Pi asks whether ordinary stale requests remain relevant before acting; stale slash commands are filtered and never replayed. If a stale batch cannot be submitted immediately, it is rejected with an explanation rather than deferred in a task queue.
- For a Telegram-originated run, the bridge forwards the text of the `pi-ad-session-usage:report` custom message once as a separate Telegram message to the chat associated with that run. It also forwards results from task-prefixed tools such as `task_update` only to the originating Telegram task chat. Ordinary tool results, TUI-only tool activity, structured details, unrelated custom messages, and duplicate assistant responses are not forwarded. Transport retries remain best-effort and can duplicate delivery if Telegram accepts a message but its response is lost.
- While a Telegram-originated task is active, the bot refreshes Telegram's typing action. Failures are best-effort and do not block Pi.
- The existing activity bubble ends with a local-time-only `Updated: HH:mm` footer. Automatic and `/compact` compaction transition one activity row and do not create separate lifecycle chat messages. Validation/refusal text from `/compact` remains an ordinary command response.
- Background work is integrated through adapters. It does not hold the input lock after the parent turn settles. A shared, edited-in-place board shows each agent's effective model when available, short task summary, running/terminal state, elapsed time, and reported token usage. It never displays the full task prompt. Running token counts are provisional; unavailable usage is labeled. Completed rows remain as recent history. `/agents` refreshes the board.
- When a Telegram-launched background agent completes after its parent turn has settled and Pi is idle, the bridge nudges Pi to write a concise synthesis and routes the resulting assistant response to the chat associated with that launch. If several nudges are deferred during nested settlements, each turn is matched to the exact nudge that caused it, even if starts are reordered. If session-usage reporting is enabled, each report uses the same route as its synthesis. TUI-only background work is not forwarded. Completions queued while Pi is busy do not replace the active run's Telegram route.

## Configuration

Credentials remain outside the settings file. Operator settings load at `session_start` from `<PI_CODING_AGENT_DIR>/pi-ad-telegram.json`, defaulting to `~/.pi/agent/pi-ad-telegram.json`. A missing file uses defaults; invalid keys/types/ranges produce an actionable error. Relative `outboxPath` resolves under the agent directory.

| Setting | Default | Purpose |
|---|---:|---|
| `longPollTimeoutSeconds` | 20 | Long-poll timeout |
| `staleBacklogThresholdMs` | 30000 | Outage threshold for stale handling |
| `messageChunkLimit` | 3500 | Internal target for text/HTML chunks |
| `retryBaseDelayMs` / `retryMaxDelayMs` | 1000 / 30000 | Retry backoff bounds |
| `agentBoardRefreshIntervalMs` | 15000 | Background-board refresh interval |
| `typingRefreshIntervalMs` | 4000 | Typing-action refresh interval |
| `commandTimeoutMs` | 120000 | Maximum `/bash` runtime |
| `shutdownCleanupTimeoutMs` | 5000 | Shutdown cleanup bound |
| `activityHistoryLimit` / `activityTextLimit` | 35 / 550 | Activity row and text limits |
| `backgroundTaskPreviewLimit` | 82 | Background task preview limit |
| `outboxPath` | `<agent-dir>/telegram-outbox.json` | Durable outgoing text buffer |

Protocol limits stay fixed in code: Telegram long polling accepts at most 50 seconds, update pages at most 100 results, and text messages at most 4096 characters. Typing actions expire after about five seconds, so their refresh interval must be shorter. The outbox covers only `sendMessage` and `editMessageText`.

## Delivery and failure behavior

Outgoing text sends and edits are persisted FIFO in the configured outbox (default `~/.pi/agent/telegram-outbox.json`) and retried with backoff. Bot tokens are not stored there. Permanently rejected operations are dropped so they cannot block later messages. Uploads, polling, and other side effects are not covered by the outbox. If Telegram accepted a send but the response was lost, a retry may create a duplicate; the Bot API provides no idempotency key.

Network and Telegram API failures must not take down Pi. Activity/status can lag while connectivity is unavailable.

## Security and non-goals

`/bash` executes arbitrary shell commands with Pi's operating-system permissions and has no interactive TTY. Never send secrets through Telegram. Only trusted user IDs belong in the allow-list.

The extension does not use a webhook or public endpoint, fetch arbitrary Telegram history, replay stale slash commands, guarantee exactly-once transport delivery, or forward provider-specific background events without an adapter. The bridge does not manage Pi's internal steering queue.

## Related contracts

- [Pi extension authoring](pi-extension-authoring.md)
- [Pi plugin package distribution](pi-plugin-distribution.md)
