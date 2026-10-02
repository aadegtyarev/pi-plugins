import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "pi-ad-hooks-task";
const MESSAGE_TYPE = "pi-ad-hooks-task-continuation";
const MAX_CONTINUATIONS = 20;

export const TASK_HELP = [
  "Команды задачи:",
  "/task start <цель> — начать новую задачу. Пример: /task start \"Исправить баг и проверить тестами\".",
  "/task status — показать состояние, цель и прогресс.",
  "/task pause — не продолжать после текущего запуска Pi; сам запущенный вызов не отменяется.",
  "/task resume [ответ] — продолжить задачу; добавьте ответ на вопрос/блокер после resume.",
  "/task done — отметить задачу выполненной.",
  "/task stop — отключить продолжение и освободить место для новой задачи; текущий вызов Pi не отменяется (для отмены используйте /cancel в Telegram или остановку в Pi).",
  "Пока задача active, Pi делает до 20 автоматических продолжений. Модель записывает прогресс через task_update; action=blocked ждёт вашего ответа, done завершает задачу.",
  "Команды pause, done и stop отключают следующие продолжения, но не отменяют уже идущий вызов модели.",
  "Пример ответа на блокер: /task resume Подтверждаю выбранный scope. Нельзя заменить незавершённую задачу командой start: сначала resume или stop.",
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
  if (!state) return `Задача не записана в этой ветке сессии.\nЧтобы начать: /task start <цель>\n\n${TASK_HELP}`;
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

  if (!action || !["start", "status", "pause", "resume", "done", "stop"].includes(action)) {
    return result(TASK_HELP, action ? "warning" : "info");
  }
  if (action === "status") return result(taskStatus(state));

  if (action === "start") {
    const goal = extractGoal(value);
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
    if (!state) return result("Нечего возобновлять. Начните задачу командой /task start <цель>.", "warning");
    if (!["paused", "blocked"].includes(state.status)) {
      const next = state.status === "active" ? "Задача уже выполняется; используйте /task status." : `Задача ${state.status} и не возобновляется. Для новой задачи: /task start <цель>.`;
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
  if (typeof pi.registerTool !== "function" || typeof pi.registerCommand !== "function") return;
  pi.registerTool({
    name: "task_update",
    label: "Update task",
    description: "Record progress on the current /task, mark it done, or mark it blocked pending user input.",
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

  pi.registerCommand("task", {
    description: "Start and control bounded task continuation",
    async handler(args: string, ctx: ExtensionCommandContext) {
      const commandResult = runTaskCommand(pi, args, ctx);
      if (!commandResult.prompt) {
        ctx.ui.notify(commandResult.message, commandResult.tone);
        return;
      }
      const submissionFailed = (error: unknown): void => {
        const state = getTaskSummary(ctx);
        const recovery = state?.status === "active"
          ? runTaskCommand(pi, "pause", ctx).message
          : state?.status === "blocked" ? "Ответьте на блокер: /task resume <ответ>."
            : state?.status === "paused" ? "Возобновить: /task resume, либо остановить: /task stop."
              : state && ["done", "stopped"].includes(state.status) ? "Задача завершена/остановлена; следующую можно начать через /task start <цель>."
                : "Проверьте состояние командой /task status; если задачи нет, начните её через /task start <цель>.";
        ctx.ui.notify(`Pi не принял задачу: ${String(error)}\n${recovery}`, "warning");
      };
      try {
        pi.sendUserMessage(commandResult.prompt);
        ctx.ui.notify(commandResult.message, commandResult.tone);
      } catch (error) {
        submissionFailed(error);
      }
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
