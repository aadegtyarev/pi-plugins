# pi-ad-hooks

Add configured context to Pi requests or run trusted local scripts when public Pi events fire. Hooks are advisory: they cannot approve, block, cancel, or rewrite Pi operations.

## Set up a hook

Install `pi-plugins` using the [root instructions](../README.md). Save configuration at `<agent-dir>/pi-ad-hooks.json`; scripts, if used, belong under `<agent-dir>/pi-ad-hooks/`. Project-local configuration is not loaded.

This example appends a standing instruction to each agent run:

```json
{
  "version": 1,
  "hooks": {
    "before_agent_start": [
      { "id": "operator-reply-language", "type": "system_prompt", "text": "Reply in English." }
    ]
  }
}
```

Use `system_prompt` on `before_agent_start` for run-wide instructions. It appends to Pi's system prompt; it does not replace it or add a user-style message. The separate `prompt` action adds advisory context to the next ordinary request.

## Trust and limits

Scripts are trusted `.mjs` programs, not sandboxed. They run with your operating-system permissions and may receive sensitive event data. Only configure scripts you trust. Their output is ignored, and failures do not block Pi.

See the [event and configuration reference](reference.md) for all supported events, action shapes, timing, timeouts, diagnostics, and migration notes. Task continuation is a separate [extension](../pi-ad-task/README.md). The [hooks contract](../docs/contracts/surfaces/pi-event-hooks.md) records guarantees and non-goals.
