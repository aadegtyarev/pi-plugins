export interface TelegramCommandDefinition {
  name: string;
  aliases?: string[];
  description: string;
  menu?: Array<{ command: string; description: string }>;
  help: string;
}

export const TELEGRAM_COMMAND_DEFINITIONS: TelegramCommandDefinition[] = [
  { name: "start", aliases: ["help"], description: "Подключиться и показать справку", menu: [
    { command: "start", description: "Подключиться и показать справку" },
    { command: "help", description: "Показать справку" },
  ], help: "/start, /help — подключиться и показать справку" },
  { name: "status", description: "Состояние Pi и статистика сессии", menu: [{ command: "status", description: "Состояние Pi и статистика сессии" }], help: "/status — состояние Pi, модель, effort, контекст и статистика сессии" },
  { name: "agents", description: "Фоновые сабагенты и задачи", menu: [{ command: "agents", description: "Фоновые сабагенты и задачи" }], help: "/agents — обновить доску фоновых сабагентов" },
  { name: "queue", description: "Показать очередь задач и их ID", menu: [{ command: "queue", description: "Показать очередь задач и их ID" }], help: "/queue — показать ожидающие задачи и их ID" },
  { name: "queue_cancel", aliases: ["queue-cancel"], description: "Удалить задачу из очереди по ID", menu: [{ command: "queue_cancel", description: "Удалить задачу из очереди по ID" }], help: "/queue_cancel <ID> — удалить ожидающую задачу" },
  { name: "clear_queue", aliases: ["clear-queue"], description: "Очистить ожидающие задачи", menu: [{ command: "clear_queue", description: "Очистить ожидающие задачи" }], help: "/clear_queue — удалить все ожидающие задачи" },
  { name: "model", description: "Список или выбор модели", menu: [{ command: "model", description: "Список или выбор модели" }], help: "/model — список моделей; /model provider/model-id — выбрать модель" },
  { name: "effort", description: "Уровень thinking effort", menu: [{ command: "effort", description: "Уровень thinking effort" }], help: "/effort — список уровней; /effort <level> — выбрать effort" },
  { name: "compact", description: "Сжать контекст", menu: [{ command: "compact", description: "Сжать контекст" }], help: "/compact [инструкции] — сжать контекст" },
  { name: "new", description: "Начать новую сессию", menu: [{ command: "new", description: "Начать новую сессию" }], help: "/new — начать новую сессию" },
  { name: "bash", description: "Выполнить Bash-команду", menu: [{ command: "bash", description: "Выполнить Bash-команду" }], help: "/bash <command> — выполнить Bash в папке Pi; длинный вывод разбивается на сообщения\nПример: /bash git status\nВвод через stdin: /bash printf 'y\\n' | команда\nИнтерактивный TTY и ввод паролей не поддерживаются; не отправляйте секреты в Telegram" },
  { name: "reload", description: "Перезагрузить расширения и ресурсы", menu: [{ command: "reload", description: "Перезагрузить расширения и ресурсы" }], help: "/reload — перечитать расширения и ресурсы без перезапуска Pi" },
  { name: "cancel", description: "Остановить текущую задачу", menu: [{ command: "cancel", description: "Остановить текущую задачу" }], help: "/cancel — остановить текущую задачу или Bash-команду" },
];

const COMMAND_NAMES = new Map<string, string>();
for (const definition of TELEGRAM_COMMAND_DEFINITIONS) {
  COMMAND_NAMES.set(definition.name, definition.name);
  for (const alias of definition.aliases ?? []) COMMAND_NAMES.set(alias, definition.name);
}

export function normalizeTelegramCommand(command: string): string | undefined {
  return COMMAND_NAMES.get(command.toLowerCase());
}

export function getTelegramCommandMenu(): Array<{ command: string; description: string }> {
  return TELEGRAM_COMMAND_DEFINITIONS.flatMap((definition) => definition.menu ?? []);
}

export function telegramHelpText(): string {
  return [
    "Я подключён к запущенной сессии Pi. Отправьте текст — передам его агенту. Сообщения во время занятого Pi попадают в FIFO-очередь (до 20 задач) и запускаются по одной после завершения каждой операции. Фоновые сабагенты сами по себе не блокируют новый ввод после ответа родительской задачи.",
    ...TELEGRAM_COMMAND_DEFINITIONS.map((definition) => definition.help),
  ].join("\n\n");
}
