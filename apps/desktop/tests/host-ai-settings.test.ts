import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultHostAiSettings,
  getHostAiSettings,
  initializeHostAiSettings,
  normalizeHostAiSettings,
  setActiveHostAiProvider,
  updateHostAiProviderConfig,
} from "../src/host-ai-settings.js";
import {
  getPluginPlatformSettings,
  initializePluginPlatformSettings,
} from "../src/plugin-platform-settings.js";

assert.deepEqual(normalizeHostAiSettings(null), defaultHostAiSettings);
assert.deepEqual(normalizeHostAiSettings({ provider: "invalid", model: "ignored" }), defaultHostAiSettings);
assert.deepEqual(normalizeHostAiSettings({ provider: "none", model: "ignored", baseUrl: "https://ignored.test" }), defaultHostAiSettings);
const normalized = normalizeHostAiSettings({
  provider: "openai",
  model: `  ${"m".repeat(140)}  `,
  baseUrl: "  https://ai.example.test/v1/  ",
});
assert.equal(normalized.provider, "custom", "a legacy OpenAI-compatible custom URL migrates to the explicit Custom card");
assert.equal(normalized.providers.custom.model.length, 120);
assert.equal(normalized.providers.custom.model.startsWith("m"), true);
assert.equal(normalized.providers.custom.baseUrl, "https://ai.example.test/v1");
assert.equal(normalizeHostAiSettings({ provider: "ollama", baseUrl: "javascript:alert(1)" }).providers.ollama.baseUrl, "http://127.0.0.1:11434/v1");

const migratedUserData = mkdtempSync(join(tmpdir(), "openpets-host-ai-migrate-"));
const legacyPath = join(migratedUserData, "openpets-plugin-platform.json");
writeFileSync(legacyPath, JSON.stringify({
  allowPluginAudio: false,
  allowDynamicSpeech: true,
  allowPluginVoice: false,
  allowMicrophone: true,
  quietHours: { enabled: true, start: "21:30", end: "07:15" },
  ai: { provider: "openai", model: "legacy-model", baseUrl: "https://legacy.example.test/v1" },
}));

const migrated = initializePluginPlatformSettings(migratedUserData);
assert.equal(migrated.ai.provider, "custom");
assert.equal(migrated.ai.providers.custom.model, "legacy-model");
assert.equal(migrated.allowPluginAudio, false);
assert.equal(migrated.quietHours.start, "21:30");
const hostFile = JSON.parse(readFileSync(join(migratedUserData, "openpets-host-ai-settings.json"), "utf8")) as Record<string, unknown>;
assert.equal(hostFile.provider, "custom");
assert.equal(hostFile.version, 2);
const migratedPluginFile = JSON.parse(readFileSync(legacyPath, "utf8")) as Record<string, unknown>;
assert.equal("ai" in migratedPluginFile, false);
assert.equal(migratedPluginFile.allowPluginAudio, false);

updateHostAiProviderConfig("ollama", { model: "qwen2.5", baseUrl: "http://127.0.0.1:11434/v1" });
const savedCustom = getHostAiSettings().providers.custom;
const updated = setActiveHostAiProvider("ollama");
assert.equal(updated.provider, "ollama");
assert.equal(getPluginPlatformSettings().ai.providers.ollama.model, "qwen2.5");
assert.deepEqual(getHostAiSettings().providers.custom, savedCustom, "selecting another brain cannot erase an inactive provider card");
const updatedPluginFile = JSON.parse(readFileSync(legacyPath, "utf8")) as Record<string, unknown>;
assert.equal("ai" in updatedPluginFile, false);
const updatedHostFile = JSON.parse(readFileSync(join(migratedUserData, "openpets-host-ai-settings.json"), "utf8")) as Record<string, unknown>;
assert.equal(updatedHostFile.provider, "ollama");
assert.throws(() => setActiveHostAiProvider("unknown"), /Unknown AI provider/);
assert.throws(() => updateHostAiProviderConfig("custom", { baseUrl: "javascript:alert(1)" }), /valid HTTP or HTTPS provider URL/);
assert.throws(() => updateHostAiProviderConfig("openai", { unexpected: true } as never), /Invalid AI provider setting/);
assert.throws(() => updateHostAiProviderConfig("openrouter", { baseUrl: "https://proxy.example.test/v1" } as never), /Invalid AI provider setting/);

initializeHostAiSettings(migratedUserData);
assert.equal(getHostAiSettings().provider, "ollama");

const legacyCodexBridgeUserData = mkdtempSync(join(tmpdir(), "openpets-host-ai-codex-bridge-"));
writeFileSync(join(legacyCodexBridgeUserData, "openpets-host-ai-settings.json"), JSON.stringify({
  provider: "ollama",
  model: "gpt-5.5",
  baseUrl: "http://127.0.0.1:18081/v1",
}));
assert.deepEqual(initializeHostAiSettings(legacyCodexBridgeUserData), defaultHostAiSettings, "the retired local Codex bridge must not survive as a broken Direct API provider");
assert.deepEqual(JSON.parse(readFileSync(join(legacyCodexBridgeUserData, "openpets-host-ai-settings.json"), "utf8")), defaultHostAiSettings);

const legitimateOllamaUserData = mkdtempSync(join(tmpdir(), "openpets-host-ai-ollama-"));
writeFileSync(join(legitimateOllamaUserData, "openpets-host-ai-settings.json"), JSON.stringify({
  provider: "ollama",
  model: "qwen2.5",
  baseUrl: "http://127.0.0.1:11434/v1",
}));
assert.equal(initializeHostAiSettings(legitimateOllamaUserData).provider, "ollama", "legitimate local Ollama settings remain intact");

const explicitDisabledUserData = mkdtempSync(join(tmpdir(), "openpets-host-ai-disabled-"));
writeFileSync(join(explicitDisabledUserData, "openpets-host-ai-settings.json"), JSON.stringify({ provider: "none", model: "" }));
writeFileSync(join(explicitDisabledUserData, "openpets-plugin-platform.json"), JSON.stringify({
  allowPluginAudio: false,
  ai: { provider: "anthropic", model: "stale-legacy-model" },
}));
const explicitlyDisabled = initializePluginPlatformSettings(explicitDisabledUserData);
assert.equal(explicitlyDisabled.ai.provider, "none");
assert.equal(explicitlyDisabled.allowPluginAudio, false);

console.log("host AI settings and forward migration behavior verified");
