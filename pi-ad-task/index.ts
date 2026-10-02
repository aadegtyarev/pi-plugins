import type { AgentBeforeSettleEvent, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { continueTask, getTaskSummary, registerTaskContinuation, restoreTaskTools, runTaskCommand } from "./task.ts";

export default function (pi: ExtensionAPI): void {
  registerTaskContinuation(pi);
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
          : state?.status === "blocked" ? "Ответьте на блокер: /task resume <ответ>."
            : state?.status === "paused" ? "Возобновить: /task resume, либо остановить: /task stop."
              : "Проверьте состояние командой /task status.";
        ctx.ui.notify(`Pi не принял задачу: ${String(error)}\n${recovery}`, "warning");
      }
    },
  });
  pi.on("session_start", (_event, ctx) => restoreTaskTools(pi, ctx));
  pi.on("session_tree", (_event, ctx) => restoreTaskTools(pi, ctx));
  pi.on("agent_before_settle", (event: AgentBeforeSettleEvent, ctx: ExtensionContext) => continueTask(pi, event, ctx));
}

export { TASK_HELP, getTaskSummary, runTaskCommand } from "./task.ts";
