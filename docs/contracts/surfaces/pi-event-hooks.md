# Surface contract: Pi event hooks

## Boundary and ownership

`pi-ad-hooks/` is a user-global Pi extension for adding request context, running trusted local side effects on public Pi events, and explicitly bounded task continuation. Its entry point registers the public `ExtensionAPI.on()` event set from Pi 0.99.0. Declarative hook configuration reads only `<agent-dir>/pi-ad-hooks.json`; project-local hook configuration is not loaded.

## Configuration and supported events

Configuration is loaded once when the extension loads. If the file is absent, no hooks are configured. Version 1 uses `{ "version": 1, "hooks": { "<exact-event>": [ ... ] } }`. Hook IDs are unique, 1–64 ASCII letters, digits, `_`, or `-`; arrays run in configuration order.

The supported keys are exactly the 41 public event names in Pi 0.99.0: `project_trust`, `resources_discover`, `session_start`, `session_info_changed`, `session_before_switch`, `session_before_fork`, `session_before_compact`, `session_compact`, `session_compact_failed`, `session_shutdown`, `mcp_servers_change`, `session_before_tree`, `session_tree`, `context`, `context_with_system`, `cache_warming_decision`, `before_provider_request`, `before_provider_headers`, `after_provider_response`, `provider_stream_event`, `before_agent_start`, `agent_start`, `agent_end`, `agent_before_settle`, `agent_settled`, `ui_prompt_start`, `ui_prompt_end`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `model_select`, `thinking_level_select`, `tool_call`, `tool_result`, `user_bash`, and `input`. There are no aliases or automatic support for private or future events.

## Actions and request flows

- **`prompt`** — `{ "id", "type": "prompt", "text" }` stages static text during an active run. The next ordinary `context` event appends it once as a non-persisted `role: "custom"`, `customType: "pi-ad-hooks"`, `display: false` message. Pi converts this into user-role model context. A `context` hook affects that request; a `context_with_system` hook waits for the next ordinary `context`. This is advisory user-style context, not a system-prompt edit. Repeated firings of one hook ID coalesce while its text is pending. A new idle input clears stale text; steering/follow-up input preserves the active run's queue.
- **`system_prompt`** — `{ "id", "type": "system_prompt", "text" }` is valid only under `before_agent_start`. It appends to Pi's mutable `systemPromptOptions.appendSystemPrompt`, preserving Pi's existing structured system prompt and any prior addendum. Hooks are applied in configuration order and remain in effect for that run. The extension does not set `systemPrompt` or `forceSystemPrompt`, which would replace the full prompt. This action does not add a user-style custom message or request an extra model turn.
- **`script`** — `{ "id", "type": "script", "script": "relative.mjs", "timeoutMs": 5000 }` starts a Node `.mjs` child process. Paths must remain under `<agent-dir>/pi-ad-hooks/`, including after symlink resolution. The default timeout is 5,000 ms; valid values are 100–30,000 ms.

Scripts receive one version-1 JSON document on stdin: `{ "version": 1, "event": "<exact-event>", "payload": <JSON-safe-event> }`. Serialization failure skips that invocation. Scripts run asynchronously, in configuration order for each event; independent events may overlap. Children receive only `PATH`, `HOME`, `PI_CODING_AGENT_DIR`, and platform-required process variables. Stdout, stderr, exit status, and return values are ignored.

Prompt actions outside an active run are skipped with `PROMPT_ACTION_OUTSIDE_RUN`; use scripts for lifecycle events such as `session_start`, `agent_settled`, and `session_shutdown`. Pending prompt text is cleared when a run settles or its session/context is replaced. `project_trust` requires a handler result; this extension returns `{ trusted: "undecided" }` and never grants or denies trust.

**Task continuation** is separately opt-in through `/task start <goal>`. The user can inspect, pause, resume, complete, or stop the task with `/task` commands. The model can update progress, mark completion, or mark the task blocked through a task-only tool. At `agent_before_settle`, an active task with a completed run receives one hidden continuation and requests one next call; task state is persisted in session custom entries and restored from the current branch. Abort/error pauses the task. The fixed limit is 20 automatic continuations; exhaustion pauses and notifies instead of looping. No continuation runs in the background while the session is idle.

## Failure behavior

Malformed or unreadable configuration, unknown event names, invalid entries, unsupported `system_prompt` event placement, missing Pi system-prompt options, invalid script paths/timeouts, serialization errors, process-launch failures, nonzero exits, and timeouts fail open. Invalid entries are skipped. Stable diagnostic codes include `SYSTEM_PROMPT_EVENT_INVALID` and `SYSTEM_PROMPT_OPTIONS_MISSING`; diagnostics omit hook text, event payloads, process output, stacks, and raw OS errors. Timed-out child processes are terminated. Background scripts are best-effort and may not finish before Pi exits, especially during `session_shutdown`.

Configuration changes apply after extension reload or session restart.

## Security and privacy

Scripts run with the Pi user's operating-system permissions and are not sandboxed. They can access files and network resources available to that user. Event payloads may contain private prompts, paths, or tool arguments. Configure only trusted scripts. Task goals and progress are persisted in the local Pi session transcript as extension-owned entries and sent to the configured model as normal user/continuation context. They are not sent as external notifications or written to diagnostic logs.

## Non-goals

Declarative hooks cannot block, approve, cancel, or rewrite Pi operations. `prompt` is user-style context, while `system_prompt` only appends static text to Pi's existing system prompt for one run; neither replaces Pi's full system prompt. The opt-in task runner requests only bounded continuation through Pi's public settle event; it does not create background workers or apply to ordinary prompts by default. Scripts receive no Pi API/context. Project-local hook configuration, HTTP/MCP/model-based handlers, sandboxing, and automatic support for future/private events are not provided.

## Related contracts

- [Pi extension authoring](pi-extension-authoring.md)
- [Pi plugin package distribution](pi-plugin-distribution.md)
- [Pi public extension events](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#events)
- [Public `ExtensionAPI.on()` declarations](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts)
