export interface PiSessionCommand {
  name: string;
  description?: string;
  source: string;
}

export interface TelegramCommandDefinition {
  name: string;
  aliases?: string[];
  description: string;
  menu?: Array<{ command: string; description: string }>;
  help: string;
}

export const TELEGRAM_COMMAND_DEFINITIONS: TelegramCommandDefinition[] = [
  { name: "start", aliases: ["help"], description: "Connect and show help", menu: [
    { command: "start", description: "Connect and show help" },
    { command: "help", description: "Show help" },
  ], help: "/start, /help — connect and show help" },
  { name: "status", description: "Pi status and session statistics", menu: [{ command: "status", description: "Pi status and session statistics" }], help: "/status — show Pi status, model, effort, context, and session statistics" },
  { name: "agents", description: "Background agents and tasks", menu: [{ command: "agents", description: "Background agents and tasks" }], help: "/agents — refresh the background-agent board" },
  { name: "queue", description: "Show queued tasks and their IDs", menu: [{ command: "queue", description: "Show queued tasks and their IDs" }], help: "/queue — show pending tasks and their IDs" },
  { name: "queue_cancel", aliases: ["queue-cancel"], description: "Remove a queued task by ID", menu: [{ command: "queue_cancel", description: "Remove a queued task by ID" }], help: "/queue_cancel <ID> — remove a pending task" },
  { name: "clear_queue", aliases: ["clear-queue"], description: "Clear pending tasks", menu: [{ command: "clear_queue", description: "Clear pending tasks" }], help: "/clear_queue — remove all pending tasks" },
  { name: "model", description: "List or select a model", menu: [{ command: "model", description: "List or select a model" }], help: "/model — list models; /model provider/model-id — select a model" },
  { name: "effort", description: "Thinking effort level", menu: [{ command: "effort", description: "Thinking effort level" }], help: "/effort — list levels; /effort <level> — select an effort level" },
  { name: "compact", description: "Compact context", menu: [{ command: "compact", description: "Compact context" }], help: "/compact [instructions] — compact context" },
  { name: "new", description: "Start a new session", menu: [{ command: "new", description: "Start a new session" }], help: "/new — start a new session" },
  { name: "bash", description: "Run a Bash command", menu: [{ command: "bash", description: "Run a Bash command" }], help: "/bash <command> — run Bash in Pi's working directory; long output is split across messages\nExample: /bash git status\nPass stdin inline: /bash printf 'y\\n' | command\nInteractive TTY and password prompts are unsupported; never send secrets through Telegram" },
  { name: "reload", description: "Reload extensions and resources", menu: [{ command: "reload", description: "Reload extensions and resources" }], help: "/reload — reload extensions and resources without restarting Pi" },
  { name: "cancel", description: "Stop the current task", menu: [{ command: "cancel", description: "Stop the current task" }], help: "/cancel — stop the current task or Bash command" },
];

const COMMAND_NAMES = new Map<string, string>();
for (const definition of TELEGRAM_COMMAND_DEFINITIONS) {
  COMMAND_NAMES.set(definition.name, definition.name);
  for (const alias of definition.aliases ?? []) COMMAND_NAMES.set(alias, definition.name);
}

export function normalizeTelegramCommand(command: string): string | undefined {
  return COMMAND_NAMES.get(command.toLowerCase());
}

export function getPluginTelegramCommands(commands: readonly PiSessionCommand[] = []): Array<{ command: string; description: string }> {
  const reserved = new Set(TELEGRAM_COMMAND_DEFINITIONS.flatMap((definition) => [definition.name, ...(definition.aliases ?? [])]));
  const seen = new Set<string>(reserved);
  const result: Array<{ command: string; description: string }> = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (command.source !== "extension" || !/^[a-z0-9_]{1,32}$/.test(name) || name.startsWith("telegram") || seen.has(name)) continue;
    seen.add(name);
    const description = (command.description || `Run ${name}`).replace(/[\r\n]+/g, " ").slice(0, 256);
    result.push({ command: name, description });
  }
  return result;
}

export function getTelegramCommandMenu(commands: readonly PiSessionCommand[] = []): Array<{ command: string; description: string }> {
  const builtIns = TELEGRAM_COMMAND_DEFINITIONS.flatMap((definition) => definition.menu ?? []);
  return [...builtIns, ...getPluginTelegramCommands(commands)].slice(0, 100);
}

export function isPluginTelegramCommand(name: string, commands: readonly PiSessionCommand[] = []): boolean {
  return getPluginTelegramCommands(commands).some((command) => command.command === name.toLowerCase());
}

export function telegramHelpText(commands: readonly PiSessionCommand[] = []): string {
  return [
    "I'm connected to a running Pi session. Send text to pass a task to the agent. Messages received while Pi is busy are added to a FIFO queue (up to 20 tasks) and run one at a time after each operation finishes. Background agents do not block new input after the parent turn completes.",
    ...TELEGRAM_COMMAND_DEFINITIONS.map((definition) => definition.help),
    ...getPluginTelegramCommands(commands).map((command) => `/${command.command} — ${command.description}`),
  ].join("\n\n");
}
