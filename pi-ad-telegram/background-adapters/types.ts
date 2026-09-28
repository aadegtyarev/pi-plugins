export interface BackgroundWorkStarted {
  type: "started";
  adapter: string;
  id: string;
  agent: string;
  task?: string;
  model?: string;
  statusDirectory?: string;
}

export interface BackgroundWorkCompleted {
  type: "completed";
  adapter: string;
  id: string;
  agent?: string;
  status: "completed" | "failed" | "stopped";
  summary?: string;
  error?: string;
}

export type BackgroundWorkEvent = BackgroundWorkStarted | BackgroundWorkCompleted;
export type BackgroundWorkSink = (event: BackgroundWorkEvent) => void;
