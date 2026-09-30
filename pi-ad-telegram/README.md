# pi-ad-telegram — Telegram bridge for Pi

A Pi extension that connects one already-running Pi session to a Telegram bot. It uses Telegram long polling, so no public URL or webhook is required. Runtime uses Pi's installed APIs and Node's built-in `fetch`; repository-level development dependencies provide typechecking and plugin tests.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Get your numeric Telegram user ID (for example, from [@userinfobot](https://t.me/userinfobot)). The bot accepts messages only from this ID and only in private chats.
3. Make sure the extension is available in Pi's user extensions directory. In this repo it is set up as a symlink:

   ```bash
   ~/.pi/agent/extensions/pi-ad-telegram -> /home/adegtyarev/Develop/Hobby/pi-plugins/pi-ad-telegram
   ```

4. Start Pi from a shell with the bot credentials and the opt-in flag:

   ```bash
   export PI_TELEGRAM_BOT_TOKEN='token-from-BotFather'
   export PI_TELEGRAM_ALLOWED_USER_IDS='123456789,987654321'
   pi --telegram
   ```

   Or set `PI_TELEGRAM_ENABLED=1` instead of passing `--telegram`. List multiple allowed IDs in the same variable, separated by commas with no extra syntax, for example `123456789,987654321`. Keep the bot token secret; anyone who has it can control the bot.

5. Open a private chat with your bot, send `/start`, then send it a task.

### Optional settings

Operator-tunable settings are read from `<PI_CODING_AGENT_DIR>/pi-ad-telegram.json`, or `~/.pi/agent/pi-ad-telegram.json` when `PI_CODING_AGENT_DIR` is unset. A missing file uses the defaults below. Create it with owner-only permissions (for example, `chmod 600 ~/.pi/agent/pi-ad-telegram.json`). Only include values you want to override; unknown keys, invalid types/ranges, and a retry maximum below the retry base are reported as errors.

```json
{
  "queueCapacity": 20,
  "longPollTimeoutSeconds": 20,
  "staleBacklogThresholdMs": 30000,
  "messageChunkLimit": 3500,
  "retryBaseDelayMs": 1000,
  "retryMaxDelayMs": 30000,
  "agentBoardRefreshIntervalMs": 15000,
  "typingRefreshIntervalMs": 4000,
  "commandTimeoutMs": 120000,
  "shutdownCleanupTimeoutMs": 5000,
  "activityHistoryLimit": 35,
  "activityTextLimit": 550,
  "queuePreviewLimit": 180,
  "backgroundTaskPreviewLimit": 82,
  "outboxPath": "telegram-outbox.json"
}
```

Relative `outboxPath` values resolve under the agent directory. The settings file does not contain credentials: keep `PI_TELEGRAM_BOT_TOKEN`, `PI_TELEGRAM_ALLOWED_USER_IDS`, and startup opt-in in their existing environment variables/flag. Settings load on `session_start`; start a new Pi session to apply file changes.

## Commands

In the Pi session, `/telegram on` and `/telegram off` start or stop polling without restarting Pi. The default is off unless Pi was launched with `--telegram` or `PI_TELEGRAM_ENABLED=1`.

Telegram bot commands:

- `/status` — show whether Pi is busy, the active model and effort, and estimated context usage.
- `/agents` — refresh the current pinned board of running background agents; if none are running, the completed board remains in chat unpinned.
- `/queue` — inspect this chat's pending tasks and their IDs.
- `/queue_cancel <ID>` — remove one pending task (`/queue_cancel` is in the Telegram command menu).
- `/clear_queue` — clear this chat's pending tasks without affecting the currently running task.
- `/model` — list models available to the current Pi session.
- `/model provider/model-id` — switch the current session to that model. You can also use an unambiguous model ID or name.
- `/effort` — show the current effort and levels supported by the active model.
- `/effort off|minimal|low|medium|high|xhigh|max` — set the effort (Pi thinking level) for the current session. Unsupported levels are rejected.
- `/compact [instructions]` — compact the current context, optionally with custom summarization instructions. The existing Pi activity bubble shows compaction progress and its terminal result.
- `/new` — start a new Pi session.
- `/bash <command>` — run a Bash command in Pi's current working directory and send back its stdout, stderr, and exit code. Long output is split across messages. For commands that read stdin, pass input in the command (for example, `/bash printf 'y\n' | command`).
- `/reload` — reload extensions and other Pi resources without restarting the Pi process.
- `/cancel` — abort the current Pi operation or Bash command.
- `/help` — show help, including Telegram-compatible commands from active Pi extensions.

Telegram's command menu is built from the commands available in the current Pi session. Extension slash commands are shown only while their extension is loaded; hyphens are mapped to underscores for Telegram (for example, `/wt_create` forwards to Pi as `/wt-create`). Commands are forwarded to Pi and can be queued while Pi is busy. The menu is refreshed when the bot starts and after `/reload`. Pi's internal `telegram*` control commands are not exposed.

When you send a document or photo, the bot saves it in `.telegram-inbox/` in the project and passes its path to Pi so the agent can inspect it. If your message replies to another Telegram message or includes a quote, the original message text/caption, sender, and quoted text are included as clearly delimited context for Pi; bot commands are not modified. When you ask Pi to send you a file, it can use the `telegram_send_file` tool to upload that file to the chat. Tool calls are sent while a Telegram task runs; tool-output messages are not forwarded. Web activity shows compact search queries, fetched page host/path (URL query strings are omitted), source-check claims, and stored-content retrieval targets. Long activity timelines continue in additional edited-in-place messages; the whole set is deleted when the parent task settles. Long outputs and answers are split across Telegram messages. Model and effort changes apply to the current session and can only be made while Pi is idle.

Ordinary Telegram input received while Pi is busy is retained in a FIFO queue (up to `queueCapacity` pending tasks; 20 by default) and acknowledged by replying to the original message. Each queued task has a removable inline button and an ID for `/queue_cancel <ID>`. `/queue` lists IDs; when a task starts, the bot marks the original message with ✅ and removes the queue acknowledgement. Cancellation marks it with ❌ and removes the acknowledgement; if Telegram rejects reactions, the acknowledgement is edited to show the state instead. Tasks dispatch one at a time after the current Pi, Bash, compact, or new-session operation settles, and answers go to the originating chat. `/clear_queue` removes this chat's pending tasks; cancelling the active task does not clear the queue. If full, the bot explicitly rejects the new item. Attachment files are downloaded before queueing, and their local paths are retained in the queued task. On startup, messages received while Pi was offline are collected per chat and sent to Pi together as one explicitly stale batch; Pi asks whether they are still relevant before acting. Stale slash commands are filtered out and never replayed or passed to the model. Messages that accumulate during a network outage lasting at least 30 seconds are handled the same way after reconnection. Outbound Telegram text sends and edits are durably buffered in the configured `outboxPath` (default `~/.pi/agent/telegram-outbox.json`) and retried in order with backoff; the buffer does not include bot tokens. A connection loss after Telegram accepted a message but before its response can still result in a duplicate on retry.

While a Telegram-originated task is actively processing, the bot shows and refreshes Telegram's typing action; queued tasks do not show typing. The current Pi activity bubble ends with a local-time `Updated: HH:mm` footer. Automatic and manual context compaction transition one row in that same bubble rather than sending separate lifecycle messages. When a parent turn launches a background subagent, Pi returns the answer and Telegram accepts another message as soon as the parent turn settles; the child keeps running independently and does not hold the input lock. Its completion is summarized by the parent rather than forwarding the raw child report. Background lifecycle integrations are isolated under `background-adapters/`: adapters translate provider-specific events into a small normalized contract, while the Telegram core handles chat routing, status-board updates, and result delivery. The included `pi-subagents` adapter is the only provider-specific lifecycle integration in this package; another provider can be supported by adding an adapter and registering it in `background-adapters/index.ts`, without editing Telegram event handlers. A persistent, edited-in-place board lists agent, effective model when available, a short operation summary (paths removed, capped at about 82 characters; or a neutral fallback such as “task hidden”), running/terminal state, elapsed time, and token usage when reported by status data. It never displays the full task prompt. Running-agent status is checked every 15 seconds and the board is edited only when displayed content changes. Token counts are marked provisional while an agent is running; unavailable usage is labeled rather than estimated. Completed, failed, and stopped rows remain visible as recent history. One pinned board represents one overlapping batch of background agents. Concurrent agents share it; each completion updates its row, and when the last agent finishes the board shows the final statuses, is unpinned, and remains in chat. The next batch gets a fresh message and pin instead of reusing the old one. When a background agent completes, the parent Pi turn is nudged to summarize it in the Telegram chat associated with that launch. If Telegram denies pin permission, the editable board remains usable. Use `/agents` to refresh it.

**Security:** `/bash` executes arbitrary shell commands with the permissions of the Pi process. It has no interactive TTY, so prompts for terminal input and passwords are not supported; never send secrets through Telegram. Only add trusted user IDs to `PI_TELEGRAM_ALLOWED_USER_IDS`; every allowed user can run commands in the current project directory.

## Development architecture

- `commands.ts` defines built-in Telegram command names, aliases, menu entries, and help text, and derives Telegram-compatible plugin commands from the active Pi session. `command-registry.ts` routes built-in names and aliases to handlers; `index.ts` forwards available plugin slash commands into Pi.
- `queue.ts` owns FIFO storage, capacity, chat-scoped removal, and queue-notice completion fallback; Telegram API calls remain injected from `index.ts`.
- `agent-board.ts` owns the active batch and pinned-message lifecycle: parallel runs share one board, completed boards remain unpinned, and the next batch gets a new message.
- `config.ts` loads and validates agent-local settings; protocol limits and fixed presentation caps are named constants rather than operator knobs.
- `telegram-format.ts` owns Telegram-facing previews, status text, and command-output summaries.
- `telegram-activity.ts` renders the existing activity timeline, timestamp footer, and coalesced compaction lifecycle; `typing-indicator.ts` manages active-task typing with injected timers/API actions.
- `message-renderer.ts` is the shared formatting, safe chunking, fallback, send, and edit path for user replies, queue messages, activity updates, and the agent board. Keep message-specific layout in its caller; put cross-message formatting or delivery fixes here.
- `background-adapters/` isolates provider-specific lifecycle events.

Run `npm run typecheck` and `npm test` after changes.

Pi auto-loads this extension because `~/.pi/agent/extensions/pi-ad-telegram` points to this directory and the entry point is `index.ts`. The extension stops polling when the Pi session shuts down. Telegram polling is opt-in: only processes launched with `--telegram` or `PI_TELEGRAM_ENABLED=1`, or explicitly enabled with `/telegram on`, connect to the bot. Leave the environment variable unset (or set it to `0`) in child Pi processes, such as subagents, to avoid competing polling connections.
