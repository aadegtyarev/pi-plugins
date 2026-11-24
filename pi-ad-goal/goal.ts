import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { countReviewRejections, REVIEW_REJECTION_LIMIT, REVIEW_VERDICT_ENTRY, reviewLimitReport, scanReviewVerdicts } from "./review-limit.ts";
import { createSubagentMonitor, DEFAULT_STATUS_TIMEOUT_MS, SUBAGENT_ASYNC_COMPLETE_EVENT, type SubagentMonitor } from "./subagents.ts";

const ENTRY_TYPE = "pi-ad-goal";
/** Entry type written before the extension was renamed from pi-ad-task; still read so old sessions keep their goal. */
const LEGACY_ENTRY_TYPE = "pi-ad-hooks-task";
const MESSAGE_TYPE = "pi-ad-goal-continuation";
const DEFAULT_CONTINUATION_LIMIT = 40;
/** Grace period after a subagent completes for pi-subagents' own wake to start a run before the goal starts one. */
export const DEFAULT_WAKE_DELAY_MS = 2000;

export interface GoalOptions {
  statusTimeoutMs?: number;
  wakeDelayMs?: number;
}

/** Per-extension runtime state that is not persisted: what the goal is waiting for right now. */
interface Runtime {
  monitor: SubagentMonitor;
  wakeDelayMs: number;
  /** Background subagents the goal is waiting for; 0 when it is not waiting. */
  waiting: number;
  ctx?: ExtensionContext;
  wakeTimer?: ReturnType<typeof setTimeout>;
}
const runtimes = new WeakMap<ExtensionAPI, Runtime>();

function runtime(pi: ExtensionAPI): Runtime | undefined {
  return runtimes.get(pi);
}

function stopWaiting(rt: Runtime | undefined): void {
  if (!rt) return;
  rt.waiting = 0;
  if (rt.wakeTimer) clearTimeout(rt.wakeTimer);
  rt.wakeTimer = undefined;
}

/** Forget runtime waiting state when a run starts or the session changes. */
export function resetGoalRuntime(pi: ExtensionAPI, options: { forgetContext?: boolean } = {}): void {
  const rt = runtime(pi);
  stopWaiting(rt);
  if (rt && options.forgetContext) rt.ctx = undefined;
}

export const GOAL_HELP = [
  "Goal commands:",
  "/goal <goal> — set a goal and start working on it. Example: /goal Fix the bug and run tests. If the goal starts with a reserved command, use /goal start <goal>.",
  "/goal status — show the goal, its state, and progress.",
  "/goal pause — stop future continuation; it does not cancel an operation already in progress.",
  "/goal resume [answer] — resume a goal with a fresh continuation count; add your answer to a question or blocker after resume.",
  "/goal limit <N|off|default> — set this goal's automatic continuation limit, disable it, or restore the default of 40.",
  "/goal done — mark the goal complete and stop future continuation; it does not cancel an operation already in progress.",
  "/goal stop — close the goal and free its slot; it does not cancel an operation already in progress. Wait for it to finish before starting another goal. /cancel aborts current Pi work and pauses an active goal.",
  "Status, pause, done, and stop remain available while Pi is busy; they manage goal state, not the current operation. Slash-command start and resume require Pi to be idle.",
  "While a goal is active, Pi performs automatic continuations up to its configured per-goal limit (default 40); use /goal limit off for unlimited continuations. The model records progress with goal_update; action=blocked waits for your reply, and done completes the goal.",
  "After the independent reviewer requests changes twice in one goal cycle, the goal blocks and Pi reports instead of starting another round; /goal resume <answer> starts a fresh cycle.",
  "Blocker reply example: /goal resume I approve the proposed scope. Only one goal can be active at a time; resume or stop a nonterminal goal before starting another.",
].join("\n");

type Status = "active" | "paused" | "done" | "stopped" | "blocked";
interface GoalState {
  version: 1;
  goal: string;
  progress: string;
  status: Status;
  continuations: number;
  continuationLimit?: number | null;
  /** Reviewer rejections already on the branch when the current goal cycle began. */
  reviewRejectionBaseline?: number;
}

