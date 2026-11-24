// Compatibility contract between pi-ad-goal and the installed pi-subagents release.
// It runs pi-subagents' own code, so a release that changes something pi-ad-goal relies on fails here
// before it reaches users. A failure means: recheck pi-ad-goal/subagents.ts and review-limit.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { countReviewRejections, scanReviewVerdicts } from "./review-limit.ts";
import { RPC_READY_EVENT, RPC_REPLY_EVENT_PREFIX, RPC_REQUEST_EVENT, SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_STARTED_EVENT } from "./subagents.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = path.join(root, "node_modules/pi-subagents");
const version = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")).version as string;

async function load(relative: string): Promise<any> {
  try {
    return await import(path.join(pkgDir, relative));
  } catch (error) {
    assert.fail(`pi-subagents ${version}: cannot load ${relative} (${String(error)}). Its internal layout changed; recheck the formats pi-ad-goal parses.`);
  }
}

test(`pi-subagents ${version} keeps the event names and RPC channels pi-ad-goal uses`, async () => {
  const types = await load("src/shared/types.js");
  const rpc = await load("src/extension/rpc.js");
  assert.equal(types.SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_COMPLETE_EVENT);
  assert.equal(types.SUBAGENT_ASYNC_STARTED_EVENT, SUBAGENT_ASYNC_STARTED_EVENT);
  assert.equal(rpc.SUBAGENT_RPC_PROTOCOL_VERSION, 1);
  assert.equal(rpc.SUBAGENT_RPC_REQUEST_EVENT, RPC_REQUEST_EVENT);
  assert.equal(rpc.SUBAGENT_RPC_READY_EVENT, RPC_READY_EVENT);
  assert.equal(rpc.SUBAGENT_RPC_REPLY_EVENT_PREFIX, RPC_REPLY_EVENT_PREFIX);
  assert.ok(rpc.SUBAGENT_RPC_METHODS.includes("status"));
});

test(`pi-subagents ${version} reviewer verdicts and completion notices are parsed by pi-ad-goal`, async () => {
  const notify = await load("src/runs/background/notify.js");
  const single = await load("src/runs/shared/single-output.js");
  const reviewer = readFileSync(path.join(pkgDir, "agents/reviewer.md"), "utf8");
  assert.match(reviewer, /Merge verdict: BLOCK, OK/, "the bundled reviewer must still end with a Merge verdict line");

  const short = (verdict: string) => `## Review\n- Finding: P1 issue in a.ts:1\n- Merge verdict: ${verdict}`;
  const completion = (verdict: string, extra = {}) => ({ agent: "reviewer", status: "completed", resultPreview: short(verdict), ...extra });
  const notice = (content: string) => ({ type: "custom_message", content });
  assert.equal(countReviewRejections([notice(notify.formatSingleCompletion(completion("BLOCK")))]), 1, "single background notice");
  assert.equal(countReviewRejections([notice(notify.formatSingleCompletion(completion("OK with notes")))]), 0);
  assert.equal(countReviewRejections([notice(notify.formatSingleCompletion(completion("BLOCK", { source: "foreground" })))]), 1, "detached foreground notice");
  const grouped = notify.formatGroupedCompletion([{ agent: "worker", status: "completed", resultPreview: "done\n- Merge verdict: BLOCK" }, completion("BLOCK"), completion("OK")]);
  assert.equal(countReviewRejections([notice(grouped)]), 1, "grouped notice counts only reviewer blocks");

  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-ad-goal-compat-"));
  try {
    const long = `## Review\n${"- Finding: P1 something is wrong in file.ts:10\n".repeat(120)}- Merge verdict: BLOCK\n`;
    const file = path.join(dir, "output.md");
    writeFileSync(file, long);
    const preview = single.capSummaryOutputs(`reviewer:\n${long}`, [{ agent: "reviewer", output: long, artifactPaths: { outputPath: file } }]);
    assert.doesNotMatch(preview, /Merge verdict/, "the verdict is beyond the inline preview, so it must come from the file");
    const truncated = scanReviewVerdicts([notice(notify.formatSingleCompletion({ agent: "reviewer", status: "completed", resultPreview: preview }))]);
    assert.deepEqual(truncated, { rejections: 1, discovered: [{ path: file, rejected: true }] }, "truncated background notice");

    const toolText = single.capInlineOutput(long, { artifactPath: file });
    const branch = [
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "subagent", arguments: { agent: "reviewer", task: "review" } }] } },
      { type: "message", message: { role: "toolResult", toolName: "subagent", toolCallId: "c1", content: [{ type: "text", text: toolText }] } },
    ];
    assert.equal(countReviewRejections(branch), 1, "truncated foreground tool result");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(`pi-subagents ${version} answers pi-ad-goal's status request inside a real Pi`, { timeout: 120_000 }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-ad-goal-live-"));
  try {
    const agentDir = path.join(dir, "agent");
    const cwd = path.join(dir, "cwd");
    mkdirSync(agentDir);
    mkdirSync(cwd);
    writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [root] }));
    const probe = path.join(dir, "probe.ts");
    writeFileSync(probe, `
import { randomUUID } from "node:crypto";
const ask = (pi: any, method: string) => new Promise(resolve => {
  const requestId = randomUUID();
  const timer = setTimeout(() => resolve({ timeout: true }), 10000);
  pi.events.on(${JSON.stringify(RPC_REPLY_EVENT_PREFIX)} + requestId, (reply: any) => { clearTimeout(timer); resolve(reply); });
  pi.events.emit(${JSON.stringify(RPC_REQUEST_EVENT)}, { version: 1, requestId, method, params: {} });
});
export default function (pi: any) {
  pi.registerCommand("compat-probe", { description: "compat probe", async handler() {
    const tools = pi.getAllTools().map((tool: any) => tool.name);
    console.log("COMPAT " + JSON.stringify({ tools, ping: await ask(pi, "ping"), status: await ask(pi, "status") }));
  } });
}
`);
    const cli = path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
    const run = spawnSync(process.execPath, [cli, "-p", "/compat-probe", "-e", probe], {
      cwd,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      encoding: "utf8",
      timeout: 100_000,
    });
    const line = `${run.stdout}\n${run.stderr}`.split("\n").find(text => text.startsWith("COMPAT "));
    assert.ok(line, `Pi produced no probe output (exit ${run.status}):\n${run.stdout}\n${run.stderr}`);
    const result = JSON.parse(line.slice("COMPAT ".length));
    for (const tool of ["goal_control", "goal_update", "subagent"]) assert.ok(result.tools.includes(tool), `${tool} must load`);
    assert.equal(result.ping.success, true, "ping must succeed");
    assert.equal(result.ping.data.version, 1);
    assert.deepEqual(result.ping.data.capabilities.fleetStatus, { version: 1 });
    assert.equal(result.ping.data.events.asyncComplete, SUBAGENT_ASYNC_COMPLETE_EVENT);
    assert.equal(result.status.success, true, "status must succeed");
    assert.equal(result.status.data.fleet.totalActive, 0, "status must report fleet.totalActive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
