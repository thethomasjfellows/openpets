import assert from "node:assert/strict";

import { defaultVoiceSettings, normalizeVoiceSettings, resolveVoiceAttemptPlan, resolveVoiceSelection } from "../src/voice-settings.js";
import { normalizeVoiceSpeechText } from "../src/voice-speech-text.js";

assert.equal(normalizeVoiceSpeechText("It is 10:57."), "It is ten fifty-seven.", "clock times are normalized before TTS without changing the visible answer");
assert.equal(normalizeVoiceSpeechText("Meet at 9:05."), "Meet at nine oh five.");
assert.equal(normalizeVoiceSpeechText("Midnight is 00:00."), "Midnight is twelve o'clock.");

const settings = normalizeVoiceSettings({
  ...defaultVoiceSettings,
  output: { ...defaultVoiceSettings.output, providerId: "pockettts", voiceId: "alba", model: "base", overlapPolicy: "queue" },
});

assert.deepEqual(resolveVoiceSelection(settings, "cat"), {
  providerId: "pockettts",
  voiceId: "alba",
  model: "base",
  overlapPolicy: "queue",
  providerFallback: "system",
  voiceFallback: "provider-default",
});
assert.equal(resolveVoiceSelection(settings, "dog").providerId, "pockettts");
assert.equal(resolveVoiceSelection(settings, "dog").voiceId, "alba");
assert.equal(resolveVoiceSelection(settings, "unknown").overlapPolicy, "queue");

const catSelection = resolveVoiceSelection(settings, "cat");
assert.deepEqual(resolveVoiceAttemptPlan(catSelection, "alba", false), [
  { providerId: "pockettts", useProviderDefault: false },
], "provider tests must not hide a failure behind voice or System Voice fallback");
assert.equal(resolveVoiceAttemptPlan(resolveVoiceSelection(settings, "dog"), "alba", true).at(-1)?.providerId, "system");

console.log("voice output selection behavior verified");
