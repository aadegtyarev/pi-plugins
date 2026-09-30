import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import type { Diagnostic } from "./config.ts";
import type { HookEvent } from "./config.ts";

export type Spawn = typeof nodeSpawn;
export function runScript(options: { script: string; hooksDir: string; agentDir: string; timeoutMs: number; id: string; event: HookEvent; payload: unknown; diagnostic: Diagnostic; spawn?: Spawn }): Promise<void> {
  let input: string;
  try { input = JSON.stringify({ version: 1, event: options.event, payload: options.payload }); if (input === undefined) throw new Error(); }
  catch { options.diagnostic(options.id, options.event, "EVENT_SERIALIZATION_FAILED"); return Promise.resolve(); }
  let child: ChildProcess;
  try {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PI_CODING_AGENT_DIR: options.agentDir };
    for (const key of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TMP", "TEMP"] as const) if (process.env[key]) env[key] = process.env[key];
    child = (options.spawn ?? nodeSpawn)(process.execPath, [options.script], { cwd: options.hooksDir, env, stdio: ["pipe", "ignore", "ignore"], shell: false });
  } catch { options.diagnostic(options.id, options.event, "SCRIPT_LAUNCH_FAILED"); return Promise.resolve(); }
  return new Promise(resolve => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try { child.kill("SIGKILL"); } catch { /* Best effort: a timeout must not affect Pi's event flow. */ }
        options.diagnostic(options.id, options.event, "SCRIPT_TIMEOUT", { timeoutMs: options.timeoutMs });
        resolve();
      }
    }, options.timeoutMs);
    const finish = (code: string, metadata?: Record<string, number | string>) => { if (done) return; done = true; clearTimeout(timer); if (code !== "SCRIPT_EXITED") options.diagnostic(options.id, options.event, code, metadata); resolve(); };
    child.once("error", () => finish("SCRIPT_LAUNCH_FAILED"));
    child.once("close", (code) => finish(code === 0 ? "SCRIPT_EXITED" : "SCRIPT_NONZERO_EXIT", code === null ? undefined : { exitCode: code }));
    child.stdin?.once("error", () => finish("SCRIPT_LAUNCH_FAILED"));
    try { child.stdin?.end(input); } catch { finish("SCRIPT_LAUNCH_FAILED"); }
  });
}
