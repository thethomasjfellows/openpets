import assert from "node:assert/strict";

import { buildVoiceCaption } from "../src/voice-caption-timing.js";

const caption = buildVoiceCaption("  Hello there, Pedra!  ");
assert.equal(caption.text, "Hello there, Pedra!");
assert.deepEqual(caption.segments.map((segment) => segment.endIndex), [6, 13, 19]);
assert.ok(caption.segments[1].weight > caption.segments[0].weight, "a comma creates a visible conversational pause");
assert.ok(caption.segments[2].weight > caption.segments[1].weight, "sentence-ending punctuation receives the longest pause");
assert.equal(caption.totalWeight, caption.segments.reduce((sum, segment) => sum + segment.weight, 0));

const bounded = buildVoiceCaption(`word ${"x".repeat(5_000)}`);
assert.equal(bounded.text.length, 4_000, "renderer caption payloads remain bounded to the spoken-text limit");
assert.ok(bounded.segments.every((segment) => segment.endIndex <= bounded.text.length));

console.log("progressive voice caption timing verified");
