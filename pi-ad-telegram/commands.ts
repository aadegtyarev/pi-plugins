
import { TASK_HELP } from "../pi-ad-hooks/task.ts";

const TELEGRAM_COMMAND_DESCRIPTION_LIMIT = 256;
const TELEGRAM_COMMAND_MENU_LIMIT = 100;

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

interface ResolvedPluginCommand {
  command: string;
  piCommand: string;
  description: string;
}

function resolvePluginTelegramCommands(commands: readonly PiSessionCommand[]): ResolvedPluginCommand[] {
  const reserved = new Set(TELEGRAM_COMMAND_DEFINITIONS.flatMap((definition) => [definition.name, ...(definition.aliases ?? [])]));
  const seen = new Set<string>(reserved);
  const result: ResolvedPluginCommand[] = [];
  for (const command of commands) {
    const piCommand = command.name;
    const name = piCommand.toLowerCase();
    if (command.source !== "extension" || !/^[a-z0-9_-]{1,32}$/.test(name) || name.startsWith("telegram")) continue;
    const telegramCommand = name.replace(/-/g, "_");
    if (seen.has(telegramCommand)) continue;
    seen.add(telegramCommand);
    const description = (command.description || `Run ${piCommand}`).replace(/[\r\n]+/g, " ").slice(0, TELEGRAM_COMMAND_DESCRIPTION_LIMIT);
    result.push({ command: telegramCommand, piCommand, description });
  }
  return result;
}

export function getPluginTelegramCommands(commands: readonly PiSessionCommand[] = []): Array<{ command: string; description: string }> {
  return resolvePluginTelegramCommands(commands).map(({ command, description }) => ({ command, description }));
}

export function getTelegramCommandMenu(commands: readonly PiSessionCommand[] = []): Array<{ command: string; description: string }> {
  const builtIns = TELEGRAM_COMMAND_DEFINITIONS.flatMap((definition) => definition.menu ?? []);
  return [...builtIns, ...getPluginTelegramCommands(commands)].slice(0, TELEGRAM_COMMAND_MENU_LIMIT);
}

export function getPluginTelegramCommand(name: string, commands: readonly PiSessionCommand[] = []): ResolvedPluginCommand | undefined {
  return resolvePluginTelegramCommands(commands).find((command) => command.command === name.toLowerCase());
}

export function telegramHelpText(commands: readonly PiSessionCommand[] = []): string {
  const pluginCommands = getPluginTelegramCommands(commands);
  const hasTaskCommand = pluginCommands.some((command) => command.command === "task");
  return [
    "I'm connected to a running Pi session. Send text or attachments to pass a task to the agent; messages received while Pi is busy use Pi's steering queue. Inputs that Pi cannot accept are rejected rather than deferred. Background agents do not block new input after the parent turn completes.",
    ...TELEGRAM_COMMAND_DEFINITIONS.map((definition) => definition.help),
    ...pluginCommands.filter((command) => command.command !== "task").map((command) => `/${command.command} — ${command.description}`),
    ...(hasTaskCommand ? [TASK_HELP] : []),
  ].join("\n\n");
}
