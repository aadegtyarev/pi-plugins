import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, EVENTS } from "./config.ts";

function fixture() { const dir = mkdtempSync(path.join(os.tmpdir(), "pi-ad-hooks-")); mkdirSync(path.join(dir, "pi-ad-hooks")); return dir; }
test("missing config means no hooks without diagnostics", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-ad-hooks-missing-")); const logs: string[] = [];
  try { assert.deepEqual(loadConfig(dir, (_id, _event, code) => logs.push(code)), {}); assert.deepEqual(logs, []); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test("config accepts exact events, ordered hooks and default timeout", () => {
  const dir = fixture();
  try {
    writeFileSync(path.join(dir, "pi-ad-hooks", "ok.mjs"), "");
    writeFileSync(path.join(dir, "pi-ad-hooks.json"), JSON.stringify({ version: 1, hooks: { turn_start: [{ id: "one", type: "prompt", text: "hello" }, { id: "two", type: "script", script: "ok.mjs" }] } }));
    const cfg = loadConfig(dir);
    assert.deepEqual(cfg.turn_start?.map(x => x.id), ["one", "two"]);
    assert.equal(cfg.turn_start?.[1]?.type === "script" && cfg.turn_start[1].timeoutMs, 5000);
    assert.equal(EVENTS.length, 41);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("system_prompt hooks are accepted only on before_agent_start", () => {
  const dir = fixture(); const diagnostics: string[] = [];
  try {
    writeFileSync(path.join(dir, "pi-ad-hooks.json"), JSON.stringify({ version: 1, hooks: {
      before_agent_start: [{ id: "system-rule", type: "system_prompt", text: "Use Russian." }],
      context: [{ id: "wrong-event", type: "system_prompt", text: "Do not enable here." }],
    } }));
    const config = loadConfig(dir, (_id, event, code) => diagnostics.push(`${event}:${code}`));
    assert.deepEqual(config.before_agent_start, [{ id: "system-rule", type: "system_prompt", text: "Use Russian." }]);
    assert.deepEqual(config.context, []);
    assert.deepEqual(diagnostics, ["context:SYSTEM_PROMPT_EVENT_INVALID"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("invalid config entries are disabled with safe diagnostics and paths confined", () => {
  const dir = fixture(); const outside = path.join(dir, "outside.mjs"); writeFileSync(outside, "");
  const logs: string[] = [];
  try {
    symlinkSync(outside, path.join(dir, "pi-ad-hooks", "escape.mjs"));
    writeFileSync(path.join(dir, "pi-ad-hooks.json"), JSON.stringify({ version: 1, hooks: { made_up: [], turn_start: [
      { id: "bad", type: "script", script: "../outside.mjs" }, { id: "escape", type: "script", script: "escape.mjs" },
      { id: "timeout", type: "script", script: "x.mjs", timeoutMs: 99 }, { id: "dup", type: "prompt", text: "x" }, { id: "dup", type: "prompt", text: "y" },
    ] } }));
    const config = loadConfig(dir, (_id, event, code) => logs.push(`${event}:${code}`));
    assert.deepEqual(config.turn_start?.map(hook => hook.id), ["dup"]);
    assert(logs.includes("made_up:UNKNOWN_EVENT"));
    assert(logs.includes("turn_start:SCRIPT_PATH_INVALID"));
    assert(logs.includes("turn_start:TIMEOUT_INVALID"));
    assert(logs.includes("turn_start:HOOK_ID_INVALID_OR_DUPLICATE"));
    assert(!logs.some(x => x.includes("outside")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
