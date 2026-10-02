import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "pi-ad-hooks-task";
const MESSAGE_TYPE = "pi-ad-hooks-task-continuation";
const MAX_CONTINUATIONS = 20;

export const TASK_HELP = [
  "Команды задачи:",
  "/task <цель> — начать задачу. Пример: /task Исправить баг и запустить тесты. Для цели, начинающейся с команды, используйте /task start <цель>.",
  "/task status — показать состояние, цель и прогресс.",
  "/task pause — не продолжать после текущего запуска Pi; сам запущенный вызов не отменяется.",
  "/task resume [ответ] — продолжить задачу; добавьте ответ на вопрос/блокер после resume.",
  "/task done — отметить задачу выполненной.",
  "/task stop — завершить задачу и освободить место для новой; текущий вызов Pi не отменяется. /cancel останавливает текущий ход и ставит активную задачу на паузу.",
  "Пока задача active, Pi делает до 20 автоматических продолжений. Модель записывает прогресс через task_update; action=blocked ждёт вашего ответа, done завершает задачу.",
  "Команды pause, done и stop отключают следующие продолжения, но не отменяют уже идущий вызов модели.",
  "Пример ответа на блокер: /task resume Подтверждаю выбранный scope. Одновременно поддерживается одна задача: незавершённую сначала resume или stop.",
].join("\n");

type Status = "active" | "paused" | "done" | "stopped" | "blocked";
interface TaskState {
  version: 1;
  goal: string;
  progress: string;
  status: Status;
  continuations: number;
  telegramChatId?: number;
}

export interface TaskCommandResult {
  message: string;
  tone: "info" | "warning";
  prompt?: string;
}

function isState(value: unknown): value is TaskState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<TaskState>;
  return state.version === 1 && typeof state.goal === "string" && typeof state.progress === "string" &&
    ["active", "paused", "done", "stopped", "blocked"].includes(state.status ?? "") &&
    Number.isInteger(state.continuations) && (state.continuations ?? -1) >= 0 && (state.continuations ?? 21) <= MAX_CONTINUATIONS &&
    (state.telegramChatId === undefined || (Number.isSafeInteger(state.telegramChatId) && state.telegramChatId > 0));
}

function current(ctx: ExtensionContext): TaskState | undefined {
  if (!ctx.sessionManager || typeof ctx.sessionManager.getBranch !== "function") return undefined;
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as { type?: string; customType?: string; data?: unknown };
    if (entry.type === "custom" && entry.customType === ENTRY_TYPE) return isState(entry.data) ? { ...entry.data } : undefined;
  }
  return undefined;
}

function persist(pi: ExtensionAPI, state: TaskState): void {
  pi.appendEntry(ENTRY_TYPE, { ...state });
}

function expose(pi: ExtensionAPI, enabled: boolean): void {
  if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
  const active = pi.getActiveTools();
  const has = active.includes("task_update");
  if (enabled && !has) pi.setActiveTools([...active, "task_update"]);
  if (!enabled && has) pi.setActiveTools(active.filter(name => name !== "task_update"));
}

