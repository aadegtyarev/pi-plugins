import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_TELEGRAM_SETTINGS,
  getTelegramSettingsPath,
  loadTelegramSettings,
  parseTelegramSettings,
} from "./config.ts";

const HOME = "/home/test-user";

test("Telegram settings path follows PI_CODING_AGENT_DIR and otherwise defaults under the home directory", () => {
  assert.equal(getTelegramSettingsPath({}, HOME), join(HOME, ".pi", "agent", "pi-ad-telegram.json"));
  assert.equal(getTelegramSettingsPath({ PI_CODING_AGENT_DIR: "/custom/pi-agent" }, HOME), "/custom/pi-agent/pi-ad-telegram.json");
});

test("missing settings file yields documented defaults and agent-local outbox path", async () => {
  const settings = await loadTelegramSettings({ PI_CODING_AGENT_DIR: "/custom/pi-agent" }, HOME);
  assert.deepEqual(settings, {
    ...DEFAULT_TELEGRAM_SETTINGS,
    outboxPath: "/custom/pi-agent/telegram-outbox.json",
  });
  assert.equal(settings.staleBacklogThresholdMs, 30_000);
  assert.equal(settings.messageChunkLimit, 3500);
});

test("settings file overrides defaults, resolves relative paths, and leaves credentials outside config", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-settings-"));
  try {
    await writeFile(join(root, "pi-ad-telegram.json"), JSON.stringify({
      staleBacklogThresholdMs: 45_000,
      retryBaseDelayMs: 250,
      retryMaxDelayMs: 5000,
      outboxPath: "state/outbox.json",
    }));
    const settings = await loadTelegramSettings({ PI_CODING_AGENT_DIR: root, PI_TELEGRAM_BOT_TOKEN: "never-read" }, HOME);
    assert.equal(settings.staleBacklogThresholdMs, 45_000);
    assert.equal(settings.retryBaseDelayMs, 250);
    assert.equal(settings.retryMaxDelayMs, 5000);
    assert.equal(settings.outboxPath, join(root, "state", "outbox.json"));
    assert.equal("botToken" in settings, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("absolute outbox paths remain absolute", () => {
  assert.equal(parseTelegramSettings({ outboxPath: "/tmp/telegram-outbox.json" }, "/agent").outboxPath, "/tmp/telegram-outbox.json");
});

test("invalid setting types, ranges, unknown keys, and retry ordering are rejected", () => {
  assert.throws(() => parseTelegramSettings({ queueCapacity: 20 }, "/agent"), /Unknown Telegram setting: queueCapacity/);
  assert.throws(() => parseTelegramSettings({ longPollTimeoutSeconds: 51 }, "/agent"), /longPollTimeoutSeconds must be an integer/);
  assert.throws(() => parseTelegramSettings({ retryBaseDelayMs: 5000, retryMaxDelayMs: 1000 }, "/agent"), /retryMaxDelayMs must be greater than or equal/);
  assert.throws(() => parseTelegramSettings({ botToken: "secret" }, "/agent"), /Unknown Telegram setting: botToken/);
  assert.throws(() => parseTelegramSettings([], "/agent"), /must be a JSON object/);
});

test("malformed settings JSON and invalid settings are reported with the settings-file path", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-settings-"));
  const path = join(root, "pi-ad-telegram.json");
  try {
    await writeFile(path, "{");
    await assert.rejects(loadTelegramSettings({ PI_CODING_AGENT_DIR: root }, HOME), /Invalid JSON in Telegram settings file/);
    await writeFile(path, JSON.stringify({ queueCapacity: 20 }));
    await assert.rejects(loadTelegramSettings({ PI_CODING_AGENT_DIR: root }, HOME), /Unknown Telegram setting: queueCapacity/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an inaccessible settings directory produces an actionable read error", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-settings-"));
  const path = join(root, "directory");
  try {
    await mkdir(join(path, "pi-ad-telegram.json"), { recursive: true });
    await assert.rejects(loadTelegramSettings({ PI_CODING_AGENT_DIR: path }, HOME), /Could not read Telegram settings file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
