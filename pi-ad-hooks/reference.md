# Hooks configuration and event reference

`pi-ad-hooks` loads `<agent-dir>/pi-ad-hooks.json` once when the extension loads. A missing file means no hooks. Configuration changes take effect after an extension reload or session restart.

## Configuration shape

```json
{
  "version": 1,
  "hooks": {
    "before_agent_start": [
      { "id": "operator-reply-russian", "type": "system_prompt", "text": "Отвечай по-русски." }
    ],
    "turn_end": [
      { "id": "audit-turn", "type": "script", "script": "audit.mjs", "timeoutMs": 5000 }
    ]
  }
}
```

Hook IDs are unique across the configuration and contain 1–64 ASCII letters, digits, `_`, or `-`. Arrays run in configuration order. Unknown events, invalid entries, and invalid timeouts are skipped with safe diagnostics.

## Supported Pi events

The extension accepts exactly the 41 public `ExtensionAPI.on()` event names from Pi 0.99.0. Names are literal configuration keys; there are no aliases.

| Group | Events |
|---|---|
| Project and resources | `project_trust`, `resources_discover` |
| Session lifecycle | `session_start`, `session_info_changed`, `session_before_switch`, `session_before_fork`, `session_before_compact`, `session_compact`, `session_compact_failed`, `session_shutdown`, `session_before_tree`, `session_tree` |
| MCP | `mcp_servers_change` |
| Model context and provider | `context`, `context_with_system`, `cache_warming_decision`, `before_provider_request`, `before_provider_headers`, `after_provider_response`, `provider_stream_event` |
| Agent and turn | `before_agent_start`, `agent_start`, `agent_end`, `agent_before_settle`, `agent_settled`, `turn_start`, `turn_end` |
| UI prompt | `ui_prompt_start`, `ui_prompt_end` |
| Messages and tools | `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `tool_call`, `tool_result` |
| User input and selection | `model_select`, `thinking_level_select`, `user_bash`, `input` |

See [Pi's extension event documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#events) and [public API declarations](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts) for native payloads and timing.

## System-prompt hooks

A system-prompt hook has the shape `{ "id": "...", "type": "system_prompt", "text": "..." }` and is accepted only under `before_agent_start`. It appends static text to Pi's existing `systemPromptOptions.appendSystemPrompt`, preserving any previous addendum and the rest of the structured system prompt. Multiple hooks are appended in configuration order. The extension does not set `systemPrompt` or `forceSystemPrompt`, which would replace the complete prompt.

This action applies to the agent run without adding a user-style message, requesting a model turn, or separately presenting the instruction as a request. Use it for standing run instructions such as response language.

## Prompt hooks

A prompt hook has the shape `{ "id": "...", "type": "prompt", "text": "..." }`. It stages static text for the next ordinary `context` event during an active run. The extension appends the text once as a non-persisted custom message; Pi converts it to user-role context for that request. Use this action when that message semantics is intended, not for a persistent system-level rule.

A run starts at `input` or, for programmatic input, `before_agent_start`; it ends at `agent_settled`. A `prompt` hook on `context` affects that request. A `prompt` hook on `context_with_system` waits for the next `context`. Repeated firings with the same ID coalesce while text is pending. A new idle input clears stale staged text; steering/follow-up input preserves the active run's queue. Text is discarded when the run settles or its session/context is replaced.

Prompt hooks outside a run are ignored with `PROMPT_ACTION_OUTSIDE_RUN`. Use scripts for lifecycle notifications such as `session_start` and cleanup such as `session_shutdown`. Prompt hooks cannot start another model request, revise an answer already produced, or override system/developer instructions.

## Bounded task continuation

Task mode is opt-in and is separate from declarative hook configuration:

- `/task` with no subcommand, or an unsupported subcommand, displays task help. `/task start <goal>` starts a task for this session branch; quote multi-word goals if needed. A nonterminal task must be resumed or stopped before another can start. Start and resume are rejected while Pi is busy.
- `/task status` reports state, goal, progress, and continuation count. `/task pause` prevents future nudges but does not cancel an in-flight model call. `/task resume [answer]` resumes a paused/blocked task and includes an optional response to the blocker in its next prompt. `/task done` and `/task stop` disable further continuation; they do not cancel an in-flight call.
- While active, the `task_update` tool records progress or marks the task `done` or `blocked`. A blocked task waits for a user response; use `/task resume <answer>` to provide it or `/task stop` before starting a new task.
- After a completed agent run, `agent_before_settle` appends a hidden continuation message and requests exactly one next call. It does not recursively invoke the agent from `agent_end`. Aborted or errored runs pause automatically.
- The extension stores versioned task state in custom session entries and restores it from the active branch after reload/resume/tree navigation. Session reload does not start background work.
- At most 20 automatic continuations are allowed per task. Reaching the cap pauses the task and notifies the user. This fixed bound prevents unbounded token use.

## Script hooks

A script hook uses a relative `.mjs` path beneath `<agent-dir>/pi-ad-hooks/`. Resolved paths must remain inside that directory, including after symlink resolution. The child receives one JSON document on stdin:

```json
{ "version": 1, "event": "turn_end", "payload": { "...": "JSON-safe event data" } }
```

The child receives no Pi API or context object. The environment is limited to `PATH`, `HOME`, `PI_CODING_AGENT_DIR`, and platform-required process variables. Stdout, stderr, exit status, and return values are ignored. The default timeout is 5 seconds; valid values are 100–30,000 milliseconds. A timed-out process is terminated.

Scripts run asynchronously and do not delay Pi's event handler. Hooks for the same event are dispatched in configuration order; different events may overlap. Execution is best-effort, especially during `session_shutdown`; Pi may exit before a script finishes.

## Security and diagnostics

Scripts run with the user's operating-system permissions and are not sandboxed. Payloads may contain private prompts, paths, or tool arguments. Configure only trusted scripts. Script payloads and process output are not persisted or logged. Task goals/progress are persisted in the local session transcript and sent to the configured model as normal user/continuation context. Telegram-started tasks also persist the numeric originating private-chat ID only for owner checks and message routing; it is not a credential. These values are not sent as external notifications or written to diagnostic logs. Diagnostics contain the hook ID, event, stable error code, and limited safe metadata; raw errors, stacks, and script output are omitted.

`project_trust` hooks do not grant or deny trust. The extension returns Pi's neutral `{ trusted: "undecided" }` result and runs configured actions separately.

## Migration from `pi-hooks`

For a local development setup using the previous name, first confirm that the new config, script directory, and extension path do not already exist. Move the old config and any existing scripts without changing their contents. Do not create `<agent-dir>/pi-ad-hooks/` unless you actually configure script hooks. Inspect the old extension symlink and remove it only after confirming its target; then point the new `pi-ad-hooks` link at the canonical repository directory. Do not replace a regular file or directory during migration.

The extension was not released under the old paths; this migration is for local installations of its earlier development version.