export interface GoalCommandResult {
  message: string;
  tone: "info" | "warning";
  prompt?: string;
}

function isState(value: unknown): value is GoalState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<GoalState>;
  return state.version === 1 && typeof state.goal === "string" && typeof state.progress === "string" &&
    ["active", "paused", "done", "stopped", "blocked"].includes(state.status ?? "") &&
    Number.isSafeInteger(state.continuations) && (state.continuations ?? -1) >= 0 &&
    (state.continuationLimit === undefined || state.continuationLimit === null || (Number.isSafeInteger(state.continuationLimit) && state.continuationLimit >= 0)) &&
    (state.reviewRejectionBaseline === undefined || (Number.isSafeInteger(state.reviewRejectionBaseline) && state.reviewRejectionBaseline >= 0));
}

function current(ctx: ExtensionContext): GoalState | undefined {
  if (!ctx.sessionManager || typeof ctx.sessionManager.getBranch !== "function") return undefined;
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as { type?: string; customType?: string; data?: unknown };
    if (entry.type !== "custom" || (entry.customType !== ENTRY_TYPE && entry.customType !== LEGACY_ENTRY_TYPE)) continue;
    if (!isState(entry.data)) return undefined;
    // Keep only known fields so fields from older releases are not written back.
    const { version, goal, progress, status, continuations, continuationLimit = DEFAULT_CONTINUATION_LIMIT, reviewRejectionBaseline } = entry.data;
    return { version, goal, progress, status, continuations, continuationLimit, ...(reviewRejectionBaseline === undefined ? {} : { reviewRejectionBaseline }) };
  }
  return undefined;
}

function reviewRejections(ctx: ExtensionContext): number {
  return typeof ctx.sessionManager?.getBranch === "function" ? countReviewRejections(ctx.sessionManager.getBranch()) : 0;
}

function persist(pi: ExtensionAPI, state: GoalState): void {
  pi.appendEntry(ENTRY_TYPE, { ...state });
}

function expose(pi: ExtensionAPI, enabled: boolean): void {
  if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
  const active = pi.getActiveTools();
  const has = active.includes("goal_update");
  if (enabled && !has) pi.setActiveTools([...active, "goal_update"]);
  if (!enabled && has) pi.setActiveTools(active.filter(name => name !== "goal_update"));
}

