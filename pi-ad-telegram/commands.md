# Telegram commands

In a private chat, bot commands run directly and Pi commands go to the active session. The menu refreshes at startup and after `/reload`.

## Control the bridge in Pi

| Command | Action |
|---|---|
| `/telegram on` | Start polling for this session. |
| `/telegram off` | Stop polling. |

The bridge starts off unless Pi was launched with `--telegram` or `PI_TELEGRAM_ENABLED=1`.

## Bot commands

| Command | Action |
|---|---|
| `/start`, `/help` | Connect and show help. |
| `/status` | Show Pi state, model, effort, context, and session statistics. |
| `/agents` | Refresh the background-agent board. |
| `/model` | List available models. |
| `/model provider/model-id` | Select a model; an unambiguous name or ID also works. |
| `/effort` | Show the current effort and supported levels. |
| `/effort <level>` | Set a level supported by the current model. |
| `/compact [instructions]` | Compact context with optional instructions. |
| `/new` | Start a new session. |
| `/bash <command>` | Run Bash in Pi's working directory and return output and exit code. |
| `/reload` | Reload extensions and resources. |
| `/cancel` | Abort the current Pi operation or Bash command. |

Bash has no interactive TTY; interactive input and password prompts are unsupported. Never send secrets through Telegram. Long output is split across messages.

## Extension commands

Eligible loaded-extension commands appear too; hyphens become underscores (`/wt-create` becomes `/wt_create`). Internal `telegram*` commands stay hidden. Unknown slash commands are rejected. While Pi is busy, task status/pause/done/stop still work but do not cancel the current operation; task start/resume and other extension commands are rejected rather than queued.

With `pi-ad-task`, use `/task <goal>`, `/task status`, `/task pause`, `/task resume [answer]`, `/task done`, or `/task stop`. Use `/task start <goal>` if the goal begins with a reserved word. Pause does not cancel; `/cancel` does. Only one nonterminal task is allowed. `task_control` requires explicit consent to start.

Ordinary text uses Pi's steering queue; inputs Pi cannot accept are rejected, not queued by Telegram. See [delivery behavior](operations.md).
