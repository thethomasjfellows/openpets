import assert from "node:assert/strict";

import {
  maxVoiceWakeVariants,
  isValidVoiceWakePcmFrame,
  maxVoiceWakeFrameSamples,
  normalizeVoiceWakePhrase,
  parseVoiceWakeHelperEvent,
  sanitizeVoiceWakeMessage,
} from "../src/voice-wake-helper-protocol.js";
import { serializeVoiceWakeHelperCommand } from "../src/voice-wake-helper-wire.js";

assert.equal(maxVoiceWakeVariants, 15, "the app and packaged helper accept fifteen active text alternatives");
const fifteenVariants = Array.from({ length: 15 }, (_, index) => `Hey OpenPet ${index + 1}`);
assert.doesNotThrow(() => serializeVoiceWakeHelperCommand({ version: 2, type: "configure", phrase: "Hey OpenPet", variants: fifteenVariants }));
assert.match(
  serializeVoiceWakeHelperCommand({ version: 2, type: "configure", mode: "vad-only", phrase: "Hey Pedra", variants: [] }),
  /"mode":"vad-only"/,
  "official mode can request Silero VAD without enabling Sherpa keyword events",
);
assert.throws(
  () => serializeVoiceWakeHelperCommand({ version: 2, type: "configure", phrase: "Hey OpenPet", variants: [...fifteenVariants, "Hey OpenPet extra"] }),
  /variants are invalid/i,
  "a sixteenth active alternative is rejected at the protocol boundary",
);

assert.equal(normalizeVoiceWakePhrase(`  ${"wake ".repeat(40)}  `).length, 120);
assert.equal(isValidVoiceWakePcmFrame({
  sampleRate: 16_000,
  channels: 1,
  format: "f32",
  samples: new Float32Array(320),
  capturedAt: Date.now(),
}), true);
assert.equal(isValidVoiceWakePcmFrame({
  sampleRate: 16_000,
  channels: 1,
  format: "f32",
  samples: new Float32Array(maxVoiceWakeFrameSamples + 1),
  capturedAt: Date.now(),
}), false);
assert.deepEqual(parseVoiceWakeHelperEvent({ version: 2, type: "keyword", score: 0.91 }), {
  version: 2,
  type: "keyword",
  score: 0.91,
});
assert.deepEqual(parseVoiceWakeHelperEvent({
  version: 2,
  type: "keyword",
  score: 0.91,
  capturedAt: 1_700_000_000_000,
  windowMs: 2_000,
  strideMs: 100,
}), {
  version: 2,
  type: "keyword",
  score: 0.91,
  capturedAt: 1_700_000_000_000,
  windowMs: 2_000,
  strideMs: 100,
});
assert.equal(parseVoiceWakeHelperEvent({ version: 2, type: "keyword", score: 0.91, capturedAt: -1 }), null);
assert.equal(parseVoiceWakeHelperEvent({ version: 1, type: "ready" }), null);
assert.equal(parseVoiceWakeHelperEvent({ version: 2, type: "keyword", score: 4 }), null);
assert.deepEqual(parseVoiceWakeHelperEvent({
  version: 2,
  type: "error",
  code: "phrase-not-supported",
  message: "Choose another phrase.",
}), {
  version: 2,
  type: "error",
  code: "phrase-not-supported",
  message: "Choose another phrase.",
});
assert.equal(parseVoiceWakeHelperEvent({ version: 2, type: "error", code: "unknown", message: "bad" }), null);
assert.equal(sanitizeVoiceWakeMessage("bad\n/path/to/private/model").includes("\n"), false);

console.log("wake helper protocol bounds verified");
