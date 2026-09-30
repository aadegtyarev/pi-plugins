import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { runScript } from "./script-runner.ts";

test("scripts receive JSON envelope asynchronously and nonzero exit is safe", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-ad-hooks-run-")); const seen: string[] = [];
  try {
    const file = path.join(dir, "hook.mjs");
    writeFileSync(file, `let s=''; for await (const c of process.stdin) s+=c; const x=JSON.parse(s); if(x.version!==1||x.event!=='turn_start'||x.payload.value!==42||process.env.PI_CODING_AGENT_DIR!==${JSON.stringify(dir)}) process.exit(4);`);
    const start = Date.now();
    const first = runScript({ script: file, hooksDir: dir, agentDir: dir, timeoutMs: 1000, id: "test", event: "turn_start", payload: { value: 42 }, diagnostic: (_id, _event, code) => seen.push(code) });
    assert(Date.now() - start < 100);
    await first; assert.deepEqual(seen, []);
    writeFileSync(file, "process.exit(7)");
    await runScript({ script: file, hooksDir: dir, agentDir: dir, timeoutMs: 1000, id: "test", event: "turn_start", payload: {}, diagnostic: (_id, _event, code) => seen.push(code) });
    assert.deepEqual(seen, ["SCRIPT_NONZERO_EXIT"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("timeout force-terminates the child process", async () => {
  const seen: string[] = []; let killedWith: string | undefined;
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), kill(signal: string) { killedWith = signal; return true; } });
  await runScript({ script: "ignored.mjs", hooksDir: ".", agentDir: ".", timeoutMs: 100, id: "timeout", event: "input", payload: {},
    spawn: (() => child) as any, diagnostic: (_id, _event, code) => seen.push(code) });
  assert.equal(killedWith, "SIGKILL");
  assert.deepEqual(seen, ["SCRIPT_TIMEOUT"]);
});

test("serialization and timeout fail open", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-ad-hooks-timeout-")); const seen: string[] = [];
  try {
    const circular: Record<string, unknown> = {}; circular.self = circular;
    runScript({ script: "nope.mjs", hooksDir: dir, agentDir: dir, timeoutMs: 100, id: "x", event: "input", payload: circular, diagnostic: (_id, _event, code) => seen.push(code) });
    assert.deepEqual(seen, ["EVENT_SERIALIZATION_FAILED"]);
    const file = path.join(dir, "slow.mjs"); writeFileSync(file, "setTimeout(()=>{},5000)");
    await runScript({ script: file, hooksDir: dir, agentDir: dir, timeoutMs: 100, id: "x", event: "input", payload: {}, diagnostic: (_id, _event, code) => seen.push(code) });
    assert.deepEqual(seen, ["EVENT_SERIALIZATION_FAILED", "SCRIPT_TIMEOUT"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
