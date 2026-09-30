# pi-ad-session-usage

A standalone Pi extension for reporting token usage and Pi-estimated USD cost from the active session branch.

## Setup

Make this directory available in Pi's user extensions directory, for example with a symlink:

```bash
ln -s /path/to/pi-plugins/pi-ad-session-usage ~/.pi/agent/extensions/pi-ad-session-usage
```

Restart Pi or reload extensions. The extension registers the model-callable `session_usage_report` tool and posts a separate summary after each settled run. The tool provides a readable summary plus JSON data in its model-visible output and structured result details.

## Data limits

Parent usage comes from assistant messages in the active branch. Direct subagent results are included only when recognized persisted metadata is present; Pi's subagent aggregates can lose per-field availability, so child data is marked partial or unavailable rather than treated as exact zeros. Cost uses only Pi-reported usage and is an estimate, not a provider invoice. The extension performs no network requests and does not publish or edit pull requests.

Run repository checks from the project root with `npm test` and `npm run typecheck`.