function extractGoal(value: string): string {
  const text = value.trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function goalStatus(state: GoalState | undefined, waiting = 0): string {
  if (!state) return `No goal is recorded on this session branch.\nTo start one: /goal <goal>\n\n${GOAL_HELP}`;
  const progress = state.progress || "No progress recorded yet.";
  const next = state.status === "blocked" ? "Reply to the blocker: /goal resume <your answer>." :
    state.status === "paused" ? "Resume with /goal resume." :
      state.status === "active" ? (waiting > 0
        ? `Waiting for ${waiting} background subagent${waiting === 1 ? "" : "s"} to finish; the goal continues when ${waiting === 1 ? "it reports" : "they report"}.`
        : "The goal will continue automatically after a successful step.") :
        state.status === "done" ? "The goal is complete." : "The goal is stopped. Start another with /goal start <goal>.";
  const limit = state.continuationLimit === null ? "unlimited" : String(state.continuationLimit ?? DEFAULT_CONTINUATION_LIMIT);
  return `Goal: ${state.goal}\nState: ${state.status}\nProgress: ${progress}\nAutomatic continuations: ${state.continuations}/${limit}\n${next}`;
}

export function getGoalSummary(ctx: ExtensionContext): { status: Status; goal: string } | undefined {
  const state = current(ctx);
  return state ? { status: state.status, goal: state.goal } : undefined;
}

function result(message: string, tone: GoalCommandResult["tone"] = "info", prompt?: string): GoalCommandResult {
  return { message, tone, ...(prompt === undefined ? {} : { prompt }) };
}

/** Implementation of the `/goal` slash command. */
export function runGoalCommand(pi: ExtensionAPI, args: string, ctx: ExtensionContext): GoalCommandResult {
  const match = /^([^\s]+)(?:\s+([\s\S]*))?$/.exec(args.trim());
  const action = match?.[1]?.toLowerCase();
  const value = match?.[2]?.trim() ?? "";
  const state = current(ctx);
  const operationBusy = !ctx.isIdle();

  const managementActions = ["start", "status", "pause", "resume", "limit", "done", "stop"];
  if (!action) return result(GOAL_HELP);
  if (action === "status") return result(`${goalStatus(state, runtime(pi)?.waiting)}${operationBusy ? "\nCurrent operation is still in progress; goal status does not cancel it." : ""}`);

  if (action === "start" || !managementActions.includes(action)) {
    const goal = extractGoal(action === "start" ? value : args);
    if (!goal) return result(`Specify a goal. Example: /goal start "Fix the bug and run tests".\n\n${GOAL_HELP}`, "warning");
    if (!ctx.isIdle()) {
      const canReplace = state && !["done", "stopped"].includes(state.status);
      const recovery = canReplace
        ? `Wait for the current run to finish. To replace the current goal, use /goal stop, then /goal start <goal>.${state.status === "blocked" ? " To continue it instead, reply with /goal resume <answer>." : ""}`
        : "Wait for the current run to finish, then retry /goal start <goal>.";
      return result(`Cannot start a goal while Pi is busy. ${recovery}${canReplace ? ` Current goal: ${state.status} — ${state.goal}.` : ""}`, "warning");
    }
    if (state && !["done", "stopped"].includes(state.status)) {
      const recover = state.status === "blocked" ? "/goal resume <blocker answer> or /goal stop, then /goal start <new goal>." :
        state.status === "paused" ? "/goal resume or /goal stop, then /goal start <new goal>." :
          "Wait for the current run to finish or use /goal stop, then /goal start <new goal>.";
      return result(`Goal not started: a goal is already ${state.status}: ${state.goal}\n${recover}`, "warning");
    }
    const next: GoalState = { version: 1, goal, progress: "", status: "active", continuations: 0, continuationLimit: DEFAULT_CONTINUATION_LIMIT, reviewRejectionBaseline: reviewRejections(ctx) };
    persist(pi, next);
    expose(pi, true);
    return result(`✅ Goal started.\nGoal: ${goal}\nUse /goal status to check progress, /goal pause to pause, or /goal stop to stop.`, "info", goal);
  }

  if (action === "resume") {
    if (!state) return result("There is no goal to resume. Start one with /goal <goal>.", "warning");
    if (!["paused", "blocked"].includes(state.status)) {
      const next = state.status === "active" ? "The goal is already active; use /goal status." : `The goal is ${state.status} and cannot be resumed. Start a new goal with /goal <goal>.`;
      return result(next, "warning");
    }
    if (!ctx.isIdle()) return result("Cannot resume a goal while Pi is busy. Check /goal status, wait for the current run to finish, then retry /goal resume [answer].", "warning");
    state.status = "active";
    state.continuations = 0;
    state.reviewRejectionBaseline = reviewRejections(ctx);
    persist(pi, state);
    expose(pi, true);
    const response = value ? `\nUser response: ${value}` : "";
    const prompt = `Continue the goal: ${state.goal}${state.progress ? `\nLatest progress: ${state.progress}` : ""}${response}`;
    return result(`▶️ Goal resumed.${value ? " Your answer was added to the context." : ""}\nGoal: ${state.goal}`, "info", prompt);
  }

  if (!state) return result(`There is no active goal for /goal ${action}. Start one with /goal start <goal>.`, "warning");
  if (action === "limit") {
    if (!["active", "paused", "blocked"].includes(state.status)) return result(`Cannot change the continuation limit for a goal with status ${state.status}.`, "warning");
    if (!value) return result("Usage: /goal limit <N|off|default>. N must be a non-negative safe integer.", "warning");
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
      const recovery = state.status === "blocked" ? "Reply to the blocker with /goal resume <answer>, or use /goal stop." :
        state.status === "paused" ? "The goal is already paused; use /goal resume or /goal stop." :
          `The goal is already ${state.status}; start another with /goal start <goal>.`;
      return result(`Cannot pause a goal with status ${state.status}. ${recovery}`, "warning");
    }
    state.status = "paused";
    persist(pi, state);
    expose(pi, false);
    return result(`⏸ Automatic continuation paused.${operationBusy ? " The current operation is still in progress and will not be cancelled." : ""} Resume with /goal resume.\nGoal: ${state.goal}`);
  }
  if (action === "done") {
    if (state.status === "done") return result("The goal is already complete. Check /goal status or start another with /goal start <goal>.", "warning");
    if (state.status === "stopped") return result("A stopped goal cannot be marked complete. Start another with /goal start <goal>.", "warning");
    state.status = "done";
    persist(pi, state);
    expose(pi, false);
    return result(`✅ Goal marked complete.${operationBusy ? " The current operation is still in progress and will not be cancelled." : ""}\nGoal: ${state.goal}`);
  }
  if (action === "stop") {
    if (["done", "stopped"].includes(state.status)) return result(`The goal is already ${state.status}; there is nothing to stop. Start another with /goal start <goal>.`, "warning");
    state.status = "stopped";
    persist(pi, state);
    expose(pi, false);
    const next = operationBusy
      ? "The current operation is still in progress and was not cancelled; wait for it to finish before starting another goal."
      : "You can start another goal with /goal start <goal>.";
    return result(`⏹ Automatic continuation stopped. ${next}\nPrevious goal: ${state.goal}`);
  }
  return result(GOAL_HELP, "warning");
}

