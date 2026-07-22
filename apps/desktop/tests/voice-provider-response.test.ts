import assert from "node:assert/strict";

import { maxVoiceAudioBytes, readBoundedAudioResponse, sanitizeProviderError } from "../src/voice-provider.js";

const audio = await readBoundedAudioResponse(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }));
assert.equal(audio.mimeType, "audio/mpeg");
assert.deepEqual([...audio.bytes], [1, 2, 3]);

const streamingWav = new Uint8Array(48);
streamingWav.set(new TextEncoder().encode("RIFF"), 0);
new DataView(streamingWav.buffer).setUint32(4, 2_000_000_036, true);
streamingWav.set(new TextEncoder().encode("WAVEfmt "), 8);
new DataView(streamingWav.buffer).setUint32(16, 16, true);
streamingWav.set(new TextEncoder().encode("data"), 36);
new DataView(streamingWav.buffer).setUint32(40, 2_000_000_000, true);
const finalizedWav = await readBoundedAudioResponse(new Response(streamingWav, { headers: { "content-type": "audio/wav" } }));
const finalizedView = new DataView(finalizedWav.bytes.buffer, finalizedWav.bytes.byteOffset, finalizedWav.bytes.byteLength);
assert.equal(finalizedView.getUint32(4, true), 40, "RIFF length reflects the buffered response");
assert.equal(finalizedView.getUint32(40, true), 4, "streaming data sentinel is replaced by the actual PCM length");

await assert.rejects(
  () => readBoundedAudioResponse(new Response("not audio", { headers: { "content-type": "text/plain" } })),
  /non-audio/,
);
await assert.rejects(
  () => readBoundedAudioResponse(new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg", "content-length": String(maxVoiceAudioBytes + 1) } })),
  /too large/,
);

const sanitized = sanitizeProviderError(new Error("failed https://voice.example.test/path secret_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"));
assert.equal(sanitized.includes("voice.example.test"), false);
assert.equal(sanitized.includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ"), false);

console.log("bounded provider response behavior verified");
