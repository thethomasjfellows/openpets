import assert from "node:assert/strict";

import { createOrdinaryBubbleNarrationCandidate, evaluateBubbleNarrationPresentation } from "../src/bubble-tts.js";

const candidate = createOrdinaryBubbleNarrationCandidate({
  message: "  Hello   there  ",
  paused: false,
});
assert.deepEqual(candidate, { text: "Hello there", key: "Hello there" });

const disabled = evaluateBubbleNarrationPresentation({ candidate, lastKey: null, enabled: false, quietHours: false });
assert.equal(disabled.shouldSpeak, false);
assert.equal(disabled.nextKey, "Hello there");

const enabled = evaluateBubbleNarrationPresentation({ candidate, lastKey: null, enabled: true, quietHours: false });
assert.equal(enabled.shouldSpeak, true);
assert.equal(enabled.text, "Hello there");

const quiet = evaluateBubbleNarrationPresentation({ candidate, lastKey: null, enabled: true, quietHours: true });
assert.equal(quiet.shouldSpeak, false);
assert.equal(quiet.nextKey, "Hello there");

const duplicate = evaluateBubbleNarrationPresentation({ candidate, lastKey: enabled.nextKey, enabled: true, quietHours: false });
assert.equal(duplicate.shouldSpeak, false);

const cleared = evaluateBubbleNarrationPresentation({ candidate: null, lastKey: enabled.nextKey, enabled: true, quietHours: false });
assert.deepEqual(cleared, { nextKey: null, shouldSpeak: false });
const repeatedAfterClear = evaluateBubbleNarrationPresentation({ candidate, lastKey: cleared.nextKey, enabled: true, quietHours: false });
assert.equal(repeatedAfterClear.shouldSpeak, true);

assert.equal(createOrdinaryBubbleNarrationCandidate({ message: "Hello", paused: true }), null);
assert.equal(createOrdinaryBubbleNarrationCandidate({ message: "   ", paused: false }), null);
assert.deepEqual(
  createOrdinaryBubbleNarrationCandidate({ message: "Hidden ordinary text", pluginMessage: "Plugin answer", paused: false }),
  { text: "Plugin answer", key: "Plugin answer" },
);
assert.deepEqual(
  createOrdinaryBubbleNarrationCandidate({ reactionMessage: "All done", reaction: "success", paused: false }),
  { text: "All done", key: "All done" },
);
assert.equal(
  createOrdinaryBubbleNarrationCandidate({ reactionMessage: "Moving along", reaction: "working", paused: false }),
  null,
  "intermediate task reactions stay visible without repeatedly speaking progress filler",
);
assert.deepEqual(
  createOrdinaryBubbleNarrationCandidate({ reactionMessage: "Task failed", reaction: "error", paused: false }),
  { text: "Task failed", key: "Task failed" },
  "terminal task reactions remain audible",
);

console.error("Bubble narration validation passed.");
