import test from "node:test";
import assert from "node:assert/strict";
import extension from "./index.ts";
import { EVENTS } from "./config.ts";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

test("extension registers precisely every public event once", () => {
  const registered: string[] = [];
  const api = { on(event: string) { registered.push(event); return () => {}; } };
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-ad-hooks-host-"));
  try {
    process.env.PI_CODING_AGENT_DIR = dir;
    const oldError = console.error; console.error = () => {};
    try { extension(api as never); } finally { console.error = oldError; }
    assert.deepEqual(registered, [...EVENTS]);
    assert.equal(new Set(registered).size, 41);
  } finally { if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir; rmSync(dir, { recursive: true, force: true }); }
});

test("script handlers return immediately while same-event child jobs run in order", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-ad-hooks-queue-")); mkdirSync(path.join(dir, "pi-ad-hooks"));
  const oldDir = process.env.PI_CODING_AGENT_DIR; const output = path.join(dir, "order.txt");
  try {
    process.env.PI_CODING_AGENT_DIR = dir;
    writeFileSync(path.join(dir, "pi-ad-hooks", "first.mjs"), `import fs from 'node:fs'; await new Promise(r=>setTimeout(r,80)); fs.appendFileSync(${JSON.stringify(output)}, 'first\\n');`);
    writeFileSync(path.join(dir, "pi-ad-hooks", "second.mjs"), `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(output)}, 'second\\n');`);
    writeFileSync(path.join(dir, "pi-ad-hooks.json"), JSON.stringify({ version: 1, hooks: { turn_start: [
      { id: "first", type: "script", script: "first.mjs" }, { id: "second", type: "script", script: "second.mjs" },
    ] } }));
    let startHandler: ((event: unknown) => unknown) | undefined;
    const oldError = console.error; console.error = () => {};
    try { extension({ on(event: string, handler: (event: unknown) => unknown) { if (event === "turn_start") startHandler = handler; } } as never); }
    finally { console.error = oldError; }
    const started = Date.now(); startHandler!({}); assert(Date.now() - started < 100);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(readFileSync(output, "utf8"), "first\nsecond\n");
  } finally { if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir; rmSync(dir, { recursive: true, force: true }); }
});

test("context hooks affect that context result; context_with_system waits for ordinary context", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-ad-hooks-host-")); mkdirSync(path.join(dir, "pi-ad-hooks"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = dir;
    writeFileSync(path.join(dir, "pi-ad-hooks.json"), JSON.stringify({ version: 1, hooks: {
      context: [{ id: "same-event", type: "prompt", text: "from context hook" }, { id: "same-event-2", type: "prompt", text: "second prompt" }],
      context_with_system: [{ id: "later-context", type: "prompt", text: "from system context" }],
    } }));
    const handlers = new Map<string, (event: any) => any>();
    const oldError = console.error; console.error = () => {};
    try { extension({ on(event: string, handler: (event: any) => any) { handlers.set(event, handler); } } as never); }
    finally { console.error = oldError; }
    handlers.get("input")!({});
    handlers.get("context_with_system")!({});
    const context = handlers.get("context")!({ messages: [] });
    assert.deepEqual(context.messages.map((m: any) => m.content), ["from system context", "from context hook", "second prompt"]);
    assert.equal(context.messages.every((m: any) => m.role === "custom" && m.customType === "pi-ad-hooks" && m.display === false), true);
    assert.deepEqual(handlers.get("context")!({ messages: [] }).messages.map((m: any) => m.content), ["from context hook", "second prompt"]);
  } finally { if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir; rmSync(dir, { recursive: true, force: true }); }
});

test("outside-run prompts are rejected and session/run cleanup discards pending text", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-ad-hooks-cleanup-")); mkdirSync(path.join(dir, "pi-ad-hooks"));
  const oldDir = process.env.PI_CODING_AGENT_DIR; const diagnostics: string[] = [];
  const oldError = console.error;
  try {
    process.env.PI_CODING_AGENT_DIR = dir;
    console.error = (...args: unknown[]) => diagnostics.push(String(args[0]));
    writeFileSync(path.join(dir, "pi-ad-hooks.json"), JSON.stringify({ version: 1, hooks: {
      session_start: [{ id: "startup", type: "prompt", text: "no" }],
      context_with_system: [{ id: "pending", type: "prompt", text: "discard" }],
      agent_settled: [{ id: "settled", type: "prompt", text: "no" }],
      session_shutdown: [{ id: "shutdown", type: "prompt", text: "no" }],
    } }));
    const handlers = new Map<string, (event: any) => any>();
    extension({ on(event: string, handler: (event: any) => any) { handlers.set(event, handler); } } as never);
    handlers.get("session_start")!({});
    handlers.get("before_agent_start")!({}); handlers.get("agent_settled")!({}); handlers.get("session_shutdown")!({});
    assert.equal(diagnostics.filter(x => x.includes("PROMPT_ACTION_OUTSIDE_RUN")).length, 3);
    handlers.get("before_agent_start")!({}); handlers.get("context_with_system")!({});
    handlers.get("session_before_fork")!({}); handlers.get("before_agent_start")!({});
    assert.equal(handlers.get("context")!({ messages: [] }), undefined);
    handlers.get("context_with_system")!({}); handlers.get("agent_settled")!({});
    assert.equal(handlers.get("context")!({ messages: [] }), undefined);
  } finally { console.error = oldError; if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir; rmSync(dir, { recursive: true, force: true }); }
});

test("a new idle input clears prompt state left by a handled input", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-ad-hooks-input-reset-")); mkdirSync(path.join(dir, "pi-ad-hooks"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = dir;
    writeFileSync(path.join(dir, "pi-ad-hooks.json"), JSON.stringify({ version: 1, hooks: {
      input: [{ id: "input-prompt", type: "prompt", text: "current input" }],
      session_info_changed: [{ id: "stale-prompt", type: "prompt", text: "stale input context" }],
    } }));
    const handlers = new Map<string, (event: any) => any>();
    extension({ on(event: string, handler: (event: any) => any) { handlers.set(event, handler); } } as never);
    handlers.get("input")!({ text: "/handled", source: "interactive" });
    handlers.get("session_info_changed")!({});
    handlers.get("input")!({ text: "next request", source: "interactive" });
    const result = handlers.get("context")!({ messages: [] });
    assert.deepEqual(result.messages.map((message: any) => message.content), ["current input"]);
  } finally { if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir; rmSync(dir, { recursive: true, force: true }); }
});

test("steering input preserves pending prompt text in the active run", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-ad-hooks-steer-input-")); mkdirSync(path.join(dir, "pi-ad-hooks"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = dir;
    writeFileSync(path.join(dir, "pi-ad-hooks.json"), JSON.stringify({ version: 1, hooks: {
      turn_end: [{ id: "turn-prompt", type: "prompt", text: "active run context" }],
      input: [{ id: "steering-prompt", type: "prompt", text: "steering context" }],
    } }));
    const handlers = new Map<string, (event: any) => any>();
    extension({ on(event: string, handler: (event: any) => any) { handlers.set(event, handler); } } as never);
    handlers.get("before_agent_start")!({});
    handlers.get("turn_end")!({});
    handlers.get("input")!({ text: "follow-up", source: "interactive", streamingBehavior: "steer" });
    const result = handlers.get("context")!({ messages: [] });
    assert.deepEqual(result.messages.map((message: any) => message.content), ["active run context", "steering context"]);
  } finally { if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir; rmSync(dir, { recursive: true, force: true }); }
});