export function registerGoalContinuation(pi: ExtensionAPI, options: GoalOptions = {}): void {
  const rt: Runtime = { monitor: createSubagentMonitor(pi, options.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS), wakeDelayMs: options.wakeDelayMs ?? DEFAULT_WAKE_DELAY_MS, waiting: 0 };
  runtimes.set(pi, rt);
  pi.events?.on?.(SUBAGENT_ASYNC_COMPLETE_EVENT, () => scheduleWake(pi, rt));
  // Keep event-only host fakes and older minimal hosts functional; Pi 1.6 exposes both APIs.
  if (typeof pi.registerTool !== "function") return;
  pi.registerTool({
    name: "goal_control",
    label: "Control goal",
    description: "Carry out the operator's explicit request to start or manage the single bounded goal. Never start without explicit operator consent; validate the current goal state.",
    promptSnippet: "Manage one operator-approved bounded goal",
    exposure: "direct",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("start"), Type.Literal("status"), Type.Literal("pause"), Type.Literal("resume"), Type.Literal("done"), Type.Literal("stop")]),
      goal: Type.Optional(Type.String({ description: "The goal to start with." })),
      note: Type.Optional(Type.String({ description: "Optional blocker answer or transition note." })),
    }),
    async execute(_id, params, _signal, _update, ctx: ExtensionToolContext) {
      const state = current(ctx);
      if (params.action === "status") return { content: [{ type: "text", text: goalStatus(state, rt.waiting) }], details: undefined };
      if (params.action === "start") {
        const goal = params.goal?.trim();
        if (!goal) return { content: [{ type: "text", text: "Provide the goal text; the operator must explicitly request that a goal be started." }], details: undefined, isError: true };
        if (state && !["done", "stopped"].includes(state.status)) return { content: [{ type: "text", text: `A goal is already ${state.status}: ${state.goal}. Resume it or stop it with /goal stop before starting another.` }], details: undefined, isError: true };
        const next: GoalState = { version: 1, goal, progress: "", status: "active", continuations: 0, continuationLimit: DEFAULT_CONTINUATION_LIMIT, reviewRejectionBaseline: reviewRejections(ctx) };
        persist(pi, next);
        expose(pi, true);
        return { content: [{ type: "text", text: `Goal started: ${goal}. Work toward this goal and record progress with goal_update.` }], details: undefined };
      }
      if (!state) return { content: [{ type: "text", text: "There is no active goal. To start one, wait for an explicit operator request and call goal_control with action=start." }], details: undefined, isError: true };
      if (params.action === "pause") {
        if (state.status !== "active") return { content: [{ type: "text", text: `Cannot pause a goal with status ${state.status}. Check its status or resume a blocked goal.` }], details: undefined, isError: true };
        state.status = "paused";
      } else if (params.action === "resume") {
        if (!["paused", "blocked"].includes(state.status)) return { content: [{ type: "text", text: `Cannot resume a goal with status ${state.status}.` }], details: undefined, isError: true };
        state.status = "active";
        state.continuations = 0;
        state.reviewRejectionBaseline = reviewRejections(ctx);
        if (params.note?.trim()) state.progress = `${state.progress}${state.progress ? "\\n" : ""}User response: ${params.note.trim()}`;
      } else if (params.action === "done") {
        if (["done", "stopped"].includes(state.status)) return { content: [{ type: "text", text: `The goal is already ${state.status}.` }], details: undefined, isError: true };
        state.status = "done";
      } else if (params.action === "stop") {
        if (["done", "stopped"].includes(state.status)) return { content: [{ type: "text", text: `The goal is already ${state.status}.` }], details: undefined, isError: true };
        state.status = "stopped";
      }
      persist(pi, state);
      expose(pi, state.status === "active");
      return { content: [{ type: "text", text: `Goal ${state.status}: ${state.goal}${params.note ? `\\n${params.note}` : ""}` }], details: undefined };
    },
  });

  pi.registerTool({
    name: "goal_update",
    label: "Update goal",
    description: "Record progress on the active goal, mark it done, or mark it blocked pending user input.",
    promptSnippet: "Update progress on the active goal",
    exposure: "direct",
    defaultActive: false,
    parameters: Type.Object({
      action: Type.Union([Type.Literal("progress"), Type.Literal("done"), Type.Literal("blocked")]),
      note: Type.Optional(Type.String({ description: "Progress, completion summary, or blocker. Do not include secrets." })),
    }),
    async execute(_id, params, _signal, _update, ctx: ExtensionToolContext) {
      if (params.action === "done" && current(ctx)?.status === "active") {
        const running = await rt.monitor.activeCount();
        if (running !== undefined && running > 0) {
          return { content: [{ type: "text", text: `${running} background subagent${running === 1 ? " is" : "s are"} still running. Do not mark the goal done yet: wait for their results (pi-subagents reports each one), check them, and then finish the goal.` }], details: undefined, isError: true };
        }
      }
      const state = current(ctx);
      if (!state) return { content: [{ type: "text", text: "There is no active goal to update. Start one with /goal start <goal>." }], details: undefined, isError: true };
      if (state.status !== "active") {
        const recovery = ["paused", "blocked"].includes(state.status)
          ? (state.status === "blocked" ? "Reply to the blocker with /goal resume <answer>." : "Resume the goal with /goal resume.")
          : `The goal is already ${state.status}; start another with /goal start <goal>.`;
        return { content: [{ type: "text", text: `Cannot update a goal with status ${state.status}. ${recovery}` }], details: undefined, isError: true };
      }
      state.progress = params.note?.trim() || state.progress;
      if (params.action === "done") state.status = "done";
      if (params.action === "blocked") state.status = "blocked";
      persist(pi, state);
      expose(pi, state.status === "active");
      const guidance = state.status === "blocked" ? " Use /goal resume <answer> to answer and continue, or /goal stop to stop." :
        state.status === "done" ? " The goal is complete." : "";
      return { content: [{ type: "text", text: `Goal ${state.status}${state.progress ? `: ${state.progress}` : "."}${guidance}` }], details: undefined };
    },
  });

}

