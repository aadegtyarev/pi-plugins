import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { loadConfig, type HookEvent, type Diagnostic } from "./config.ts";
import { PromptQueue } from "./prompt-queue.ts";
import { runScript } from "./script-runner.ts";

export default function (pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  const config = loadConfig(agentDir, report);
  const prompts = new PromptQueue();
  const queues = new Map<HookEvent, Promise<void>>();
  let activeRun = false;
  function report(id: string, event: string, code: string, metadata?: Record<string, number | string>): void {
    console.error(`[pi-ad-hooks] id=${id} event=${event} code=${code}${metadata ? ` ${Object.entries(metadata).map(([k, v]) => `${k}=${v}`).join(" ")}` : ""}`);
  }
  function dispatch(name: HookEvent, payload: unknown): void {
    for (const hook of config[name] ?? []) {
      if (hook.type === "prompt") {
        if (!activeRun) { report(hook.id, name, "PROMPT_ACTION_OUTSIDE_RUN"); continue; }
        prompts.stage(hook.id, hook.text);
        continue;
      }
      if (hook.type === "system_prompt") {
        if (name !== "before_agent_start") { report(hook.id, name, "SYSTEM_PROMPT_EVENT_INVALID"); continue; }
        const options = (payload as { systemPromptOptions?: { appendSystemPrompt?: string } } | null)?.systemPromptOptions;
        if (!options || typeof options !== "object") { report(hook.id, name, "SYSTEM_PROMPT_OPTIONS_MISSING"); continue; }
        const existing = typeof options.appendSystemPrompt === "string" ? options.appendSystemPrompt : "";
        options.appendSystemPrompt = existing ? `${existing}\n\n${hook.text}` : hook.text;
        continue;
      }
      // Queue jobs in registration order without joining their completion to the Pi handler.
      const prior = queues.get(name) ?? Promise.resolve();
      const next = prior.then(() => runScript({ script: hook.script, hooksDir: path.join(agentDir, "pi-ad-hooks"), agentDir, timeoutMs: hook.timeoutMs, id: hook.id, event: name, payload, diagnostic: report }));
      queues.set(name, next.catch(() => { report(hook.id, name, "SCRIPT_DISPATCH_FAILED"); }));
    }
  }
  // This is only the public API's required neutral result; hooks never decide project trust.
  pi.on("project_trust", event => { dispatch("project_trust", event); return { trusted: "undecided" }; });
  pi.on("resources_discover", event => dispatch("resources_discover", event));
  pi.on("session_start", event => { prompts.clear(); activeRun = false; dispatch("session_start", event); });
  pi.on("session_info_changed", event => dispatch("session_info_changed", event));
  pi.on("session_before_switch", event => { prompts.clear(); activeRun = false; dispatch("session_before_switch", event); });
  pi.on("session_before_fork", event => { prompts.clear(); activeRun = false; dispatch("session_before_fork", event); });
  pi.on("session_before_compact", event => dispatch("session_before_compact", event));
  pi.on("session_compact", event => dispatch("session_compact", event));
  pi.on("session_compact_failed", event => dispatch("session_compact_failed", event));
  pi.on("session_shutdown", event => { prompts.clear(); activeRun = false; dispatch("session_shutdown", event); });
  pi.on("mcp_servers_change", event => dispatch("mcp_servers_change", event));
  pi.on("session_before_tree", event => { prompts.clear(); activeRun = false; dispatch("session_before_tree", event); });
  pi.on("session_tree", event => { prompts.clear(); activeRun = false; dispatch("session_tree", event); });
  pi.on("context", event => {
    dispatch("context", event);
    const staged = prompts.consume();
    if (staged.length === 0) return;
    return { messages: [...event.messages, ...staged.map(content => ({ role: "custom" as const, customType: "pi-ad-hooks", content, display: false, timestamp: Date.now() }))] };
  });
  pi.on("context_with_system", event => dispatch("context_with_system", event));
  pi.on("cache_warming_decision", event => dispatch("cache_warming_decision", event));
  pi.on("before_provider_request", event => dispatch("before_provider_request", event));
  pi.on("before_provider_headers", event => dispatch("before_provider_headers", event));
  pi.on("after_provider_response", event => dispatch("after_provider_response", event));
  pi.on("provider_stream_event", event => dispatch("provider_stream_event", event));
  pi.on("before_agent_start", event => { activeRun = true; dispatch("before_agent_start", event); });
  pi.on("agent_start", event => dispatch("agent_start", event));
  pi.on("agent_end", event => dispatch("agent_end", event));
  pi.on("agent_before_settle", event => dispatch("agent_before_settle", event));
  pi.on("agent_settled", event => { prompts.clear(); activeRun = false; dispatch("agent_settled", event); });
  pi.on("ui_prompt_start", event => dispatch("ui_prompt_start", event));
  pi.on("ui_prompt_end", event => dispatch("ui_prompt_end", event));
  pi.on("turn_start", event => dispatch("turn_start", event));
  pi.on("turn_end", event => dispatch("turn_end", event));
  pi.on("message_start", event => dispatch("message_start", event));
  pi.on("message_update", event => dispatch("message_update", event));
  pi.on("message_end", event => dispatch("message_end", event));
  pi.on("tool_execution_start", event => dispatch("tool_execution_start", event));
  pi.on("tool_execution_update", event => dispatch("tool_execution_update", event));
  pi.on("tool_execution_end", event => dispatch("tool_execution_end", event));
  pi.on("model_select", event => dispatch("model_select", event));
  pi.on("thinking_level_select", event => dispatch("thinking_level_select", event));
  pi.on("tool_call", event => dispatch("tool_call", event));
  pi.on("tool_result", event => dispatch("tool_result", event));
  pi.on("user_bash", event => dispatch("user_bash", event));
  pi.on("input", event => {
    // Input handlers can short-circuit before an agent run; a new idle input starts fresh.
    if (event.streamingBehavior === undefined) {
      prompts.clear();
      activeRun = false;
    }
    activeRun = true;
    dispatch("input", event);
  });
}
