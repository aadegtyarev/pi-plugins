import { realpathSync, readFileSync } from "node:fs";
import path from "node:path";

export const EVENTS = [
  "project_trust", "resources_discover", "session_start", "session_info_changed", "session_before_switch", "session_before_fork", "session_before_compact", "session_compact", "session_compact_failed", "session_shutdown", "mcp_servers_change", "session_before_tree", "session_tree", "context", "context_with_system", "cache_warming_decision", "before_provider_request", "before_provider_headers", "after_provider_response", "provider_stream_event", "before_agent_start", "agent_start", "agent_end", "agent_before_settle", "agent_settled", "ui_prompt_start", "ui_prompt_end", "turn_start", "turn_end", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "model_select", "thinking_level_select", "tool_call", "tool_result", "user_bash", "input",
] as const;
export type HookEvent = typeof EVENTS[number];
export type Hook = { id: string; type: "prompt"; text: string } | { id: string; type: "script"; script: string; timeoutMs: number };
export type HookConfig = Partial<Record<HookEvent, Hook[]>>;
export type Diagnostic = (hookId: string, event: string, code: string, safeMetadata?: Record<string, number | string>) => void;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function loadConfig(agentDir: string, diagnostic: Diagnostic = () => {}): HookConfig {
  const configPath = path.join(agentDir, "pi-ad-hooks.json");
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(configPath, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    diagnostic("config", "config", "CONFIG_READ_OR_PARSE_FAILED"); return {};
  }
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.hooks)) {
    diagnostic("config", "config", "CONFIG_SCHEMA_INVALID"); return {};
  }
  const result: HookConfig = {};
  const ids = new Set<string>();
  for (const [event, entries] of Object.entries(raw.hooks)) {
    if (!(EVENTS as readonly string[]).includes(event)) { diagnostic("config", event, "UNKNOWN_EVENT"); continue; }
    if (!Array.isArray(entries)) { diagnostic("config", event, "HOOK_LIST_INVALID"); continue; }
    const valid: Hook[] = [];
    for (const value of entries) {
      if (!isRecord(value) || typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.id) || ids.has(value.id)) {
        diagnostic("invalid", event, "HOOK_ID_INVALID_OR_DUPLICATE"); continue;
      }
      const id = value.id;
      ids.add(id);
      if (value.type === "prompt" && typeof value.text === "string" && value.text.length > 0 && Object.keys(value).every(key => ["id", "type", "text"].includes(key))) {
        valid.push({ id, type: "prompt", text: value.text }); continue;
      }
      if (value.type === "script" && typeof value.script === "string" && Object.keys(value).every(key => ["id", "type", "script", "timeoutMs"].includes(key))) {
        const rel = value.script;
        const timeout = value.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : value.timeoutMs;
        if (!Number.isInteger(timeout) || (timeout as number) < 100 || (timeout as number) > MAX_TIMEOUT_MS) { diagnostic(id, event, "TIMEOUT_INVALID"); continue; }
        if (!rel || path.isAbsolute(rel) || !rel.endsWith(".mjs") || rel.split(/[\\/]/).includes("..")) { diagnostic(id, event, "SCRIPT_PATH_INVALID"); continue; }
        try {
          const agentRoot = realpathSync(agentDir);
          const root = realpathSync(path.join(agentDir, "pi-ad-hooks"));
          const resolved = realpathSync(path.join(root, rel));
          if (!root.startsWith(agentRoot + path.sep) || !resolved.startsWith(root + path.sep) || !resolved.endsWith(".mjs")) throw new Error();
          valid.push({ id, type: "script", script: resolved, timeoutMs: timeout as number });
        } catch { diagnostic(id, event, "SCRIPT_PATH_INVALID"); }
        continue;
      }
      diagnostic(id, event, "HOOK_ENTRY_INVALID");
    }
    result[event as HookEvent] = valid;
  }
  return result;
}
