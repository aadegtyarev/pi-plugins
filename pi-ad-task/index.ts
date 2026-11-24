import type { AgentBeforeSettleEvent, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { continueTask, getTaskSummary, registerTaskContinuation, resetTaskRuntime, restoreTaskTools, runTaskCommand, type TaskOptions } from "./task.ts";

export default function (pi: ExtensionAPI): void {
  createTaskExtension()(pi);
}

/** Builds the extension; tests pass shorter timeouts. */
export function createTaskExtension(options: TaskOptions = {}): (pi: ExtensionAPI) => void {
  return pi => register(pi, options);
}

function register(pi: ExtensionAPI, options: TaskOptions): void {
  registerTaskContinuation(pi, options);
  pi.registerCommand("task", {
    description: "Start and control a bounded task",
    async handler(args: string, ctx: ExtensionCommandContext) {
      const outcome = runTaskCommand(pi, args, ctx);
      if (!outcome.prompt) {
        ctx.ui.notify(outcome.message, outcome.tone);
        return;
      }
      try {
        pi.sendUserMessage(outcome.prompt);
        ctx.ui.notify(outcome.message, outcome.tone);
      } catch (error) {
        const state = getTaskSummary(ctx);
        const recovery = state?.status === "active"
          ? runTaskCommand(pi, "pause", ctx).message
          : state?.status === "blocked" ? "Reply to the blocker with /task resume <answer>."
            : state?.status === "paused" ? "Resume with /task resume or stop with /task stop."
              : "Check the task state with /task status.";
        ctx.ui.notify(`Pi could not accept the task: ${String(error)}\n${recovery}`, "warning");
      }
    },
  });
  pi.on("session_start", (_event, ctx) => { resetTaskRuntime(pi, { forgetContext: true }); restoreTaskTools(pi, ctx); });
  pi.on("session_tree", (_event, ctx) => { resetTaskRuntime(pi); restoreTaskTools(pi, ctx); });
  pi.on("session_shutdown", () => resetTaskRuntime(pi, { forgetContext: true }));
  // A run that starts (for example pi-subagents' completion wake) ends any wait; its settle decides again.
  pi.on("agent_start", () => resetTaskRuntime(pi));
  pi.on("agent_before_settle", (event: AgentBeforeSettleEvent, ctx: ExtensionContext) => continueTask(pi, event, ctx));
}

export { TASK_HELP, getTaskSummary, runTaskCommand } from "./task.ts";
