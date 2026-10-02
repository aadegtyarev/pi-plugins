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

When `pi-ad-hooks` is loaded, `/help` includes its task commands. `/task` with no subcommand, or an unsupported subcommand, returns task help directly:

| Command | Behavior |
|---|---|
| `/task start <goal>` | Start a bounded task. Quote a multi-word goal, e.g. `/task start "Fix the bug and run tests"`. A nonterminal task must be resumed or stopped before another can start. |
| `/task status` | Show the goal, progress, state, and continuation count. |
| `/task pause` | Pause automatic continuation after the current Pi call; it does not cancel that call. |
| `/task resume [answer]` | Resume a paused/blocked task; optional answer is added to the continuation context to respond to a blocker. |
| `/task done` | Mark the current task complete. |
| `/task stop` | Stop future automatic continuation so a new task can start. The current Pi call is not cancelled; use `/cancel` for that. |

Accepted starts and resumes are acknowledged in Telegram. Task tool updates such as `task_update` are forwarded to the chat that started the active task. Pi rejects invalid transitions with an explanation and recovery command.

Ordinary text and attachments are submitted to Pi with `deliverAs: "steer"` and best-effort marked 👀; the marker is not confirmation of acceptance or processing. There are no Telegram queue controls. Inputs Pi cannot accept immediately are rejected with a retry explanation, never deferred. See [operations](operations.md) for stale backlog and delivery behavior.
