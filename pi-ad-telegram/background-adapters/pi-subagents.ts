import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BackgroundWorkSink } from "./types.ts";

interface PendingLaunch {
  agent: string;
  task?: string;
  model?: string;
}

/** Adapts pi-subagents lifecycle/tool events to Telegram's provider-neutral contract. */
export function attachPiSubagentsAdapter(pi: ExtensionAPI, emit: BackgroundWorkSink): void {
  const pending = new Map<string, PendingLaunch>();

  pi.on("tool_execution_start", (event) => {
    if (event.toolName !== "subagent") return;
    const args = event.args as Record<string, unknown>;
    const agent = typeof args.agent === "string" ? args.agent : "";
    if (!agent) return;
    pending.set(event.toolCallId, {
      agent,
      ...(typeof args.task === "string" ? { task: args.task } : typeof args.prompt === "string" ? { task: args.prompt } : {}),
      ...(typeof args.model === "string" ? { model: args.model } : {}),
    });
  });

  pi.on("tool_execution_end", (event) => {
    if (event.toolName === "subagent") pending.delete(event.toolCallId);
  });

  pi.events.on("subagent:async-started", (data) => {
    if (!data || typeof data !== "object") return;
    const event = data as {
      id?: string;
      runId?: string;
      agent?: string;
      agents?: string[];
      task?: string;
      goal?: string;
      asyncDir?: string;
    };
    const id = event.runId ?? event.id;
    if (!id) return;
    const agent = event.agent ?? event.agents?.join(", ") ?? "subagent";
    const matches = [...pending.entries()].filter(([, launch]) => launch.agent === agent);
    const launch = matches.length === 1 ? matches[0][1] : undefined;
    // The lifecycle API has no tool-call correlation ID. Never guess between parallel same-role launches.
    for (const [toolCallId] of matches) pending.delete(toolCallId);
    const eventTask = event.task ?? event.goal;

    emit({
      type: "started",
      adapter: "pi-subagents",
      id,
      agent,
      ...(eventTask && eventTask !== "[prompt redacted]" ? { task: eventTask } : launch?.task ? { task: launch.task } : {}),
      ...(launch?.model ? { model: launch.model } : {}),
      ...(event.asyncDir ? { statusDirectory: event.asyncDir } : {}),
    });
  });

  pi.events.on("subagent:async-complete", (data) => {
    if (!data || typeof data !== "object") return;
    const event = data as {
      id?: string;
      runId?: string;
      agent?: string;
      state?: string;
      success?: boolean;
      summary?: string;
      error?: string;
    };
    const id = event.runId ?? event.id;
    if (!id) return;
    const status = event.state === "stopped"
      ? "stopped"
      : event.success === false || event.state === "failed"
        ? "failed"
        : "completed";
    emit({
      type: "completed",
      adapter: "pi-subagents",
      id,
      ...(event.agent ? { agent: event.agent } : {}),
      status,
      ...(event.summary ? { summary: event.summary } : {}),
      ...(event.error ? { error: event.error } : {}),
    });
  });
}