export function restoreGoalTools(pi: ExtensionAPI, ctx: ExtensionContext | undefined): void {
  if (!ctx) return;
  expose(pi, current(ctx)?.status === "active");
}

function continuationText(state: GoalState): string {
  return `Continue working toward the active goal: ${state.goal}${state.progress ? `\nProgress so far: ${state.progress}` : ""}. Continue working; use goal_update to record progress, mark done, or report a blocker.`;
}

/** Counts one automatic continuation, or pauses the goal when its limit is used up. Returns false when paused. */
function takeStep(pi: ExtensionAPI, ctx: ExtensionContext, state: GoalState): boolean {
  const limit = state.continuationLimit ?? DEFAULT_CONTINUATION_LIMIT;
  if (state.continuationLimit !== null && state.continuations >= limit) {
    state.status = "paused";
    persist(pi, state); expose(pi, false);
    ctx.ui.notify(`Goal paused after ${state.continuations} automatic continuations (limit ${limit}). Check progress with /goal status; use /goal resume [answer] to continue.`, "warning");
    return false;
  }
  state.continuations = Math.min(state.continuations + 1, Number.MAX_SAFE_INTEGER);
  persist(pi, state);
  return true;
}

/**
 * After a background subagent completes, pi-subagents normally wakes the parent itself.
 * If no run has started after a grace period and nothing is still running, start the next step here.
 */
