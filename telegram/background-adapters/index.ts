import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { attachPiSubagentsAdapter } from "./pi-subagents";
import type { BackgroundWorkSink } from "./types";

/** Install the selected integrations; Telegram core only consumes normalized work events. */
export function installBackgroundAdapters(pi: ExtensionAPI, emit: BackgroundWorkSink): void {
  attachPiSubagentsAdapter(pi, emit);
}
