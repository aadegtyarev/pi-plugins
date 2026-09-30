# Telegram command reference

Telegram commands are handled by the bot in the private chat. Pi slash commands are forwarded to the active session. The command menu is refreshed at bot startup and after `/reload`.

## Control the bridge in Pi

| Pi command | Behavior |
|---|---|
| `/telegram on` | Start Telegram polling for this session. |
| `/telegram off` | Stop polling. |

The bridge is off at startup unless Pi received `--telegram` or `PI_TELEGRAM_ENABLED=1`.

## Bot commands

| Command | Behavior |
|---|---|
| `/status` | Show whether Pi is busy, the active model and effort, and estimated context usage. |
| `/agents` | Refresh the background-agent board. A completed board remains in chat unpinned. |
| `/queue` | List pending tasks and their IDs. |
| `/queue_cancel <ID>` | Remove one pending task. |
| `/clear_queue` | Clear this chat's pending tasks, not the active task. |
| `/model` | List models available to the current Pi session. |
| `/model provider/model-id` | Switch the current session's model. An unambiguous model name or ID is also accepted. |
| `/effort` | Show the current effort and levels supported by the active model. |
| `/effort off\|minimal\|low\|medium\|high\|xhigh\|max` | Set a supported thinking level. |
| `/compact [instructions]` | Compact the current context, optionally with custom summarization instructions. |
| `/new` | Start a new Pi session. |
| `/bash <command>` | Run a shell command in Pi's current working directory; return stdout, stderr, and exit code. |
| `/reload` | Reload extensions and other Pi resources without restarting Pi. |
| `/cancel` | Abort the current Pi operation or Bash command. |
| `/help` | Show help and commands provided by active Pi extensions. |

Long command output is split across messages. `/bash` has no interactive TTY, so commands that need terminal input or passwords are unsupported. Never send secrets through Telegram.

## Extension commands

Commands provided by loaded Pi extensions are included when they are eligible for Telegram. Hyphens are mapped to underscores in Telegram names: for example, `/wt-create` appears as `/wt_create`. Pi's internal `telegram*` control commands are not exposed. Unknown slash commands are rejected rather than sent as ordinary prompts.

Ordinary text sent while Pi is busy is queued. See [operations](operations.md) for FIFO order, cancellation, stale backlog, and delivery behavior.
