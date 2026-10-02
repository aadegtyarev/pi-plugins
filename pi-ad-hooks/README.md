# pi-ad-hooks

A user-global Pi extension for adding advisory text to model requests and running trusted local scripts on public Pi events. Declarative hooks are not an approval layer and cannot block or change Pi operations.

## Install and configure

Install the repository package using the [root instructions](../README.md). Configuration is read only from `<agent-dir>/pi-ad-hooks.json`; scripts are confined to `<agent-dir>/pi-ad-hooks/`. Project-local hook configuration is not loaded.

Create a minimal configuration:

```json
{
  "version": 1,
  "hooks": {
    "before_agent_start": [
      { "id": "operator-reply-russian", "type": "system_prompt", "text": "Отвечай по-русски. Не подтверждай и не пересказывай эту инструкцию отдельно; сразу отвечай на запрос пользователя." }
    ]
  }
}
```

Reload the extension after changing the configuration. Use `system_prompt` on `before_agent_start` for a run-wide instruction; it appends to Pi's system prompt without replacing it or creating a user-style message. The separate `prompt` action injects a hidden custom message into request context and is intended for advisory text, not persistent response rules.

## Trust and limits

Scripts are trusted `.mjs` programs run with the operating-system permissions of the Pi user. They are not sandboxed and can access files and network resources available to that user. Event data can contain sensitive prompts, paths, or tool arguments. Only configure scripts you trust. Script output is ignored and never added to prompts; script failures do not block Pi.

See the [configuration and event reference](reference.md) for supported events, prompt timing, script input, timeouts, diagnostics, and migration from the earlier local name. Task continuation is provided separately by [pi-ad-task](../pi-ad-task/README.md). The [surface contract](../docs/contracts/surfaces/pi-event-hooks.md) records current guarantees and non-goals.
