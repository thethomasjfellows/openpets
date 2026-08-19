import assert from "node:assert/strict";

import { VoiceWakeWordService } from "../src/voice-wake-word-service.js";
import type { VoiceOutputActivitySnapshot } from "../src/voice-output-service.js";
import type { VoicePcmFrame } from "../src/voice-wake-types.js";

let frameListener: ((frame: VoicePcmFrame) => void) | undefined;
let outputListener: ((snapshot: VoiceOutputActivitySnapshot) => void) | undefined;
let outputSnapshot: VoiceOutputActivitySnapshot = {
  active: true,
  activePetIds: ["pedra"],
  activeReasons: ["conversation"],
};

const service = new VoiceWakeWordService({
  runtime: {
    health: () => ({ ready: true, method: "livekit-wakeword" }),
    start: async () => ({
      sendFrame() {},
      reset() {},
      async stop() {},
      onEvent: () => () => undefined,
    }),
    dispose() {},
  },
  capture: {
    startWakePcmStream: async () => ({
      owner: "wake",
      startedAt: 1,
      onFrame(listener) { frameListener = listener; return () => { frameListener = undefined; }; },
      async stop() {},
    }),
  },
  transcription: { async transcribe() { return "unused"; } },
  companion: { async sendUserTurn() { return {}; }, cancel() {} },
  output: {
    getActivitySnapshot: () => outputSnapshot,
    onActivityChanged(listener) { outputListener = listener; return () => { outputListener = undefined; }; },
  },
  getCompanionSettings: () => ({ enabled: true, wake: { enabled: true, followUpEnabled: true } }),
  getVoiceSettings: () => ({ wake: { phrase: "Hey Pedra", sensitivity: "easy" } }),
  getDefaultPetId: () => "pedra",
  followUpTimeoutMs: 30,
});

try {
  await service.start();
  assert.equal(service.snapshot().turnState, "speaking");

  outputSnapshot = { active: false, activePetIds: [], activeReasons: [] };
  outputListener?.(outputSnapshot);
  assert.equal(service.snapshot().turnState, "follow-up");

  frameListener?.({
    sampleRate: 16_000,
    channels: 1,
    format: "f32",
    capturedAt: 2,
    samples: new Float32Array(320).fill(0.05),
  });
  assert.equal(service.snapshot().turnState, "collecting", "speech energy starts the second turn even if runtime VAD misses speech-start");

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(service.snapshot().turnState, "collecting", "the no-speech follow-up timer cannot cut off an accepted utterance");

  console.log("Follow-up listening no-speech timer regression verified");
} finally {
  await service.dispose();
}