function scheduleWake(pi: ExtensionAPI, rt: Runtime): void {
  if (rt.waiting === 0 || !rt.ctx) return;
  if (rt.wakeTimer) clearTimeout(rt.wakeTimer);
  rt.wakeTimer = setTimeout(async () => {
    rt.wakeTimer = undefined;
    const ctx = rt.ctx;
    if (rt.waiting === 0 || !ctx || !ctx.isIdle()) return;
    const running = await rt.monitor.activeCount();
    if (rt.waiting === 0 || !ctx.isIdle()) return;
    if (running === undefined || running > 0) {
      if (running) rt.waiting = running;
      return;
    }
    const state = current(ctx);
    rt.waiting = 0;
    if (!state || state.status !== "active" || !takeStep(pi, ctx, state)) return;
    try {
      pi.sendMessage({ customType: MESSAGE_TYPE, content: continuationText(state), display: false }, { triggerTurn: true });
    } catch {
      ctx.ui.notify("The goal could not start its next step after the subagents finished. Continue with /goal resume.", "warning");
    }
  }, rt.wakeDelayMs);
}

export async function continueGoal(pi: ExtensionAPI, event: import("@earendil-works/pi-coding-agent").AgentBeforeSettleEvent, ctx: ExtensionContext) {
  if (current(ctx)?.status !== "active") return;
  const rt = runtime(pi);
  if (rt) rt.ctx = ctx;
  // Ask before deciding so a slow reply cannot interleave with the state changes below.
  const running = event.outcome === "completed" && rt ? await rt.monitor.activeCount() : undefined;
  const state = current(ctx);
  if (!state || state.status !== "active") return;
  if (event.outcome !== "completed") {
    state.status = "paused";
    persist(pi, state); expose(pi, false);
    ctx.ui.notify(`Goal paused because the Pi run ended with outcome ${event.outcome}. Check /goal status and continue with /goal resume [answer].`, "warning");
    return;
  }
  const scan = typeof ctx.sessionManager?.getBranch === "function" ? scanReviewVerdicts(ctx.sessionManager.getBranch()) : { rejections: 0, discovered: [] };
  for (const verdict of scan.discovered) pi.appendEntry(REVIEW_VERDICT_ENTRY, verdict);
  state.reviewRejectionBaseline ??= scan.rejections;
  const rejections = scan.rejections - state.reviewRejectionBaseline;
  if (rejections >= REVIEW_REJECTION_LIMIT) {
    stopWaiting(rt);
    state.status = "blocked";
    state.progress = `${state.progress}${state.progress ? "\n" : ""}Blocked after ${rejections} rejected review rounds; waiting for the operator.`;
    persist(pi, state); expose(pi, false);
    ctx.ui.notify(`Goal blocked after ${rejections} rejected review rounds (limit ${REVIEW_REJECTION_LIMIT}). Read the report, then answer with /goal resume <answer> or use /goal stop.`, "warning");
    return {
      entries: [...event.entries, { type: "custom_message" as const, customType: MESSAGE_TYPE, content: reviewLimitReport(rejections), display: false }],
      continue: true,
    };
  }
  if (rt && running !== undefined && running > 0) {
    // pi-subagents wakes the parent when a subagent finishes; a step now would only poll.
    rt.waiting = running;
    return;
  }
  stopWaiting(rt);
  if (!takeStep(pi, ctx, state)) return;
  return {
    entries: [...event.entries, { type: "custom_message" as const, customType: MESSAGE_TYPE, content: continuationText(state), display: false }],
    continue: true,
  };
}

export const goalPersistence = { ENTRY_TYPE, MESSAGE_TYPE, DEFAULT_CONTINUATION_LIMIT };
