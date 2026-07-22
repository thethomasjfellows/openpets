import assert from "node:assert/strict";

import { VoiceWakeActivation } from "../src/voice-wake-activation.js";
import type { VoicePcmFrame } from "../src/voice-wake-types.js";

function frame(samples: number, capturedAt = 0, value = 0.25): VoicePcmFrame {
  return {
    sampleRate: 16_000,
    channels: 1,
    format: "f32",
    samples: new Float32Array(samples).fill(value),
    capturedAt,
  };
}

// Contract: idle audio is never included in provider transcription; only
// frames received after the keyword and before a valid endpoint are finalized.
const activation = new VoiceWakeActivation({ minimumSpeechMs: 250, cooldownMs: 500 });
activation.ingest(frame(16_000, 0, 0.25));
assert.equal(activation.consumeFinalized(), null);
assert.equal(activation.keywordDetected(1_000), true);
activation.vad("speech-start");
activation.ingest(frame(4_800, 1_000, 0.5));
activation.vad("speech-end");
const utterance = activation.consumeFinalized();
assert.ok(utterance);
assert.equal(utterance.samples.length, 4_800, "pre-keyword audio must not enter transcription");
assert.equal(utterance.durationMs, 300);
assert.equal(utterance.samples.every((sample) => sample === 0.5), true);

const noSpeech = new VoiceWakeActivation({ minimumSpeechMs: 250 });
noSpeech.ingest(frame(8_000));
assert.equal(noSpeech.keywordDetected(), true);
noSpeech.ingest(frame(8_000, 0, 0));
noSpeech.vad("speech-end");
assert.equal(noSpeech.consumeFinalized(), null, "post-keyword silence cannot satisfy the speech minimum");
assert.equal(noSpeech.turnState, "idle");

const separateCommand = new VoiceWakeActivation({ minimumSpeechMs: 250 });
assert.equal(separateCommand.keywordDetected(1_000, { requireNextUtterance: true }), true);
separateCommand.ingest(frame(4_800, 1_000, 0.75));
separateCommand.vad("speech-end");
assert.equal(separateCommand.consumeFinalized(), null, "the wake phrase tail must not become command audio");
assert.equal(separateCommand.turnState, "activated");
separateCommand.vad("speech-start");
separateCommand.ingest(frame(4_800, 1_400, 0.25));
separateCommand.vad("speech-end");
const separateUtterance = separateCommand.consumeFinalized();
assert.ok(separateUtterance);
assert.equal(separateUtterance.samples.length, 4_800);
assert.equal(separateUtterance.samples.every((sample) => sample === 0.25), true, "only the separate command is finalized");

const suppression = new VoiceWakeActivation({ cooldownMs: 500 });
suppression.outputStarted();
assert.equal(suppression.keywordDetected(1_000), false);
suppression.outputEnded(1_000);
assert.equal(suppression.keywordDetected(1_200), false);
suppression.tick(1_500);
assert.equal(suppression.keywordDetected(1_500), true);
suppression.cancel();
assert.equal(suppression.consumeFinalized(), null);

// Contract: a completed spoken reply can deliberately arm one bounded follow-up
// utterance without allowing ambient audio from before that moment into it.
const followUp = new VoiceWakeActivation({ minimumSpeechMs: 250 });
followUp.outputStarted();
followUp.beginFollowUp();
assert.equal(followUp.turnState, "activated");
followUp.vad("speech-start");
followUp.ingest(frame(4_800, 2_000, 0.4));
followUp.vad("speech-end");
const followUpUtterance = followUp.consumeFinalized();
assert.ok(followUpUtterance);
assert.equal(followUpUtterance.samples.length, 4_800);

console.log("wake activation policy verified");