function extractGoal(value: string): string {
  const text = value.trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function taskStatus(state: TaskState | undefined): string {
  if (!state) return `Задача не записана в этой ветке сессии.\nЧтобы начать: /task <цель>\n\n${TASK_HELP}`;
  const progress = state.progress || "прогресс ещё не записан";
  const next = state.status === "blocked" ? "Ответьте на блокер: /task resume <ваш ответ>." :
    state.status === "paused" ? "Продолжить: /task resume." :
      state.status === "active" ? "Задача продолжится автоматически после успешного шага." :
        state.status === "done" ? "Задача завершена." : "Задача остановлена. Можно начать новую через /task start <цель>.";
  return `Задача: ${state.status}\nЦель: ${state.goal}\nПрогресс: ${progress}\nАвтопродолжения: ${state.continuations}/${MAX_CONTINUATIONS}\n${next}`;
}

export function getTaskSummary(ctx: ExtensionContext): { status: Status; goal: string; telegramChatId?: number } | undefined {
  const state = current(ctx);
  return state ? { status: state.status, goal: state.goal, ...(state.telegramChatId === undefined ? {} : { telegramChatId: state.telegramChatId }) } : undefined;
}

function result(message: string, tone: TaskCommandResult["tone"] = "info", prompt?: string): TaskCommandResult {
  return { message, tone, ...(prompt === undefined ? {} : { prompt }) };
}

/** Shared command implementation for Pi's TUI and the Telegram bridge. */
export function runTaskCommand(pi: ExtensionAPI, args: string, ctx: ExtensionContext, options: { telegramChatId?: number } = {}): TaskCommandResult {
  const match = /^([^\s]+)(?:\s+([\s\S]*))?$/.exec(args.trim());
  const action = match?.[1]?.toLowerCase();
  const value = match?.[2]?.trim() ?? "";
  const state = current(ctx);

  const managementActions = ["start", "status", "pause", "resume", "done", "stop"];
  if (!action) return result(TASK_HELP);
  if (action === "status") return result(taskStatus(state));

  if (action === "start" || !managementActions.includes(action)) {
    const goal = extractGoal(action === "start" ? value : args);
    if (!goal) return result(`Укажите цель задачи. Пример: /task start "Исправить баг и проверить тестами".\n\n${TASK_HELP}`, "warning");
    if (!ctx.isIdle()) {
      const canReplace = state && !["done", "stopped"].includes(state.status);
      const recovery = canReplace
        ? `Дождитесь завершения текущего запуска; чтобы заменить текущую задачу, используйте /task stop, затем /task start <цель>.${state.status === "blocked" ? " Чтобы продолжить её вместо замены, ответьте: /task resume <ответ>." : ""}`
        : "Дождитесь завершения текущего запуска и повторите /task start <цель>.";
      return result(`Нельзя начать задачу, пока Pi занят. ${recovery}${canReplace ? ` Текущая задача: ${state.status} — ${state.goal}.` : ""}`, "warning");
    }
    if (state && !["done", "stopped"].includes(state.status)) {
      const recover = state.status === "blocked" ? "/task resume <ответ на блокер> или /task stop, затем /task start <новая цель>." :
        state.status === "paused" ? "/task resume или /task stop, затем /task start <новая цель>." :
          "Дождитесь завершения текущего запуска или выполните /task stop, затем /task start <новая цель>.";
      return result(`Новая задача не запущена: уже есть задача со статусом ${state.status}: ${state.goal}\n${recover}`, "warning");
    }
    const next: TaskState = { version: 1, goal, progress: "", status: "active", continuations: 0, ...(options.telegramChatId === undefined ? {} : { telegramChatId: options.telegramChatId }) };
    persist(pi, next);
    expose(pi, true);
    return result(`✅ Задача запущена.\nЦель: ${goal}\nИспользуйте /task status для проверки, /task pause для паузы или /task stop для остановки.`, "info", goal);
  }

  if (action === "resume") {
    if (!state) return result("Нечего возобновлять. Начните задачу командой /task <цель>.", "warning");
    if (!["paused", "blocked"].includes(state.status)) {
      const next = state.status === "active" ? "Задача уже выполняется; используйте /task status." : `Задача ${state.status} и не возобновляется. Для новой задачи: /task <цель>.`;
      return result(next, "warning");
    }
    if (!ctx.isIdle()) return result("Нельзя возобновить задачу, пока Pi занят. Проверьте /task status, дождитесь завершения текущего запуска и повторите /task resume [ответ].", "warning");
    state.status = "active";
    persist(pi, state);
    expose(pi, true);
    const response = value ? `\nОтвет пользователя: ${value}` : "";
    const prompt = `Continue the task: ${state.goal}${state.progress ? `\nLatest progress: ${state.progress}` : ""}${response}`;
    return result(`▶️ Задача возобновлена.${value ? " Ваш ответ добавлен к контексту." : ""}\nЦель: ${state.goal}`, "info", prompt);
  }

  if (!state) return result(`Нет активной задачи для команды /task ${action}. Начните её: /task start <цель>.`, "warning");
  if (action === "pause") {
    if (state.status !== "active") {
      const recovery = state.status === "blocked" ? "Ответьте на блокер: /task resume <ответ>, либо /task stop." :
        state.status === "paused" ? "Задача уже на паузе: /task resume или /task stop." :
          `Задача уже ${state.status}; новую можно начать командой /task start <цель>.`;
      return result(`Нельзя поставить на паузу задачу со статусом ${state.status}. ${recovery}`, "warning");
    }
    state.status = "paused";
    persist(pi, state);
    expose(pi, false);
    return result(`⏸ Автопродолжение приостановлено; текущий запуск Pi не отменяется. Возобновить: /task resume.\nЦель: ${state.goal}`);
  }
  if (action === "done") {
    if (state.status === "done") return result("Задача уже завершена. Проверьте /task status или начните новую: /task start <цель>.", "warning");
    if (state.status === "stopped") return result("Остановленную задачу нельзя завершить. Начните новую: /task start <цель>.", "warning");
    state.status = "done";
    persist(pi, state);
    expose(pi, false);
    return result(`✅ Задача отмечена выполненной.\nЦель: ${state.goal}`);
  }
  if (action === "stop") {
    if (["done", "stopped"].includes(state.status)) return result(`Задача уже ${state.status}; останавливать больше нечего. Чтобы начать новую: /task start <цель>.`, "warning");
    state.status = "stopped";
    persist(pi, state);
    expose(pi, false);
    return result(`⏹ Автопродолжение остановлено; текущий запуск Pi не отменяется. Теперь можно начать новую: /task start <цель>.\nПредыдущая цель: ${state.goal}`);
  }
  return result(TASK_HELP, "warning");
}

export function registerTaskContinuation(pi: ExtensionAPI): void {
  // Keep event-only host fakes and older minimal hosts functional; Pi 0.99 exposes both APIs.
  if (typeof pi.registerTool !== "function") return;
  let telegramChatId: number | undefined;
  pi.events?.on("pi-ad-telegram:run-chat", (event) => {
    const chatId = (event as { chatId?: unknown } | undefined)?.chatId;
    telegramChatId = Number.isSafeInteger(chatId) && Number(chatId) > 0 ? Number(chatId) : undefined;
  });
  pi.on("agent_settled", () => { telegramChatId = undefined; });

  pi.registerTool({
    name: "task_control",
    label: "Control task",
    description: "Carry out the operator's explicit request to start or manage the single bounded task. Never start without explicit operator consent; validate the current task state.",
    promptSnippet: "Manage one operator-approved bounded task",
    exposure: "direct",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("start"), Type.Literal("status"), Type.Literal("pause"), Type.Literal("resume"), Type.Literal("done"), Type.Literal("stop")]),
      goal: Type.Optional(Type.String({ description: "Task goal for start." })),
      note: Type.Optional(Type.String({ description: "Optional blocker answer or transition note." })),
    }),
    async execute(_id, params, _signal, _update, ctx: ExtensionToolContext) {
      const state = current(ctx);
      const canReplaceTerminalTask = params.action === "start" && state && ["done", "stopped"].includes(state.status);
      if (telegramChatId !== undefined && state && state.telegramChatId !== telegramChatId && !canReplaceTerminalTask) {
        return { content: [{ type: "text", text: "Задачей из этого Telegram-чата управлять нельзя: она создана в Pi или принадлежит другому чату. Используйте исходный чат или управляйте задачей в Pi." }], details: undefined, isError: true };
      }
      if (params.action === "status") return { content: [{ type: "text", text: taskStatus(state) }], details: undefined };
      if (params.action === "start") {
        const goal = params.goal?.trim();
        if (!goal) return { content: [{ type: "text", text: "Для старта укажите goal; оператор должен явно попросить запустить задачу." }], details: undefined, isError: true };
        if (state && !["done", "stopped"].includes(state.status)) return { content: [{ type: "text", text: `Уже есть задача со статусом ${state.status}: ${state.goal}. Сначала продолжите её или остановите командой /task stop.` }], details: undefined, isError: true };
        const next: TaskState = { version: 1, goal, progress: "", status: "active", continuations: 0, ...(telegramChatId === undefined ? {} : { telegramChatId }) };
        persist(pi, next);
        expose(pi, true);
        return { content: [{ type: "text", text: `Задача запущена: ${goal}. Работайте над этой целью и записывайте этапы через task_update.` }], details: undefined };
      }
      if (!state) return { content: [{ type: "text", text: "Активной задачи нет. Для старта дождитесь явной просьбы оператора и вызовите task_control с action=start." }], details: undefined, isError: true };
      if (params.action === "pause") {
        if (state.status !== "active") return { content: [{ type: "text", text: `Нельзя поставить на паузу задачу со статусом ${state.status}. Проверьте status или возобновите заблокированную задачу.` }], details: undefined, isError: true };
        state.status = "paused";
      } else if (params.action === "resume") {
        if (!["paused", "blocked"].includes(state.status)) return { content: [{ type: "text", text: `Нельзя возобновить задачу со статусом ${state.status}.` }], details: undefined, isError: true };
        state.status = "active";
        if (params.note?.trim()) state.progress = `${state.progress}${state.progress ? "\\n" : ""}Ответ пользователя: ${params.note.trim()}`;
      } else if (params.action === "done") {
        if (["done", "stopped"].includes(state.status)) return { content: [{ type: "text", text: `Задача уже ${state.status}.` }], details: undefined, isError: true };
        state.status = "done";
      } else if (params.action === "stop") {
        if (["done", "stopped"].includes(state.status)) return { content: [{ type: "text", text: `Задача уже ${state.status}.` }], details: undefined, isError: true };
        state.status = "stopped";
      }
      persist(pi, state);
      expose(pi, state.status === "active");
      return { content: [{ type: "text", text: `Задача ${state.status}: ${state.goal}${params.note ? `\\n${params.note}` : ""}` }], details: undefined };
    },
  });

  pi.registerTool({
    name: "task_update",
    label: "Update task",
    description: "Record progress on the active task, mark it done, or mark it blocked pending user input.",
    promptSnippet: "Update progress on the active task",
    exposure: "direct",
    defaultActive: false,
    parameters: Type.Object({
      action: Type.Union([Type.Literal("progress"), Type.Literal("done"), Type.Literal("blocked")]),
      note: Type.Optional(Type.String({ description: "Progress, completion summary, or blocker. Do not include secrets." })),
    }),
    async execute(_id, params, _signal, _update, ctx: ExtensionToolContext) {
      const state = current(ctx);
      if (!state) return { content: [{ type: "text", text: "Нет активной задачи для обновления. Начните её командой /task start <цель>." }], details: undefined, isError: true };
      if (state.status !== "active") {
        const recovery = ["paused", "blocked"].includes(state.status)
          ? (state.status === "blocked" ? "Ответьте на блокер: /task resume <ответ>." : "Возобновите задачу: /task resume.")
          : `Задача уже ${state.status}; начните новую: /task start <цель>.`;
        return { content: [{ type: "text", text: `Нельзя обновить задачу со статусом ${state.status}. ${recovery}` }], details: undefined, isError: true };
      }
      state.progress = params.note?.trim() || state.progress;
      if (params.action === "done") state.status = "done";
      if (params.action === "blocked") state.status = "blocked";
      persist(pi, state);
      expose(pi, state.status === "active");
      const guidance = state.status === "blocked" ? " Use /task resume <ответ> to answer and continue, or /task stop to stop." :
        state.status === "done" ? " The task is complete." : "";
      return { content: [{ type: "text", text: `Task ${state.status}${state.progress ? `: ${state.progress}` : "."}${guidance}` }], details: undefined };
    },
  });

}

