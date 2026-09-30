# Surface contract: Pi event hooks

## Boundary, consumers, and ownership

`pi-ad-hooks/` is a standalone user-global Pi extension for event-triggered model context and trusted local side effects. Its entry point registers the public Pi 0.99.0 `ExtensionAPI.on()` event set. Configuration validation, one-shot prompt state, and child-process execution are separate modules. The extension reads no project-local hook configuration.

## Observable inputs, outputs, and flows

- Configuration is read once when the extension loads from `<agent-dir>/pi-ad-hooks.json`. If the file is absent, the extension loads with no hooks and no warning. The version-1 shape is `{ "version": 1, "hooks": { "<exact-event>": [ ... ] } }`. Each hook has a unique id (1–64 ASCII letters, digits, `_` or `-`). Arrays preserve configuration order.
- The supported event identifiers are exactly the 41 public names in Pi 0.99.0: `project_trust`, `resources_discover`, `session_start`, `session_info_changed`, `session_before_switch`, `session_before_fork`, `session_before_compact`, `session_compact`, `session_compact_failed`, `session_shutdown`, `mcp_servers_change`, `session_before_tree`, `session_tree`, `context`, `context_with_system`, `cache_warming_decision`, `before_provider_request`, `before_provider_headers`, `after_provider_response`, `provider_stream_event`, `before_agent_start`, `agent_start`, `agent_end`, `agent_before_settle`, `agent_settled`, `ui_prompt_start`, `ui_prompt_end`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `model_select`, `thinking_level_select`, `tool_call`, `tool_result`, `user_bash`, `input`. Names are configuration keys as written; there are no aliases.
- A prompt hook `{ "id", "type": "prompt", "text" }` stages static text while a request run is active. A run begins on `input` or, for programmatic input, `before_agent_start`; it ends on `agent_settled`. A new idle input (no `streamingBehavior`) clears pending text left by an earlier input that another handler short-circuited; steering/follow-up input preserves the active run's queue. The next `context` handler appends pending text to that same request as a non-persisted `role: "custom"`, `customType: "pi-ad-hooks"`, `display: false` message, which Pi converts to user-role model context. A hook triggered by `context_with_system` waits for the next ordinary `context` event. Repeated firings of one hook id while its text is pending coalesce; it may stage again after consumption. Prompt hooks outside a run are skipped with `PROMPT_ACTION_OUTSIDE_RUN`; use scripts for lifecycle events such as `session_start`, `agent_settled`, and `session_shutdown`. Pending text is cleared at settlement, shutdown, and session replacement/navigation (switch, fork, or tree navigation).
- A script hook `{ "id", "type": "script", "script": "relative.mjs", "timeoutMs": 5000 }` starts a Node `.mjs` child process. Script paths must remain under `<agent-dir>/pi-ad-hooks/`, including after symlink resolution. The default timeout is 5000 ms; valid values are 100–30000 ms.
- Scripts receive a version-1 JSON document on stdin shaped as `{ "version": 1, "event": "<exact-event>", "payload": <JSON-safe-event> }`. JSON serialization failure skips that invocation. Scripts are queued in configuration order per event and run asynchronously; Pi event handlers never await child completion. Independent events may overlap. `PI_CODING_AGENT_DIR` is the resolved agent directory; the child receives only `PATH`, `HOME`, `PI_CODING_AGENT_DIR`, and platform-required process variables.
- The `project_trust` API requires a handler result. This extension returns `{ trusted: "undecided" }` only to leave the decision to Pi's normal trust flow; configured hook actions never grant or deny trust. Script stdout, stderr, exit status, and returned values do not enter prompts or modify Pi operations.
- Configuration changes apply after extension reload or session restart.

## Failure behavior and recovery

Malformed or unreadable configuration, unknown events, invalid hook entries, unsupported prompt/event timing, invalid paths/timeouts, JSON serialization errors, process launch failures, nonzero exits, and timeouts are handled fail-open. Invalid hook entries are skipped; script failures do not block or change Pi behavior. Diagnostics include only hook id, event, stable code, and limited safe metadata. They omit event/prompt payloads, process output, stacks, and raw OS errors. Timed-out child processes are terminated. Background scripts are best-effort and may not finish before Pi exits, especially on `session_shutdown`.

## Security, privacy, and data-retention limits

Scripts are trusted code running with the Pi user's operating-system permissions; this extension does not sandbox them. Only relative `.mjs` paths confined to the user hooks directory are accepted. The explicit child environment is not the full Pi environment, but scripts may still access files and network resources available to the Pi user. Event payloads can contain sensitive prompts, paths, or tool arguments. The extension does not persist or log payloads or process output; operators must only configure trusted scripts.

## Non-goals / behavior intentionally not guaranteed

Hooks cannot block, approve, cancel, rewrite, or otherwise change Pi operations. Prompt text is advisory model context, not a system/developer prompt override. Scripts do not receive Pi API/context, and their output is ignored. Project/repository-local hook configuration, HTTP/MCP/model-based handlers, sandboxing, and automatic support for private or future Pi events are not included.

## Related contracts

- [Pi extension authoring](pi-extension-authoring.md)
- Pi event documentation: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#events
- Public `ExtensionAPI.on()` declarations: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts
