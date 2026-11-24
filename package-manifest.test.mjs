import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const expectedExtensions = [
  "./pi-ad-hooks/index.ts",
  "./pi-ad-goal/index.ts",
  "./node_modules/pi-subagents/bundle/index.js",
];

test("Pi package exposes the two first-party extensions, the goal skill, and bundled pi-subagents", () => {
  assert.deepEqual(pkg.pi?.extensions, expectedExtensions);
  for (const entry of expectedExtensions) assert.equal(existsSync(path.join(root, entry)), true, `${entry} must exist`);
  assert.deepEqual(pkg.pi?.skills, ["./pi-ad-goal/skills/*", "./node_modules/pi-subagents/skills"]);
  assert.deepEqual(pkg.pi?.prompts, ["./node_modules/pi-subagents/prompts"]);
  for (const entry of [...pkg.pi.skills.slice(1), ...pkg.pi.prompts]) assert.equal(existsSync(path.join(root, entry)), true, `${entry} must exist`);
  assert.equal(existsSync(path.join(root, "pi-ad-goal/skills/goal-workflow/SKILL.md")), true);
});

test("goal workflow skill requires confirmed transitions and goal completion", () => {
  const skill = readFileSync(path.join(root, "pi-ad-goal/skills/goal-workflow/SKILL.md"), "utf8");
  assert.match(skill, /Do not report a state change until the tool confirms it/);
  assert.match(skill, /mark the goal done only when it is complete/);
});

test("pi-subagents is pinned to the exact version whose API the goal extension uses", () => {
  assert.match(pkg.dependencies?.["pi-subagents"] ?? "", /^\d+\.\d+\.\d+$/);
  const installed = JSON.parse(readFileSync(path.join(root, "node_modules/pi-subagents/package.json"), "utf8"));
  assert.equal(installed.version, pkg.dependencies["pi-subagents"]);
});

test("Pi runtime packages are peers and are not runtime dependencies", () => {
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "typebox"]) {
    assert.equal(pkg.peerDependencies?.[name], "*");
    assert.equal(pkg.dependencies?.[name], undefined);
  }
});
