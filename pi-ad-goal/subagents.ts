import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Documented pi-subagents extension API: see "In-process event-bus RPC" in the pi-subagents extension API guide.
export const RPC_READY_EVENT = "subagents:rpc:v1:ready";
export const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";
export const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";

/** How long to wait for a pi-subagents status reply before treating it as unavailable. */
export const DEFAULT_STATUS_TIMEOUT_MS = 1500;

export interface SubagentMonitor {
  /** Subagents of the current session that are still running, or undefined when pi-subagents does not answer. */
  activeCount(): Promise<number | undefined>;
}

/**
 * Asks pi-subagents how many of this session's subagents are still running.
 * After one unanswered request it stops asking until pi-subagents announces itself again,
 * so a missing pi-subagents costs one timeout rather than one per step.
 */
export function createSubagentMonitor(pi: ExtensionAPI, timeoutMs = DEFAULT_STATUS_TIMEOUT_MS): SubagentMonitor {
  const events = pi.events;
  let available = true;
  // Any sign of pi-subagents makes it worth asking again after a timeout.
  for (const name of [RPC_READY_EVENT, SUBAGENT_ASYNC_STARTED_EVENT, SUBAGENT_ASYNC_COMPLETE_EVENT]) events?.on?.(name, () => { available = true; });
  return {
    activeCount() {
      if (!available || typeof events?.on !== "function" || typeof events.emit !== "function") return Promise.resolve(undefined);
      const requestId = randomUUID();
      return new Promise(resolve => {
        let settled = false;
        let unsubscribe: (() => void) | undefined;
        const finish = (count: number | undefined) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (typeof unsubscribe === "function") unsubscribe();
          resolve(count);
        };
        const timer = setTimeout(() => { available = false; finish(undefined); }, timeoutMs);
        unsubscribe = events.on(`${RPC_REPLY_EVENT_PREFIX}${requestId}`, reply => {
          const data = reply as { success?: unknown; data?: { fleet?: { totalActive?: unknown } } } | undefined;
          const count = data?.success === true ? data.data?.fleet?.totalActive : undefined;
          finish(typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : undefined);
        });
        try {
          events.emit(RPC_REQUEST_EVENT, { version: 1, requestId, method: "status", params: {} });
        } catch {
          finish(undefined);
        }
      });
    },
  };
}
