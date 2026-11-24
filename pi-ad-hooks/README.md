# pi-ad-hooks

Hooks let you react to things that happen in Pi without writing an extension. You describe them in one JSON file, and the extension does one of three things when the chosen event fires:

- **`system_prompt`** — add your text to Pi's system prompt for each request. Good for standing rules like "always answer in English".
- **`prompt`** — slip a one-time hidden note into the next model request.
- **`script`** — run your own Node.js script and hand it the event data. Good for logging, notifications on your machine, and so on.

Hooks only add things. They cannot block a tool, cancel a request, or change Pi's answer.

## Your first hook

Create `~/.pi/agent/pi-ad-hooks.json` (or the same file in your own Pi agent directory, if you changed it):

```json
{
  "version": 1,
  "hooks": {
    "before_agent_start": [
      { "id": "reply-language", "type": "system_prompt", "text": "Reply in English." }
    ]
  }
}
```

Run `/reload` in Pi or restart it. From now on every request carries that instruction.

If all you need is a fixed system-prompt addition, Pi can also do that without this extension: put the text in `~/.pi/agent/APPEND_SYSTEM.md`.

## Running a script

```json
{
  "version": 1,
  "hooks": {
    "turn_end": [
      { "id": "log-turns", "type": "script", "script": "log-turn.mjs" }
    ]
  }
}
```

Put `log-turn.mjs` in `~/.pi/agent/pi-ad-hooks/`. It receives the event as JSON on standard input:

```js
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { event, payload } = JSON.parse(input);
// do something with it
```

Scripts are **not sandboxed**: they run as you and can see prompts, file paths and tool arguments in the event data. Only use scripts you wrote or trust. Pi does not wait for a script, ignores its output, and keeps working if it fails.

## More

- [Reference](reference.md): every supported event, all options, limits, and error messages.
- [Hooks contract](../docs/contracts/surfaces/pi-event-hooks.md): exact guarantees.
- Running Pi on a goal until it is done is a separate extension: [`pi-ad-task`](../pi-ad-task/README.md).
