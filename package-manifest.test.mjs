import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const expectedExtensions = [
  "./pi-ad-telegram/index.ts",
  "./pi-ad-session-usage/index.ts",
  "./pi-ad-hooks/index.ts",
  "./pi-ad-task/index.ts",
];

test("Pi package exposes exactly the four first-party extensions and task skill", () => {
  assert.deepEqual(pkg.pi?.extensions, expectedExtensions);
  for (const entry of expectedExtensions) assert.equal(existsSync(path.join(root, entry)), true, `${entry} must exist`);
  assert.deepEqual(pkg.pi?.skills, ["./pi-ad-task/skills/*"]);
  assert.equal(existsSync(path.join(root, "pi-ad-task/skills/task-workflow/SKILL.md")), true);
});

test("Pi runtime packages are peers and are not runtime dependencies", () => {
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"]) {
    assert.equal(pkg.peerDependencies?.[name], "*");
    assert.equal(pkg.dependencies?.[name], undefined);
  }
});
