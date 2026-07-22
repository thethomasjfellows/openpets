import assert from "node:assert/strict";

import { encodePcm16Wav } from "../src/voice-audio.js";

const samples = new Float32Array(160);
samples[0] = -2;
samples[1] = 0.5;
samples[2] = 2;
samples[3] = Number.NaN;

const capture = encodePcm16Wav(samples);
assert.equal(capture.mimeType, "audio/wav");
assert.equal(capture.durationMs, 10);
assert.equal(capture.bytes.byteLength, 44 + samples.length * 2);
assert.equal(new TextDecoder().decode(capture.bytes.subarray(0, 4)), "RIFF");
assert.equal(new TextDecoder().decode(capture.bytes.subarray(8, 12)), "WAVE");

const view = new DataView(capture.bytes.buffer, capture.bytes.byteOffset, capture.bytes.byteLength);
assert.equal(view.getUint16(20, true), 1, "WAV uses integer PCM");
assert.equal(view.getUint16(22, true), 1, "WAV is mono");
assert.equal(view.getUint32(24, true), 16_000);
assert.equal(view.getUint16(34, true), 16);
assert.equal(view.getInt16(44, true), -32_768, "negative samples are clamped");
assert.equal(view.getInt16(46, true), 16_384);
assert.equal(view.getInt16(48, true), 32_767, "positive samples are clamped");
assert.equal(view.getInt16(50, true), 0, "non-finite samples become silence");
assert.throws(() => encodePcm16Wav(new Float32Array()), /empty/i);
assert.throws(() => encodePcm16Wav(new Float32Array(16_000 * 30 + 1)), /30 second/i);
assert.throws(
  () => encodePcm16Wav(new Float32Array(8_000 * 30 + 1), 8_000),
  /30 second/i,
  "the duration limit follows the declared sample rate",
);

console.log("wake PCM WAV encoding verified");
