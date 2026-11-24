import type { AgentBeforeSettleEvent, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { continueGoal, getGoalSummary, registerGoalContinuation, resetGoalRuntime, restoreGoalTools, runGoalCommand, type GoalOptions } from "./goal.ts";

export default function (pi: ExtensionAPI): void {
  createGoalExtension()(pi);
}

/** Builds the extension; tests pass shorter timeouts. */
export function createGoalExtension(options: GoalOptions = {}): (pi: ExtensionAPI) => void {
  return pi => register(pi, options);
}

function register(pi: ExtensionAPI, options: GoalOptions): void {
  registerGoalContinuation(pi, options);
  pi.registerCommand("goal", {
    description: "Start and control a bounded goal",
    async handler(args: string, ctx: ExtensionCommandContext) {
      const outcome = runGoalCommand(pi, args, ctx);
      if (!outcome.prompt) {
        ctx.ui.notify(outcome.message, outcome.tone);
        return;
      }
      try {
        pi.sendUserMessage(outcome.prompt);
        ctx.ui.notify(outcome.message, outcome.tone);
      } catch (error) {
        const state = getGoalSummary(ctx);
        const recovery = state?.status === "active"
          ? runGoalCommand(pi, "pause", ctx).message
          : state?.status === "blocked" ? "Reply to the blocker with /goal resume <answer>."
            : state?.status === "paused" ? "Resume with /goal resume or stop with /goal stop."
              : "Check the goal state with /goal status.";
        ctx.ui.notify(`Pi could not accept the goal: ${String(error)}\n${recovery}`, "warning");
      }
    },
  });
  pi.on("session_start", (_event, ctx) => { resetGoalRuntime(pi, { forgetContext: true }); restoreGoalTools(pi, ctx); });
  pi.on("session_tree", (_event, ctx) => { resetGoalRuntime(pi); restoreGoalTools(pi, ctx); });
  pi.on("session_shutdown", () => resetGoalRuntime(pi, { forgetContext: true }));
  // A run that starts (for example pi-subagents' completion wake) ends any wait; its settle decides again.
  pi.on("agent_start", () => resetGoalRuntime(pi));
  pi.on("agent_before_settle", (event: AgentBeforeSettleEvent, ctx: ExtensionContext) => continueGoal(pi, event, ctx));
}

export { GOAL_HELP, getGoalSummary, runGoalCommand } from "./goal.ts";
