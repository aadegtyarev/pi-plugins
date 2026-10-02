import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "pi-ad-hooks-task";
const MESSAGE_TYPE = "pi-ad-hooks-task-continuation";
const MAX_CONTINUATIONS = 20;

type Status = "active" | "paused" | "done" | "stopped" | "blocked";
interface TaskState {
  version: 1;
  goal: string;
  progress: string;
  status: Status;
  continuations: number;
}

function isState(value: unknown): value is TaskState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<TaskState>;
  return state.version === 1 && typeof state.goal === "string" && typeof state.progress === "string" &&
    ["active", "paused", "done", "stopped", "blocked"].includes(state.status ?? "") &&
    Number.isInteger(state.continuations) && (state.continuations ?? -1) >= 0 && (state.continuations ?? 21) <= MAX_CONTINUATIONS;
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

function show(state: TaskState | undefined): string {
  if (!state) return "No task is recorded on this session branch.";
  return `Task ${state.status}: ${state.goal}\nProgress: ${state.progress || "(none recorded)"}\nAutomatic continuations: ${state.continuations}/${MAX_CONTINUATIONS}`;
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
      if (!state || state.status !== "active") return { content: [{ type: "text", text: "There is no active task to update." }], details: undefined, isError: true };
      state.progress = params.note?.trim() || state.progress;
      if (params.action === "done") state.status = "done";
      if (params.action === "blocked") state.status = "blocked";
      persist(pi, state);
      expose(pi, state.status === "active");
      return { content: [{ type: "text", text: `Task ${state.status}${state.progress ? `: ${state.progress}` : "."}` }], details: undefined };
    },
  });

  pi.registerCommand("task", {
    description: "Start and control bounded task continuation",
    async handler(args: string, ctx: ExtensionCommandContext) {
      const [action, ...rest] = args.trim().split(/\s+/);
      const state = current(ctx);
      if (action === "start") {
        if (!ctx.isIdle()) { ctx.ui.notify("Cannot start a task while the agent is busy.", "warning"); return; }
        const goal = rest.join(" ").trim();
        if (!goal) { ctx.ui.notify("Usage: /task start <goal>", "warning"); return; }
        if (state && !["done", "stopped"].includes(state.status)) { ctx.ui.notify(`Cannot replace a ${state.status} task. Complete or stop it first.`, "warning"); return; }
        const next: TaskState = { version: 1, goal, progress: "", status: "active", continuations: 0 };
        persist(pi, next); expose(pi, true);
        pi.sendUserMessage(goal);
        return;
      }
      if (action === "status" || !action) { ctx.ui.notify(show(state), "info"); return; }
      if (!state) { ctx.ui.notify("No task is recorded on this session branch.", "warning"); return; }
      if (action === "pause" && state.status === "active") state.status = "paused";
      else if (action === "resume" && ["paused", "blocked"].includes(state.status)) {
        if (!ctx.isIdle()) { ctx.ui.notify("Cannot resume a task while the agent is busy.", "warning"); return; }
        state.status = "active";
      }
      else if (action === "done" && !["done", "stopped"].includes(state.status)) state.status = "done";
      else if (action === "stop" && !["done", "stopped"].includes(state.status)) state.status = "stopped";
      else { ctx.ui.notify(`Cannot apply /task ${action} to a ${state.status} task.`, "warning"); return; }
      persist(pi, state); expose(pi, state.status === "active");
      ctx.ui.notify(show(state), "info");
      if (action === "resume") pi.sendUserMessage(`Continue the task: ${state.goal}${state.progress ? `\nLatest progress: ${state.progress}` : ""}`);
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
      ctx.ui.notify(`Task paused because the run ${event.outcome}. Use /task resume to continue.`, "warning");
      return;
    }
    if (state.continuations >= MAX_CONTINUATIONS) {
      state.status = "paused";
      persist(pi, state); expose(pi, false);
      ctx.ui.notify(`Task paused after ${MAX_CONTINUATIONS} automatic continuations. Use /task resume to start another task turn.`, "warning");
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