export function restoreTaskTools(pi: ExtensionAPI, ctx: ExtensionContext | undefined): void {
  if (!ctx) return;
  expose(pi, current(ctx)?.status === "active");
}

export function continueTask(pi: ExtensionAPI, event: import("@earendil-works/pi-coding-agent").AgentBeforeSettleEvent, ctx: ExtensionContext) {
  const state = current(ctx);
  if (!state || state.status !== "active") return;
  if (event.outcome !== "completed") {
    state.status = "paused";
    persist(pi, state); expose(pi, false);
    ctx.ui.notify(`Задача поставлена на паузу: запуск завершился со статусом ${event.outcome}. Проверьте /task status и продолжите через /task resume [ответ].`, "warning");
    return;
  }
  if (state.continuations >= MAX_CONTINUATIONS) {
    state.status = "paused";
    persist(pi, state); expose(pi, false);
    ctx.ui.notify(`Задача приостановлена после ${MAX_CONTINUATIONS} автопродолжений. Проверьте прогресс командой /task status; для следующего шага используйте /task resume [ответ].`, "warning");
    return;
  }
  state.continuations++;
  persist(pi, state);
  return {
    entries: [...event.entries, {
      type: "custom_message" as const,
      customType: MESSAGE_TYPE,
      content: `Continue the active task. Goal: ${state.goal}${state.progress ? `\nProgress so far: ${state.progress}` : ""}. Continue working; use task_update to record progress, mark done, or report a blocker.`,
      display: false,
    }],
    continue: true,
  };
}

export const taskPersistence = { ENTRY_TYPE, MESSAGE_TYPE, MAX_CONTINUATIONS };
