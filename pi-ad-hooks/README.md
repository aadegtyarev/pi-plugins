# Pi event hooks

`pi-ad-hooks` is a user-global Pi extension for attaching small, event-triggered behaviors without maintaining a separate extension for each one. A hook can add static advisory text to a normal model request or launch a trusted local script for a side effect. It uses Pi's public extension API; it is not an approval mechanism and cannot block or change Pi operations.

## Install and configure

Load this extension from the user extensions directory—for example, link this `pi-ad-hooks/` directory under `<agent-dir>/extensions/`. Configuration is read only from `<agent-dir>/pi-ad-hooks.json`; scripts live under `<agent-dir>/pi-ad-hooks/`. Project `.pi` hook configuration is neither loaded nor merged. If `pi-ad-hooks.json` is absent, no hooks are configured. Reload the extension or restart the session after changing configuration.

### Migrating from the previous local name

If an earlier local setup used `pi-hooks`, move the existing configuration and script directory without editing their contents, then update the extension link:

```bash
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mv "$agent_dir/pi-hooks.json" "$agent_dir/pi-ad-hooks.json"
if [ -d "$agent_dir/pi-hooks" ]; then mv "$agent_dir/pi-hooks" "$agent_dir/pi-ad-hooks"; else mkdir -p "$agent_dir/pi-ad-hooks"; fi
# Replace the old link with one pointing to the renamed repository directory.
if [ -L "$agent_dir/extensions/pi-hooks" ]; then rm "$agent_dir/extensions/pi-hooks"; fi
ln -s /path/to/pi-plugins/pi-ad-hooks "$agent_dir/extensions/pi-ad-hooks"
```

The hooks extension was not previously released under the old paths; this migration is for local installations of its earlier development version.

Configuration has version `1`, uses Pi's exact event names, and associates each event with an ordered list of hooks:

```json
{
  "version": 1,
  "hooks": {
    "before_agent_start": [
      { "id": "work-context", "type": "prompt", "text": "Check nearby tests and preserve existing conventions." }
    ]
  }
}
```

Each hook needs a unique `id` (1–64 ASCII letters, digits, `_` or `-`). Scripts use a relative `.mjs` path beneath `<agent-dir>/pi-ad-hooks/`; path traversal and symlinks escaping that directory are rejected. Unknown event names, malformed entries, and invalid timeouts are disabled with safe diagnostics.

