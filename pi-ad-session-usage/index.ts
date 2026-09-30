import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
    label: "Session usage report",
    description: "Report measured token usage and cost for the active session branch, including available direct subagent results. Missing data is identified explicitly. This is an estimate, not a provider invoice.",
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
  pi.on("agent_settled", async (_event, ctx) => {
    try {
      const report = collectUsage(ctx.sessionManager.getBranch());
      pi.sendMessage({ customType: CUSTOM_TYPE, content: formatSummary(report), display: true, details: report }, { triggerTurn: false });
    } catch (error) {
      logFailure("agent_settled", ERROR_CODES.automatic, error);
      visibleFailure(pi, SAFE_ERRORS.automatic);
    }
  });
}
