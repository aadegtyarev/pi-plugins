import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { attachPiSubagentsAdapter } from "./pi-subagents.ts";
import type { BackgroundWorkSink } from "./types.ts";

/** Install the selected integrations; Telegram core only consumes normalized work events. */
export function installBackgroundAdapters(pi: ExtensionAPI, emit: BackgroundWorkSink): void {
  attachPiSubagentsAdapter(pi, emit);
}
