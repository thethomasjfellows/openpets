import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultVoiceSettings, getVoiceSettings, initializeVoiceSettings, normalizeVoiceSettings, updateVoiceSettings } from "../src/voice-settings.js";

const malformed = normalizeVoiceSettings({
  output: { providerId: "unknown", overlapPolicy: "forever", providerFallback: "mystery" },
  providers: { pockettts: { baseUrl: "javascript:alert(1)", voiceId: 42 }, system: { rate: 99 } },
  petOverrides: { "safe.pet": { providerId: "pockettts", voiceId: " alba " }, "../../unsafe": { providerId: "system" } },
  conversation: { target: "codex", allowStatelessFallback: true },
  wake: { enabled: true, phrase: "x".repeat(400) },
});

assert.equal(malformed.output.providerId, "system");
assert.equal(malformed.output.overlapPolicy, "interrupt");
assert.equal(malformed.providers.pockettts.baseUrl, defaultVoiceSettings.providers.pockettts.baseUrl);
assert.equal(malformed.providers.system.rate, 2);
assert.equal(malformed.version, 4);
assert.equal("petOverrides" in malformed, false, "voice selection is global rather than per pet");
assert.equal("conversation" in malformed, false, "AI Brain settings do not live in voice settings");
assert.equal("listening" in malformed, false, "legacy push-to-talk settings are removed");
assert.equal(malformed.wake.phrase.length, 120);
assert.equal("enabled" in malformed.wake, false, "legacy wake enablement is not a Voice setting");
assert.deepEqual(
  normalizeVoiceSettings({}).wake,
  { engine: "official-livekit", phraseId: "openpets.hey-pedra.v1", phrase: "Hey Pedra", sensitivity: "easy" },
  "new users get the fixed, locally classified official phrase without enabling listening",
);
assert.equal(
  normalizeVoiceSettings({ version: 3, wake: { phrase: "Hey OpenPet" } }).wake.engine,
  "official-livekit",
  "the former default migrates to the official classifier",
);
assert.deepEqual(normalizeVoiceSettings({ wake: { phrase: "Hey Pedro", calibration: {
  phrase: "Hey Pedro",
  variants: ["My private bank account number is seven", "Hey pay drill."],
  updatedAt: 123,
} } }).wake.calibration?.variants, ["Hey pay drill"], "persisted calibration variants are treated as untrusted input");
assert.equal(normalizeVoiceSettings({ wake: { phrase: "Hey Pedro" } }).wake.engine, "custom-sherpa", "a non-official phrase remains an explicit custom mode");
assert.deepEqual(
  normalizeVoiceSettings({ wake: { phrase: "Hey Pedro", microphone: { deviceId: "  built-in-mic  " } } }).wake.microphone,
  { deviceId: "built-in-mic" },
  "a chosen wake microphone is normalized and persisted",
);
assert.equal(normalizeVoiceSettings({ wake: { microphone: { deviceId: "" } } }).wake.microphone, undefined, "an unavailable selection falls back to system default");

const userData = mkdtempSync(join(tmpdir(), "openpets-voice-settings-"));
initializeVoiceSettings(userData);
updateVoiceSettings({ output: { providerId: "pockettts", voiceId: "alba" }, providers: { pockettts: { baseUrl: "http://127.0.0.1:8000" } }, wake: { enabled: true, phrase: "Hey OpenPet" } });
assert.equal(getVoiceSettings().output.providerId, "pockettts");
assert.equal(getVoiceSettings().providers.pockettts.voiceId, "alba");
const persisted = JSON.parse(readFileSync(join(userData, "openpets-voice-settings.json"), "utf8")) as Record<string, unknown>;
assert.equal("apiKey" in persisted, false);
assert.deepEqual(persisted.wake, {
  engine: "official-livekit",
  phraseId: "openpets.hey-pedra.v1",
  phrase: "Hey Pedra",
  sensitivity: "easy",
});

console.log("voice settings behavior verified");
