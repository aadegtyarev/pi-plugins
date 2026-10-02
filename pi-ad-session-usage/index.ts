import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { collectUsage } from "./usage.ts";
import { diagnosticName, ERROR_CODES, formatSummary, formatToolContent, SAFE_ERRORS } from "./report.ts";

const CUSTOM_TYPE = "pi-ad-session-usage:report";
function logFailure(operation: string, code: string, error: unknown): void {
  try { console.error(`[pi-ad-session-usage] ${code} operation=${operation} error=${diagnosticName(error)}`); } catch { /* best effort */ }
}
function visibleFailure(pi: ExtensionAPI, text: string): void {
  try { pi.sendMessage({ customType: CUSTOM_TYPE, content: text, display: true }, { triggerTurn: false }); } catch { /* best effort */ }
}

export default function sessionUsageExtension(pi: ExtensionAPI): void {
  pi.registerTool(defineTool({
    name: "session_usage_report",
    label: "Session cost report",
    description: "When the operator asks about session costs or usage, return the compact active-branch report and structured per-model/per-subagent metrics. Use these Pi-recorded figures instead of reading transcript files; reply with the compact report without unrelated task commentary. Cost is an estimate, not a provider invoice.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      try {
        const report = collectUsage(ctx.sessionManager.getBranch());
        return { content: [{ type: "text", text: formatToolContent(report) }], details: report };
      } catch (error) {
        logFailure("tool", ERROR_CODES.tool, error);
        return { content: [{ type: "text", text: SAFE_ERRORS.tool }], details: { errorCode: ERROR_CODES.tool, message: SAFE_ERRORS.tool }, isError: true };
      }
    },
  }));

  pi.registerCommand("cost", {
    description: "Show a compact cost and cache report for this session",
    async handler(_args: string, _ctx: ExtensionCommandContext) {
      try {
        const report = collectUsage(_ctx.sessionManager.getBranch());
        pi.sendMessage({ customType: CUSTOM_TYPE, content: formatSummary(report), display: true, details: report }, { triggerTurn: false });
      } catch (error) {
        logFailure("command", ERROR_CODES.command, error);
        visibleFailure(pi, SAFE_ERRORS.command);
      }
    },
  });
}