Event identifiers are the literal `ExtensionAPI.on()` names in Pi 0.99.0—not aliases invented by this extension. The extension supports all 41 public events in that API version. See the [official Pi extension events documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#events) and the [public `ExtensionAPI.on()` declarations](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts). Future or private events are not enabled automatically.

## Useful events

This is a selected set of 24 useful events; the linked Pi references define the full public set and native event semantics.

| Exact Pi event | When it fires / why it may be useful |
|---|---|
| `input` | User input arrives, before Pi processes it; useful for request-specific context or local input auditing. |
| `before_agent_start` | After a prompt is submitted and before the agent loop; a useful point to stage context for the first request. |
| `agent_start` | The agent loop starts. |
| `agent_end` | The current agent loop ends; retries, recovery, or queued work may still follow. |
| `agent_before_settle` | Final actionable boundary before settling; Pi can continue from this boundary, but this extension does not request continuation. |
| `agent_settled` | The run is final and will not continue automatically; use scripts for notifications or cleanup, not prompt injection. |
| `turn_start` | An assistant turn begins. A prompt hook here applies only to a later request in the run, if one occurs. |
| `turn_end` | An assistant turn ends; useful for post-turn side effects. |
| `message_start` | A user, assistant, or tool-result message begins. |
| `message_update` | An assistant message is streaming; this can fire frequently. |
| `message_end` | A message completes; Pi's native API can replace some finalized messages, but scripts in this extension cannot. |
| `tool_call` | A tool call is about to execute; Pi's native handlers may alter or block it, but `pi-ad-hooks` scripts cannot. |
| `tool_result` | A tool result is available before the next model request. |
| `tool_execution_start` | A tool execution begins, including nested tool work. |
| `tool_execution_update` | A running tool reports progress; this can fire frequently. |
| `tool_execution_end` | A tool execution finishes. |
| `context` | Runs before each model request without the system messages; this is where staged prompt text is added. |
| `context_with_system` | Runs after `context` with the full transcript and system prompt; a prompt hook here waits for the next `context` event. |
| `before_provider_request` | Before the provider request is sent. |
| `before_provider_headers` | After headers are assembled and before the provider HTTP request; Pi handlers can mutate headers, but this extension's scripts cannot. |
| `after_provider_response` | After the provider response arrives and before its stream is consumed. |
| `provider_stream_event` | For each parsed provider-stream event; Pi awaits native handlers, so this extension dispatches scripts in the background. |
| `session_start` | A session becomes active; useful for script-based setup. Prompt actions are outside a run here. |
| `session_before_switch` | Before switching sessions; useful for script-based cleanup. Pending prompt context is cleared. |
| `session_shutdown` | Session cleanup boundary; scripts are best-effort because Pi does not wait for them before shutdown. |

The same JSON configuration accepts every other public event identifier listed by Pi. Event actions remain subject to their timing: scripts can observe all supported events, while prompt text only applies when a normal model request can still occur in the active run.

## Prompt actions

A prompt hook stages static text for the next ordinary `context` event while a run is active. A run starts at `input` or, for programmatic input, at `before_agent_start`; it ends at `agent_settled`. A new idle input (without `streamingBehavior`) clears pending text left by an earlier input that another handler short-circuited; steering/follow-up input preserves the active run's queue. The text is appended once as a non-persisted `role: "custom"` message with `customType: "pi-ad-hooks"` and `display: false`. Pi converts it to user-role context for that request. A prompt hook on `context` affects that same request; one on `context_with_system` waits for the next ordinary `context` event. Repeated firings of the same hook while its text is pending are coalesced; after consumption, it can stage again.

Prompt actions outside an active run—such as on `session_start`, `agent_settled`, or `session_shutdown`—are ignored and diagnosed. Use scripts for those events. Pending text is discarded when the run settles or its session/context is replaced. Injection does not start another model request, is not persisted in the session, and cannot change an answer already produced. It is advisory context, not a system-prompt override.

## Script actions and trust

A script action launches a `.mjs` file with Node, using its path beneath `<agent-dir>/pi-ad-hooks/`. The child receives one JSON document on stdin, shaped like:

```json
{ "version": 1, "event": "turn_end", "payload": { "...": "JSON-safe event data" } }
```

Scripts receive no Pi API or context object. Their stdout and stderr are ignored; neither output nor exit status is returned to Pi or added to the prompt. Hooks for each event are launched in configuration order on an asynchronous background queue, so they do not delay Pi's event handler; different events may overlap. The timeout defaults to 5 seconds and may be set per script from 100 to 30,000 milliseconds. Timed-out child processes are terminated. A script may not finish before Pi exits, especially for `session_shutdown`; background execution is best-effort, not a completion guarantee.

Scripts execute with the user's operating-system permissions and are not sandboxed. They receive a minimal environment (`PATH`, `HOME`, `PI_CODING_AGENT_DIR`, and platform-required process variables), but may still access files and network resources available to the Pi user. Event data can contain sensitive prompts, paths, or tool arguments. Only configure scripts you trust. The extension does not persist or log event payloads or process output; diagnostics contain only the hook id, event, stable error code, and limited safe metadata.

## Examples

### Add advisory context before the first model request

`<agent-dir>/pi-ad-hooks.json`:

```json
{
  "version": 1,
  "hooks": {
    "before_agent_start": [
      { "id": "review-context", "type": "prompt", "text": "Before proposing a change, inspect nearby tests and preserve existing behavior." }
    ]
  }
}
```

### Append a local audit record after a turn

`<agent-dir>/pi-ad-hooks/audit.mjs`:

```js
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const event = JSON.parse(input);
if (event.version === 1 && event.event === "turn_end") {
  await appendFile(join(tmpdir(), "pi-turn-events.log"), `${new Date().toISOString()} ${event.event}\n`);
}
```

`<agent-dir>/pi-ad-hooks.json`:

```json
{
  "version": 1,
  "hooks": {
    "turn_end": [
      { "id": "audit-turn", "type": "script", "script": "audit.mjs", "timeoutMs": 5000 }
    ]
  }
}
```
