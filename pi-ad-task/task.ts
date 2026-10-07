import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "pi-ad-hooks-task";
const MESSAGE_TYPE = "pi-ad-hooks-task-continuation";
const DEFAULT_CONTINUATION_LIMIT = 40;
const TELEGRAM_ROUTE_EVENT = "pi-ad-task:telegram-route";

function routeTaskResponseToTelegram(pi: ExtensionAPI, chatId: number | undefined): void {
  if (chatId !== undefined) pi.events?.emit?.(TELEGRAM_ROUTE_EVENT, { chatId });
}

export const TASK_HELP = [
  "Task commands:",
  "/task <goal> — start a task. Example: /task Fix the bug and run tests. If the goal starts with a reserved command, use /task start <goal>.",
  "/task status — show the task state, goal, and progress.",
  "/task pause — stop future continuation; it does not cancel an operation already in progress.",
  "/task resume [answer] — resume a task with a fresh continuation count; add your answer to a question or blocker after resume.",
  "/task limit <N|off|default> — set this task's automatic continuation limit, disable it, or restore the default of 40.",
  "/task done — mark the task complete and stop future continuation; it does not cancel an operation already in progress.",
  "/task stop — close the task and free its slot; it does not cancel an operation already in progress. Wait for it to finish before starting another task. /cancel aborts current Pi work and pauses an active task.",
  "Status, pause, done, and stop remain available while Pi is busy; they manage task state, not the current operation. Slash-command start and resume require Pi to be idle.",
  "While a task is active, Pi performs automatic continuations up to its configured per-task limit (default 40); use /task limit off for unlimited continuations. The model records progress with task_update; action=blocked waits for your reply, and done completes the task.",
  "Blocker reply example: /task resume I approve the proposed scope. Only one task can be active at a time; resume or stop a nonterminal task before starting another.",
].join("\n");

type Status = "active" | "paused" | "done" | "stopped" | "blocked";
interface TaskState {
  version: 1;
  goal: string;
  progress: string;
  status: Status;
  continuations: number;
  continuationLimit?: number | null;
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
    Number.isSafeInteger(state.continuations) && (state.continuations ?? -1) >= 0 &&
    (state.continuationLimit === undefined || state.continuationLimit === null || (Number.isSafeInteger(state.continuationLimit) && state.continuationLimit >= 0)) &&
    (state.telegramChatId === undefined || (Number.isSafeInteger(state.telegramChatId) && state.telegramChatId > 0));
}

function current(ctx: ExtensionContext): TaskState | undefined {
  if (!ctx.sessionManager || typeof ctx.sessionManager.getBranch !== "function") return undefined;
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as { type?: string; customType?: string; data?: unknown };
    if (entry.type === "custom" && entry.customType === ENTRY_TYPE) return isState(entry.data) ? { continuationLimit: DEFAULT_CONTINUATION_LIMIT, ...entry.data } : undefined;
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
  if (!state) return `No task is recorded on this session branch.\nTo start one: /task <goal>\n\n${TASK_HELP}`;
  const progress = state.progress || "No progress recorded yet.";
  const next = state.status === "blocked" ? "Reply to the blocker: /task resume <your answer>." :
    state.status === "paused" ? "Resume with /task resume." :
      state.status === "active" ? "The task will continue automatically after a successful step." :
        state.status === "done" ? "The task is complete." : "The task is stopped. Start another with /task start <goal>.";
  const limit = state.continuationLimit === null ? "unlimited" : String(state.continuationLimit ?? DEFAULT_CONTINUATION_LIMIT);
  return `Task: ${state.status}\nGoal: ${state.goal}\nProgress: ${progress}\nAutomatic continuations: ${state.continuations}/${limit}\n${next}`;
}

export function getTaskSummary(ctx: ExtensionContext): { status: Status; goal: string; telegramChatId?: number } | undefined {
  const state = current(ctx);
  return state ? { status: state.status, goal: state.goal, ...(state.telegramChatId === undefined ? {} : { telegramChatId: state.telegramChatId }) } : undefined;
}

function result(message: string, tone: TaskCommandResult["tone"] = "info", prompt?: string): TaskCommandResult {
  return { message, tone, ...(prompt === undefined ? {} : { prompt }) };
}

/** Shared command implementation for Pi's TUI and the Telegram bridge. */
export function runTaskCommand(pi: ExtensionAPI, args: string, ctx: ExtensionContext, options: { telegramChatId?: number; operationBusy?: boolean } = {}): TaskCommandResult {
  const match = /^([^\s]+)(?:\s+([\s\S]*))?$/.exec(args.trim());
  const action = match?.[1]?.toLowerCase();
  const value = match?.[2]?.trim() ?? "";
  const state = current(ctx);
  const operationBusy = options.operationBusy ?? !ctx.isIdle();

  const managementActions = ["start", "status", "pause", "resume", "limit", "done", "stop"];
  if (!action) return result(TASK_HELP);
  if (action === "status") return result(`${taskStatus(state)}${operationBusy ? "\nCurrent operation is still in progress; task status does not cancel it." : ""}`);

  if (action === "start" || !managementActions.includes(action)) {
    const goal = extractGoal(action === "start" ? value : args);
    if (!goal) return result(`Specify a task goal. Example: /task start "Fix the bug and run tests".\n\n${TASK_HELP}`, "warning");
    if (!ctx.isIdle()) {
      const canReplace = state && !["done", "stopped"].includes(state.status);
      const recovery = canReplace
        ? `Wait for the current run to finish. To replace the current task, use /task stop, then /task start <goal>.${state.status === "blocked" ? " To continue it instead, reply with /task resume <answer>." : ""}`
        : "Wait for the current run to finish, then retry /task start <goal>.";
      return result(`Cannot start a task while Pi is busy. ${recovery}${canReplace ? ` Current task: ${state.status} — ${state.goal}.` : ""}`, "warning");
    }
    if (state && !["done", "stopped"].includes(state.status)) {
      const recover = state.status === "blocked" ? "/task resume <blocker answer> or /task stop, then /task start <new goal>." :
        state.status === "paused" ? "/task resume or /task stop, then /task start <new goal>." :
          "Wait for the current run to finish or use /task stop, then /task start <new goal>.";
      return result(`Task not started: a task is already ${state.status}: ${state.goal}\n${recover}`, "warning");
    }
    const next: TaskState = { version: 1, goal, progress: "", status: "active", continuations: 0, continuationLimit: DEFAULT_CONTINUATION_LIMIT, ...(options.telegramChatId === undefined ? {} : { telegramChatId: options.telegramChatId }) };
    persist(pi, next);
    expose(pi, true);
    return result(`✅ Task started.\nGoal: ${goal}\nUse /task status to check progress, /task pause to pause, or /task stop to stop.`, "info", goal);
  }

  if (action === "resume") {
    if (!state) return result("There is no task to resume. Start one with /task <goal>.", "warning");
    if (!["paused", "blocked"].includes(state.status)) {
      const next = state.status === "active" ? "The task is already active; use /task status." : `The task is ${state.status} and cannot be resumed. Start a new task with /task <goal>.`;
      return result(next, "warning");
    }
    if (!ctx.isIdle()) return result("Cannot resume a task while Pi is busy. Check /task status, wait for the current run to finish, then retry /task resume [answer].", "warning");
    state.status = "active";
    state.continuations = 0;
    persist(pi, state);
    expose(pi, true);
    const response = value ? `\nUser response: ${value}` : "";
    const prompt = `Continue the task: ${state.goal}${state.progress ? `\nLatest progress: ${state.progress}` : ""}${response}`;
    return result(`▶️ Task resumed.${value ? " Your answer was added to the context." : ""}\nGoal: ${state.goal}`, "info", prompt);
  }

  if (!state) return result(`There is no active task for /task ${action}. Start one with /task start <goal>.`, "warning");
  if (action === "limit") {
    if (!["active", "paused", "blocked"].includes(state.status)) return result(`Cannot change the continuation limit for a task with status ${state.status}.`, "warning");
    if (!value) return result("Usage: /task limit <N|off|default>. N must be a non-negative safe integer.", "warning");
    const normalized = value.toLowerCase();
    if (normalized === "default") state.continuationLimit = DEFAULT_CONTINUATION_LIMIT;
    else if (normalized === "off") state.continuationLimit = null;
    else if (/^\d+$/.test(value) && Number.isSafeInteger(Number(value))) state.continuationLimit = Number(value);
    else return result("Invalid continuation limit. Use a non-negative safe integer, off, or default.", "warning");
    persist(pi, state);
    return result(`Automatic continuation limit set to ${state.continuationLimit === null ? "unlimited" : state.continuationLimit}.`);
  }
  if (action === "pause") {
    if (state.status !== "active") {
      const recovery = state.status === "blocked" ? "Reply to the blocker with /task resume <answer>, or use /task stop." :
        state.status === "paused" ? "The task is already paused; use /task resume or /task stop." :
          `The task is already ${state.status}; start another with /task start <goal>.`;
      return result(`Cannot pause a task with status ${state.status}. ${recovery}`, "warning");
    }
    state.status = "paused";
    persist(pi, state);
    expose(pi, false);
    return result(`⏸ Automatic continuation paused.${operationBusy ? " The current operation is still in progress and will not be cancelled." : ""} Resume with /task resume.\nGoal: ${state.goal}`);
  }
  if (action === "done") {
    if (state.status === "done") return result("The task is already complete. Check /task status or start another with /task start <goal>.", "warning");
    if (state.status === "stopped") return result("A stopped task cannot be marked complete. Start another with /task start <goal>.", "warning");
    state.status = "done";
    persist(pi, state);
    expose(pi, false);
    return result(`✅ Task marked complete.${operationBusy ? " The current operation is still in progress and will not be cancelled." : ""}\nGoal: ${state.goal}`);
  }
  if (action === "stop") {
    if (["done", "stopped"].includes(state.status)) return result(`The task is already ${state.status}; there is nothing to stop. Start another with /task start <goal>.`, "warning");
    state.status = "stopped";
    persist(pi, state);
    expose(pi, false);
    const next = operationBusy
      ? "The current operation is still in progress and was not cancelled; wait for it to finish before starting another task."
      : "You can start another task with /task start <goal>.";
    return result(`⏹ Automatic continuation stopped. ${next}\nPrevious goal: ${state.goal}`);
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
        return { content: [{ type: "text", text: "This Telegram chat cannot manage the task because it was created in Pi or belongs to another chat. Use the originating chat or manage the task in Pi." }], details: undefined, isError: true };
      }
      if (params.action !== "start") routeTaskResponseToTelegram(pi, state?.telegramChatId);
      if (params.action === "status") return { content: [{ type: "text", text: taskStatus(state) }], details: undefined };
      if (params.action === "start") {
        const goal = params.goal?.trim();
        if (!goal) return { content: [{ type: "text", text: "Provide a goal to start a task; the operator must explicitly request that it be started." }], details: undefined, isError: true };
        if (state && !["done", "stopped"].includes(state.status)) return { content: [{ type: "text", text: `A task is already ${state.status}: ${state.goal}. Resume it or stop it with /task stop before starting another.` }], details: undefined, isError: true };
        const next: TaskState = { version: 1, goal, progress: "", status: "active", continuations: 0, continuationLimit: DEFAULT_CONTINUATION_LIMIT, ...(telegramChatId === undefined ? {} : { telegramChatId }) };
        persist(pi, next);
        expose(pi, true);
        return { content: [{ type: "text", text: `Task started: ${goal}. Work toward this goal and record progress with task_update.` }], details: undefined };
      }
      if (!state) return { content: [{ type: "text", text: "There is no active task. To start one, wait for an explicit operator request and call task_control with action=start." }], details: undefined, isError: true };
      if (params.action === "pause") {
        if (state.status !== "active") return { content: [{ type: "text", text: `Cannot pause a task with status ${state.status}. Check its status or resume a blocked task.` }], details: undefined, isError: true };
        state.status = "paused";
      } else if (params.action === "resume") {
        if (!["paused", "blocked"].includes(state.status)) return { content: [{ type: "text", text: `Cannot resume a task with status ${state.status}.` }], details: undefined, isError: true };
        state.status = "active";
        state.continuations = 0;
        if (params.note?.trim()) state.progress = `${state.progress}${state.progress ? "\\n" : ""}User response: ${params.note.trim()}`;
      } else if (params.action === "done") {
        if (["done", "stopped"].includes(state.status)) return { content: [{ type: "text", text: `The task is already ${state.status}.` }], details: undefined, isError: true };
        state.status = "done";
      } else if (params.action === "stop") {
        if (["done", "stopped"].includes(state.status)) return { content: [{ type: "text", text: `The task is already ${state.status}.` }], details: undefined, isError: true };
        state.status = "stopped";
      }
      persist(pi, state);
      expose(pi, state.status === "active");
      return { content: [{ type: "text", text: `Task ${state.status}: ${state.goal}${params.note ? `\\n${params.note}` : ""}` }], details: undefined };
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
      if (!state) return { content: [{ type: "text", text: "There is no active task to update. Start one with /task start <goal>." }], details: undefined, isError: true };
      if (telegramChatId !== undefined && state.telegramChatId !== telegramChatId) {
        return { content: [{ type: "text", text: "This Telegram chat cannot update the task because it was created in Pi or belongs to another chat. Use the originating chat or manage the task in Pi." }], details: undefined, isError: true };
      }
      routeTaskResponseToTelegram(pi, state.telegramChatId);
      if (state.status !== "active") {
        const recovery = ["paused", "blocked"].includes(state.status)
          ? (state.status === "blocked" ? "Reply to the blocker with /task resume <answer>." : "Resume the task with /task resume.")
          : `The task is already ${state.status}; start another with /task start <goal>.`;
        return { content: [{ type: "text", text: `Cannot update a task with status ${state.status}. ${recovery}` }], details: undefined, isError: true };
      }
      state.progress = params.note?.trim() || state.progress;
      if (params.action === "done") state.status = "done";
      if (params.action === "blocked") state.status = "blocked";
      persist(pi, state);
      expose(pi, state.status === "active");
      const guidance = state.status === "blocked" ? " Use /task resume <answer> to answer and continue, or /task stop to stop." :
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
  routeTaskResponseToTelegram(pi, state.telegramChatId);
  if (event.outcome !== "completed") {
    state.status = "paused";
    persist(pi, state); expose(pi, false);
    ctx.ui.notify(`Task paused because the Pi run ended with outcome ${event.outcome}. Check /task status and continue with /task resume [answer].`, "warning");
    return;
  }
  const limit = state.continuationLimit ?? DEFAULT_CONTINUATION_LIMIT;
  if (state.continuationLimit !== null && state.continuations >= limit) {
    state.status = "paused";
    persist(pi, state); expose(pi, false);
    ctx.ui.notify(`Task paused after ${state.continuations} automatic continuations (limit ${limit}). Check progress with /task status; use /task resume [answer] to continue.`, "warning");
    return;
  }
  state.continuations = Math.min(state.continuations + 1, Number.MAX_SAFE_INTEGER);
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

export const taskPersistence = { ENTRY_TYPE, MESSAGE_TYPE, DEFAULT_CONTINUATION_LIMIT };
