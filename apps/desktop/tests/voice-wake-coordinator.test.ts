import assert from "node:assert/strict";

import type { VoiceFiniteAudioCapture } from "../src/voice-audio.js";
import type { VoiceOutputActivitySnapshot } from "../src/voice-output-service.js";
import type { VoiceWakeHelperEvent } from "../src/voice-wake-helper-protocol.js";
import type {
  VoiceWakeCaptureSource,
  VoiceWakePcmSession,
  VoiceWakeRuntime,
  VoiceWakeRuntimeSession,
} from "../src/voice-wake-runtime.js";
import type { VoicePcmFrame } from "../src/voice-wake-types.js";
import { VoiceWakeWordService } from "../src/voice-wake-word-service.js";

let frameListener: ((frame: VoicePcmFrame) => void) | null = null;
let captureEndedListener: ((reason: string) => void) | null = null;
let runtimeListener: ((event: VoiceWakeHelperEvent) => void) | null = null;
let outputListener: ((snapshot: VoiceOutputActivitySnapshot) => void) | null = null;
let captureStarts = 0;
let captureStops = 0;
let runtimeStarts = 0;
let runtimeStops = 0;
let runtimeResets = 0;
let runtimeFrames = 0;
let runtimeDisposed = false;
const phrases: string[] = [];
const transcriptions: VoiceFiniteAudioCapture[] = [];
const turns: Array<{ petId: string; text: string; kind: "voice"; speak: true }> = [];
const cancellations: string[] = [];
let releaseCompanionTurn: (() => void) | null = null;
let completedCompanionTurns = 0;
let outputActivity: VoiceOutputActivitySnapshot = { active: false, activePetIds: [], activeReasons: [] };
let privacyStarts = 0;
let privacyStops = 0;
let acknowledgementStarts = 0;
let acknowledgementThinking = 0;
let acknowledgementStops = 0;
let presentationAcquires = 0;
let presentationReleases = 0;

const capture: VoiceWakeCaptureSource = {
  async startWakePcmStream(): Promise<VoiceWakePcmSession> {
    captureStarts += 1;
    return {
      owner: "wake",
      startedAt: 1_000,
      onFrame(listener) {
        frameListener = listener;
        return () => { if (frameListener === listener) frameListener = null; };
      },
      onEnded(listener) {
        captureEndedListener = listener;
        return () => { if (captureEndedListener === listener) captureEndedListener = null; };
      },
      async stop() {
        captureStops += 1;
      },
    };
  },
};

const runtimeSession: VoiceWakeRuntimeSession = {
  sendFrame() { runtimeFrames += 1; },
  reset() {
    runtimeResets += 1;
  },
  async stop() {
    runtimeStops += 1;
  },
  onEvent(listener) {
    runtimeListener = listener;
    return () => { if (runtimeListener === listener) runtimeListener = null; };
  },
};

const runtime: VoiceWakeRuntime = {
  health: () => ({ ready: true, method: "sherpa-onnx", version: "test", modelId: "test-model" }),
  async start(config) {
    runtimeStarts += 1;
    phrases.push(config.phrase);
    assert.equal(config.signal.aborted, false);
    return runtimeSession;
  },
  dispose() {
    runtimeDisposed = true;
  },
};

const service = new VoiceWakeWordService({
  runtime,
  capture,
  transcription: {
    async transcribe(audio) {
      transcriptions.push(audio);
      return "How is my work going?";
    },
  },
  companion: {
    async sendUserTurn(request) {
      turns.push(request);
      await new Promise<void>((resolve) => { releaseCompanionTurn = resolve; });
      completedCompanionTurns += 1;
      return { text: "You are making steady progress." };
    },
    cancel(petId) {
      cancellations.push(petId);
    },
  },
  output: {
    getActivitySnapshot: () => outputActivity,
    onActivityChanged(listener) {
      outputListener = listener;
      return () => { if (outputListener === listener) outputListener = null; };
    },
  },
  privacyIndicator: {
    trackStarted() { privacyStarts += 1; },
    trackStopped() { privacyStops += 1; },
  },
  acknowledgement: {
    showListening() { acknowledgementStarts += 1; },
    showThinking() { acknowledgementThinking += 1; },
    clearListening() { acknowledgementStops += 1; },
  },
  presentation: {
    acquire() {
      presentationAcquires += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        presentationReleases += 1;
      };
    },
  },
  presentationHoldMs: 5,
  activationTimeoutMs: 25,
  getCompanionSettings: () => ({ enabled: true, wake: { enabled: true } }),
  getVoiceSettings: () => ({ wake: { engine: "custom-sherpa", phrase: "  Hey OpenPet  " } }),
  getDefaultPetId: () => "default-pet",
  now: () => 1_000,
});

const started = await service.start();
assert.equal(started.armed, true);
assert.equal(started.captureState, "armed");
assert.deepEqual(phrases, ["Hey OpenPet"]);
assert.equal(captureStarts, 1);
assert.equal(runtimeStarts, 1);
assert.equal(privacyStarts, 0, "ambient wake listening does not show the bounded-request overlay");
assert.equal(privacyStops, 0);

emitRuntime({ version: 2, type: "vad", state: "speech-start", score: 0.8 });
emitRuntime({ version: 2, type: "keyword", score: 0.9 });
assert.equal(privacyStarts, 1, "the overlay starts only after a local wake hit");
assert.equal(acknowledgementStarts, 1, "the pet immediately shows that it is listening");
assert.equal(presentationAcquires, 1, "the voice turn owns the pet presentation before background reactions can race it");
assert.equal(presentationReleases, 0);
emitRuntime({ version: 2, type: "vad", state: "speech-end", score: 0.8 });
assert.equal(service.snapshot().turnState, "activated", "the wake phrase endpoint arms a separate command utterance");
assert.equal(runtimeResets, 0);
assert.equal(transcriptions.length, 0);
assert.equal(privacyStops, 0);
emitRuntime({ version: 2, type: "vad", state: "speech-start", score: 0.8 });
emitFrame(4_800);
await new Promise((resolve) => setTimeout(resolve, 40));
assert.equal(service.snapshot().turnState, "collecting", "the start-speaking guard cannot discard a command after speech begins");
emitRuntime({ version: 2, type: "vad", state: "speech-end", score: 0.8 });
assert.equal(privacyStops, 1, "the overlay ends when bounded command audio is finalized");
assert.equal(acknowledgementThinking, 1, "the listening bubble becomes a working acknowledgement during transcription and AI latency");
assert.equal(acknowledgementStops, 0, "the acknowledgement remains active until the answer begins");
await waitFor(() => turns.length === 1);

assert.equal(transcriptions.length, 1);
assert.equal(transcriptions[0]?.mimeType, "audio/wav");
assert.equal(transcriptions[0]?.durationMs, 300, "pre-keyword PCM must not be sent to transcription");
assert.equal(new TextDecoder().decode(transcriptions[0]?.bytes.subarray(0, 4)), "RIFF");
assert.deepEqual(turns, [{ petId: "default-pet", text: "How is my work going?", kind: "voice", speak: true }]);

outputActivity = { active: true, activePetIds: ["default-pet"], activeReasons: ["conversation"] };
emitOutput(outputActivity);
assert.equal(service.snapshot().turnState, "speaking");
assert.equal(acknowledgementStops, 1, "the final spoken answer replaces the working acknowledgement");
releaseTurn();
await waitFor(() => completedCompanionTurns === 1);
assert.equal(service.snapshot().turnState, "speaking", "AI completion does not start cooldown while pet speech remains active");
const framesBeforePetSpeech = runtimeFrames;
emitFrame(4_800);
assert.equal(runtimeFrames, framesBeforePetSpeech, "the pet's own speech must not be fed back into wake detection");
emitRuntime({ version: 2, type: "keyword", score: 0.99 });
assert.equal(service.snapshot().turnState, "speaking", "pet speech suppresses wake activation");

outputActivity = { active: false, activePetIds: [], activeReasons: [] };
emitOutput(outputActivity);
assert.equal(service.snapshot().turnState, "cooldown");
assert.equal(presentationReleases, 0, "the completed answer remains protected briefly after spoken output ends");
await waitFor(() => presentationReleases === 1);
emitRuntime({ version: 2, type: "keyword", score: 0.99 });
assert.equal(service.snapshot().turnState, "cooldown", "a second wake phrase is ignored during cooldown");
assert.equal(turns.length, 1);

await service.handlePowerEvent("lock");
await service.handlePowerEvent("suspend");
assert.equal(service.snapshot().captureState, "suspended");
assert.equal(captureStops, 1);
assert.equal(runtimeStops, 1);

await service.handlePowerEvent("resume");
assert.equal(service.snapshot().captureState, "suspended", "resume cannot re-arm wake while the screen remains locked");
assert.equal(captureStarts, 1);
assert.equal(runtimeStarts, 1);
await service.handlePowerEvent("unlock");
assert.equal(service.snapshot().armed, true);
assert.equal(captureStarts, 2);
assert.equal(runtimeStarts, 2);

emitCaptureEnded("renderer-crashed");
await waitFor(() => service.snapshot().captureState === "error");
assert.equal(service.snapshot().armed, false);
assert.match(service.snapshot().reason ?? "", /renderer-crashed/i);

await service.dispose();
assert.equal(captureStops, 2);
assert.equal(runtimeStops, 2);
assert.equal(runtimeDisposed, true);
assert.deepEqual(cancellations, ["default-pet"]);


const idleOutput = {
  getActivitySnapshot: (): VoiceOutputActivitySnapshot => ({ active: false, activePetIds: [], activeReasons: [] }),
  onActivityChanged: () => () => undefined,
};

const noOutputService = new VoiceWakeWordService({
  runtime,
  capture,
  transcription: { async transcribe() { return "unused"; } },
  companion: {
    async sendUserTurn() { return {}; },
    cancel() {},
  },
  getCompanionSettings: () => ({ enabled: true, wake: { enabled: true } }),
  getVoiceSettings: () => ({ wake: { engine: "custom-sherpa", phrase: "Hey OpenPet" } }),
  getDefaultPetId: () => "default-pet",
});
assert.equal(noOutputService.health().ready, false, "wake is unavailable without pet-output suppression");
await assert.rejects(noOutputService.start(), /not available/i);
await noOutputService.dispose();

let resolveDelayedCapture: ((session: VoiceWakePcmSession) => void) | null = null;
let staleCaptureStops = 0;
const delayedCapture: VoiceWakeCaptureSource = {
  startWakePcmStream() {
    return new Promise<VoiceWakePcmSession>((resolve) => { resolveDelayedCapture = resolve; });
  },
};
const staleStartService = new VoiceWakeWordService({
  runtime,
  capture: delayedCapture,
  transcription: { async transcribe() { return "unused"; } },
  companion: {
    async sendUserTurn() { return {}; },
    cancel() {},
  },
  output: idleOutput,
  getCompanionSettings: () => ({ enabled: true, wake: { enabled: true } }),
  getVoiceSettings: () => ({ wake: { engine: "custom-sherpa", phrase: "Hey OpenPet" } }),
  getDefaultPetId: () => "default-pet",
});
const staleStart = staleStartService.start();
const releaseDelayedCapture = resolveDelayedCapture as ((session: VoiceWakePcmSession) => void) | null;
assert.ok(releaseDelayedCapture);
await staleStartService.stop();
releaseDelayedCapture({
  owner: "wake",
  startedAt: 1_000,
  onFrame: () => () => undefined,
  async stop() { staleCaptureStops += 1; },
});
await assert.rejects(staleStart, (error: unknown) => error instanceof Error && error.name === "AbortError");
assert.equal(staleCaptureStops, 1);
assert.equal(staleStartService.snapshot().captureState, "disabled", "a stale start cannot overwrite stopped state");
await staleStartService.dispose();


let overlappingCaptureStarts = 0;
const overlappingCapture: VoiceWakeCaptureSource = {
  startWakePcmStream(options) {
    overlappingCaptureStarts += 1;
    return new Promise<VoiceWakePcmSession>((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("overlapping capture aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
  },
};
const overlappingStartService = new VoiceWakeWordService({
  runtime,
  capture: overlappingCapture,
  transcription: { async transcribe() { return "unused"; } },
  companion: {
    async sendUserTurn() { return {}; },
    cancel() {},
  },
  output: idleOutput,
  getCompanionSettings: () => ({ enabled: true, wake: { enabled: true } }),
  getVoiceSettings: () => ({ wake: { engine: "custom-sherpa", phrase: "Hey OpenPet" } }),
  getDefaultPetId: () => "default-pet",
});
const firstOverlappingStart = overlappingStartService.start();
const secondOverlappingStart = overlappingStartService.start();
assert.equal(secondOverlappingStart, firstOverlappingStart, "overlapping wake starts share one acquisition");
assert.equal(overlappingCaptureStarts, 1);
const overlappingStartRejection = assert.rejects(
  firstOverlappingStart,
  (error: unknown) => error instanceof Error && error.name === "AbortError",
);
await overlappingStartService.stop();
await overlappingStartRejection;
assert.equal(overlappingStartService.snapshot().captureState, "disabled");
await overlappingStartService.dispose();

let lateFrameListener: ((frame: VoicePcmFrame) => void) | null = null;
let lateRuntimeListener: ((event: VoiceWakeHelperEvent) => void) | null = null;
let rejectLateTranscription: ((error: Error) => void) | null = null;
const lateFailureService = new VoiceWakeWordService({
  runtime: {
    health: () => ({ ready: true, method: "sherpa-onnx", version: "test", modelId: "test-model" }),
    async start() {
      return {
        sendFrame() {},
        reset() {},
        async stop() {},
        onEvent(listener) {
          lateRuntimeListener = listener;
          return () => { if (lateRuntimeListener === listener) lateRuntimeListener = null; };
        },
      };
    },
    dispose() {},
  },
  capture: {
    async startWakePcmStream() {
      return {
        owner: "wake",
        startedAt: 1_000,
        onFrame(listener) {
          lateFrameListener = listener;
          return () => { if (lateFrameListener === listener) lateFrameListener = null; };
        },
        async stop() {},
      };
    },
  },
  transcription: {
    transcribe() {
      return new Promise<string>((_resolve, reject) => { rejectLateTranscription = reject; });
    },
  },
  companion: {
    async sendUserTurn() { throw new Error("stale transcription must not reach Companion"); },
    cancel() {},
  },
  output: idleOutput,
  getCompanionSettings: () => ({ enabled: true, wake: { enabled: true } }),
  getVoiceSettings: () => ({ wake: { engine: "custom-sherpa", phrase: "Hey OpenPet" } }),
  getDefaultPetId: () => "default-pet",
});
await lateFailureService.start();
const lateFrame = lateFrameListener as ((frame: VoicePcmFrame) => void) | null;
const lateEvent = lateRuntimeListener as ((event: VoiceWakeHelperEvent) => void) | null;
assert.ok(lateFrame);
assert.ok(lateEvent);
lateFrame({
  sampleRate: 16_000,
  channels: 1,
  format: "f32",
  samples: new Float32Array(8_000).fill(0.25),
  capturedAt: 1_000,
});
lateEvent({ version: 2, type: "keyword", score: 0.9 });
lateEvent({ version: 2, type: "vad", state: "speech-start", score: 0.8 });
lateFrame({
  sampleRate: 16_000,
  channels: 1,
  format: "f32",
  samples: new Float32Array(4_800).fill(0.25),
  capturedAt: 1_000,
});
lateEvent({ version: 2, type: "vad", state: "speech-end", score: 0.8 });
const rejectLate = rejectLateTranscription as ((error: Error) => void) | null;
assert.ok(rejectLate);
await lateFailureService.handlePowerEvent("suspend");
rejectLate(new Error("late transcription failure"));
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(lateFailureService.snapshot().captureState, "suspended");
assert.equal(lateFailureService.snapshot().turnState, "idle", "late async failure cannot enter cooldown after suspend");
assert.doesNotMatch(lateFailureService.snapshot().reason ?? "", /late transcription failure/i);
await lateFailureService.dispose();


let resetFailureListener: ((event: VoiceWakeHelperEvent) => void) | null = null;
const resetFailureService = new VoiceWakeWordService({
  runtime: {
    health: () => ({ ready: true, method: "sherpa-onnx", version: "test", modelId: "test-model" }),
    async start() {
      return {
        sendFrame() {},
        reset() { throw new Error("reset failed at /Users/example/private-model.onnx sk-secretvalue123"); },
        async stop() {},
        onEvent(listener) {
          resetFailureListener = listener;
          return () => { if (resetFailureListener === listener) resetFailureListener = null; };
        },
      };
    },
    dispose() {},
  },
  capture: {
    async startWakePcmStream() {
      return {
        owner: "wake",
        startedAt: 1_000,
        onFrame: () => () => undefined,
        async stop() {},
      };
    },
  },
  transcription: { async transcribe() { return "unused"; } },
  companion: { async sendUserTurn() { return {}; }, cancel() {} },
  output: idleOutput,
  getCompanionSettings: () => ({ enabled: true, wake: { enabled: true } }),
  getVoiceSettings: () => ({ wake: { engine: "custom-sherpa", phrase: "Hey OpenPet" } }),
  getDefaultPetId: () => "default-pet",
});
await resetFailureService.start();
const emitResetFailure = resetFailureListener as ((event: VoiceWakeHelperEvent) => void) | null;
assert.ok(emitResetFailure);
emitResetFailure({ version: 2, type: "keyword", score: 0.9 });
emitResetFailure({ version: 2, type: "vad", state: "speech-end", score: 0.8 });
await waitFor(() => resetFailureService.snapshot().captureState === "error");
assert.match(resetFailureService.snapshot().reason ?? "", /reset failed/i);
assert.doesNotMatch(resetFailureService.snapshot().reason ?? "", /\/Users\/example|sk-secretvalue123/i);
await resetFailureService.dispose();


let racingFailureListener: ((event: VoiceWakeHelperEvent) => void) | null = null;
let racingRuntimeStopStarted = false;
let releaseRacingRuntimeStop: (() => void) | null = null;
const racingFailureService = new VoiceWakeWordService({
  runtime: {
    health: () => ({ ready: true, method: "sherpa-onnx", version: "test", modelId: "test-model" }),
    async start() {
      return {
        sendFrame() {},
        reset() { throw new Error("racing reset failure"); },
        stop() {
          racingRuntimeStopStarted = true;
          return new Promise<void>((resolve) => { releaseRacingRuntimeStop = resolve; });
        },
        onEvent(listener) {
          racingFailureListener = listener;
          return () => { if (racingFailureListener === listener) racingFailureListener = null; };
        },
      };
    },
    dispose() {},
  },
  capture: {
    async startWakePcmStream() {
      return {
        owner: "wake",
        startedAt: 1_000,
        onFrame: () => () => undefined,
        async stop() {},
      };
    },
  },
  transcription: { async transcribe() { return "unused"; } },
  companion: { async sendUserTurn() { return {}; }, cancel() {} },
  output: idleOutput,
  getCompanionSettings: () => ({ enabled: true, wake: { enabled: true } }),
  getVoiceSettings: () => ({ wake: { engine: "custom-sherpa", phrase: "Hey OpenPet" } }),
  getDefaultPetId: () => "default-pet",
});
await racingFailureService.start();
const emitRacingFailure = racingFailureListener as ((event: VoiceWakeHelperEvent) => void) | null;
assert.ok(emitRacingFailure);
emitRacingFailure({ version: 2, type: "keyword", score: 0.9 });
emitRacingFailure({ version: 2, type: "vad", state: "speech-end", score: 0.8 });
await waitFor(() => racingRuntimeStopStarted);
await racingFailureService.handlePowerEvent("suspend");
assert.equal(racingFailureService.snapshot().captureState, "suspended");
const releaseRacingStop = releaseRacingRuntimeStop as (() => void) | null;
assert.ok(releaseRacingStop);
releaseRacingStop();
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(racingFailureService.snapshot().captureState, "suspended", "late runtime failure teardown cannot overwrite a newer suspend");
await racingFailureService.dispose();


let lifecycleRuntimeStarts = 0;
let firstLifecycleStopStarted = false;
let releaseFirstLifecycleStop: (() => void) | null = null;
const lifecycleRaceService = new VoiceWakeWordService({
  runtime: {
    health: () => ({ ready: true, method: "sherpa-onnx", version: "test", modelId: "test-model" }),
    async start() {
      lifecycleRuntimeStarts += 1;
      const sessionNumber = lifecycleRuntimeStarts;
      return {
        sendFrame() {},
        reset() {},
        async stop() {
          if (sessionNumber !== 1) return;
          firstLifecycleStopStarted = true;
          await new Promise<void>((resolve) => { releaseFirstLifecycleStop = resolve; });
        },
        onEvent: () => () => undefined,
      };
    },
    dispose() {},
  },
  capture: {
    async startWakePcmStream() {
      return {
        owner: "wake",
        startedAt: 1_000,
        onFrame: () => () => undefined,
        async stop() {},
      };
    },
  },
  transcription: { async transcribe() { return "unused"; } },
  companion: { async sendUserTurn() { return {}; }, cancel() {} },
  output: idleOutput,
  getCompanionSettings: () => ({ enabled: true, wake: { enabled: true } }),
  getVoiceSettings: () => ({ wake: { engine: "custom-sherpa", phrase: "Hey OpenPet" } }),
  getDefaultPetId: () => "default-pet",
});
await lifecycleRaceService.start();
await new Promise<void>((resolve) => setImmediate(resolve));
const suspendingLifecycle = lifecycleRaceService.handlePowerEvent("suspend");
await waitFor(() => firstLifecycleStopStarted);
const resumingLifecycle = lifecycleRaceService.handlePowerEvent("resume");
await waitFor(() => lifecycleRuntimeStarts === 2 && lifecycleRaceService.snapshot().armed);
const releaseLifecycleStop = releaseFirstLifecycleStop as (() => void) | null;
assert.ok(releaseLifecycleStop);
releaseLifecycleStop();
await Promise.all([suspendingLifecycle, resumingLifecycle]);
assert.equal(lifecycleRaceService.snapshot().captureState, "armed", "late suspend teardown cannot overwrite a newer resumed session");
assert.equal(lifecycleRaceService.snapshot().armed, true);
await lifecycleRaceService.dispose();

let oversizedFrameListener: ((frame: VoicePcmFrame) => void) | null = null;
let oversizedRuntimeListener: ((event: VoiceWakeHelperEvent) => void) | null = null;
const oversizedUtteranceService = new VoiceWakeWordService({
  runtime: {
    health: () => ({ ready: true, method: "sherpa-onnx", version: "test", modelId: "test-model" }),
    async start() {
      return {
        sendFrame() {},
        reset() {},
        async stop() {},
        onEvent(listener) {
          oversizedRuntimeListener = listener;
          return () => { if (oversizedRuntimeListener === listener) oversizedRuntimeListener = null; };
        },
      };
    },
    dispose() {},
  },
  capture: {
    async startWakePcmStream() {
      return {
        owner: "wake",
        startedAt: 1_000,
        onFrame(listener) {
          oversizedFrameListener = listener;
          return () => { if (oversizedFrameListener === listener) oversizedFrameListener = null; };
        },
        async stop() {},
      };
    },
  },
  transcription: { async transcribe() { throw new Error("oversized audio must not be transcribed"); } },
  companion: { async sendUserTurn() { throw new Error("oversized audio must not reach Companion"); }, cancel() {} },
  output: idleOutput,
  getCompanionSettings: () => ({ enabled: true, wake: { enabled: true } }),
  getVoiceSettings: () => ({ wake: { engine: "custom-sherpa", phrase: "Hey OpenPet" } }),
  getDefaultPetId: () => "default-pet",
});
await oversizedUtteranceService.start();
const emitOversizedFrame = oversizedFrameListener as ((frame: VoicePcmFrame) => void) | null;
const emitOversizedRuntime = oversizedRuntimeListener as ((event: VoiceWakeHelperEvent) => void) | null;
assert.ok(emitOversizedFrame);
assert.ok(emitOversizedRuntime);
emitOversizedFrame({
  sampleRate: 16_000,
  channels: 1,
  format: "f32",
  samples: new Float32Array(8_000).fill(0.25),
  capturedAt: 1_000,
});
emitOversizedRuntime({ version: 2, type: "keyword", score: 0.9 });
emitOversizedRuntime({ version: 2, type: "vad", state: "speech-start", score: 0.8 });
emitOversizedFrame({
  sampleRate: 16_000,
  channels: 1,
  format: "f32",
  samples: new Float32Array(8_000).fill(0.25),
  capturedAt: 1_010,
});
for (let index = 0; index < 30; index += 1) {
  emitOversizedFrame({
    sampleRate: 16_000,
    channels: 1,
    format: "f32",
    samples: new Float32Array(16_000).fill(0.25),
    capturedAt: 1_020 + index * 1_000,
  });
}
await waitFor(() => oversizedUtteranceService.snapshot().captureState === "error");
assert.match(oversizedUtteranceService.snapshot().reason ?? "", /30 second limit/i, "the maximum utterance cap finalizes even when VAD never emits speech-end");
await oversizedUtteranceService.dispose();

let silentCapFrameListener: ((frame: VoicePcmFrame) => void) | null = null;
let silentCapRuntimeListener: ((event: VoiceWakeHelperEvent) => void) | null = null;
let silentCapResets = 0;
let silentCapTranscriptions = 0;
const silentCapService = new VoiceWakeWordService({
  runtime: {
    health: () => ({ ready: true, method: "sherpa-onnx" }),
    async start() {
      return {
        sendFrame() {},
        reset() { silentCapResets += 1; },
        async stop() {},
        onEvent(listener) {
          silentCapRuntimeListener = listener;
          return () => { if (silentCapRuntimeListener === listener) silentCapRuntimeListener = null; };
        },
      };
    },
    dispose() {},
  },
  capture: {
    async startWakePcmStream() {
      return {
        owner: "wake",
        startedAt: 1_000,
        onFrame(listener) {
          silentCapFrameListener = listener;
          return () => { if (silentCapFrameListener === listener) silentCapFrameListener = null; };
        },
        async stop() {},
      };
    },
  },
  transcription: { async transcribe() { silentCapTranscriptions += 1; return "must not happen"; } },
  companion: { async sendUserTurn() { return {}; }, cancel() {} },
  output: idleOutput,
  getCompanionSettings: () => ({ enabled: true, wake: { enabled: true } }),
  getVoiceSettings: () => ({ wake: { engine: "custom-sherpa", phrase: "Hey OpenPet" } }),
  getDefaultPetId: () => "default-pet",
});
await silentCapService.start();
const emitSilentCapFrame = silentCapFrameListener as ((frame: VoicePcmFrame) => void) | null;
const emitSilentCapRuntime = silentCapRuntimeListener as ((event: VoiceWakeHelperEvent) => void) | null;
assert.ok(emitSilentCapFrame);
assert.ok(emitSilentCapRuntime);
emitSilentCapRuntime({ version: 2, type: "keyword", score: 0.9 });
emitSilentCapRuntime({ version: 2, type: "vad", state: "speech-start", score: 0.8 });
for (let index = 0; index < 30; index += 1) {
  emitSilentCapFrame({
    sampleRate: 16_000,
    channels: 1,
    format: "f32",
    samples: new Float32Array(16_000),
    capturedAt: 2_000 + index * 1_000,
  });
}
assert.equal(silentCapService.snapshot().turnState, "idle", "a max-duration silent activation resets without waiting for VAD speech-end");
assert.equal(silentCapResets, 1);
assert.equal(silentCapTranscriptions, 0);
await silentCapService.dispose();

let configuredPhrase = "Hey OpenPet";
let configuredWakeEnabled = true;
const voiceSettingsListeners = new Set<() => void>();
const companionSettingsListeners = new Set<() => void>();
const reconfiguredPhrases: string[] = [];
let reconfiguredCaptureStops = 0;
let reconfiguredRuntimeStops = 0;
const phraseChangeService = new VoiceWakeWordService({
  runtime: {
    health: () => ({ ready: true, method: "sherpa-onnx" }),
    async start({ phrase }) {
      reconfiguredPhrases.push(phrase);
      return {
        sendFrame() {},
        reset() {},
        async stop() { reconfiguredRuntimeStops += 1; },
        onEvent() { return () => undefined; },
      };
    },
    dispose() {},
  },
  capture: {
    async startWakePcmStream() {
      return {
        owner: "wake",
        startedAt: 1_000,
        onFrame() { return () => undefined; },
        async stop() { reconfiguredCaptureStops += 1; },
      };
    },
  },
  transcription: { async transcribe() { return ""; } },
  companion: { async sendUserTurn() { return {}; }, cancel() {} },
  output: idleOutput,
  getCompanionSettings: () => ({ enabled: true, wake: { enabled: configuredWakeEnabled } }),
  getVoiceSettings: () => ({ wake: { engine: "custom-sherpa", phrase: configuredPhrase } }),
  subscribeCompanionSettings(listener) {
    companionSettingsListeners.add(listener);
    return () => { companionSettingsListeners.delete(listener); };
  },
  subscribeVoiceSettings(listener) {
    voiceSettingsListeners.add(listener);
    return () => { voiceSettingsListeners.delete(listener); };
  },
  getDefaultPetId: () => "default-pet",
});
await phraseChangeService.start();
configuredPhrase = "Hello Pedra";
for (const listener of voiceSettingsListeners) listener();
await waitFor(() => reconfiguredPhrases.length === 2);
const reconfigured = phraseChangeService.snapshot();
assert.equal(reconfigured.armed, true);
assert.deepEqual(
  reconfiguredPhrases,
  ["Hey OpenPet", "Hello Pedra"],
  "saving a new phrase replaces the active helper configuration",
);
assert.equal(reconfiguredRuntimeStops, 1);
assert.equal(reconfiguredCaptureStops, 1);

configuredWakeEnabled = false;
for (const listener of companionSettingsListeners) listener();
await waitFor(() => phraseChangeService.snapshot().captureState === "disabled");
assert.equal(phraseChangeService.snapshot().armed, false, "disabling Listen stops the microphone without an app restart");
assert.equal(reconfiguredRuntimeStops, 2);
assert.equal(reconfiguredCaptureStops, 2);

await phraseChangeService.dispose();
assert.equal(voiceSettingsListeners.size, 0, "voice settings listener is released during shutdown");
assert.equal(companionSettingsListeners.size, 0, "Companion settings listener is released during shutdown");

let stopDuringSpeechRuntimeListener: ((event: VoiceWakeHelperEvent) => void) | null = null;
let stopDuringSpeechOutputListener: ((snapshot: VoiceOutputActivitySnapshot) => void) | null = null;
let stopDuringSpeechOutput: VoiceOutputActivitySnapshot = { active: false, activePetIds: [], activeReasons: [] };
const stopDuringSpeechService = new VoiceWakeWordService({
  runtime: {
    health: () => ({ ready: true, method: "sherpa-onnx" }),
    async start() {
      return {
        sendFrame() {},
        reset() {},
        async stop() {},
        onEvent(listener) {
          stopDuringSpeechRuntimeListener = listener;
          return () => { if (stopDuringSpeechRuntimeListener === listener) stopDuringSpeechRuntimeListener = null; };
        },
      };
    },
    dispose() {},
  },
  capture: {
    async startWakePcmStream() {
      return {
        owner: "wake",
        startedAt: 1_000,
        onFrame() { return () => undefined; },
        async stop() {},
      };
    },
  },
  transcription: { async transcribe() { return "unused"; } },
  companion: { async sendUserTurn() { return {}; }, cancel() {} },
  output: {
    getActivitySnapshot: () => stopDuringSpeechOutput,
    onActivityChanged(listener) {
      stopDuringSpeechOutputListener = listener;
      return () => { if (stopDuringSpeechOutputListener === listener) stopDuringSpeechOutputListener = null; };
    },
  },
  getCompanionSettings: () => ({ enabled: true, wake: { enabled: true } }),
  getVoiceSettings: () => ({ wake: { engine: "custom-sherpa", phrase: "Hey OpenPet" } }),
  getDefaultPetId: () => "default-pet",
});
await stopDuringSpeechService.start();
const markOutputActive = stopDuringSpeechOutputListener as ((snapshot: VoiceOutputActivitySnapshot) => void) | null;
assert.ok(markOutputActive);
stopDuringSpeechOutput = { active: true, activePetIds: ["default-pet"], activeReasons: ["conversation"] };
markOutputActive(stopDuringSpeechOutput);
assert.equal(stopDuringSpeechService.snapshot().turnState, "speaking");
await stopDuringSpeechService.stop();
stopDuringSpeechOutput = { active: false, activePetIds: [], activeReasons: [] };
await stopDuringSpeechService.start();
const emitAfterSpeechStop = stopDuringSpeechRuntimeListener as ((event: VoiceWakeHelperEvent) => void) | null;
assert.ok(emitAfterSpeechStop);
emitAfterSpeechStop({ version: 2, type: "keyword", score: 0.9 });
assert.equal(
  stopDuringSpeechService.snapshot().turnState,
  "activated",
  "stopping while speech is active cannot permanently suppress wake after re-arming",
);
await stopDuringSpeechService.dispose();

let resolveWakeHealth!: (health: { ready: true }) => void;
const pendingWakeHealth = new Promise<{ ready: true }>((resolve) => { resolveWakeHealth = resolve; });
let wakeHealthCalls = 0;
let healthRaceCaptureStarts = 0;
const healthRaceService = new VoiceWakeWordService({
  runtime: {
    health: () => ({ ready: true, method: "sherpa-onnx", version: "test", modelId: "test-model" }),
    async start() { return { sendFrame() {}, reset() {}, async stop() {}, onEvent: () => () => undefined }; },
    dispose() {},
  },
  capture: {
    async startWakePcmStream() {
      healthRaceCaptureStarts += 1;
      return { owner: "wake", startedAt: 1_000, onFrame: () => () => undefined, async stop() {} };
    },
  },
  transcription: {
    async health() {
      wakeHealthCalls += 1;
      return wakeHealthCalls === 1 ? pendingWakeHealth : { ready: true as const };
    },
    async transcribe() { return "unused"; },
  },
  companion: { async sendUserTurn() { return {}; }, cancel() {} },
  output: idleOutput,
  getCompanionSettings: () => ({ enabled: true, wake: { enabled: true } }),
  getVoiceSettings: () => ({ wake: { engine: "custom-sherpa", phrase: "Hey OpenPet" } }),
  getDefaultPetId: () => "default-pet",
});
const healthRaceStart = healthRaceService.start();
await new Promise((resolve) => setTimeout(resolve, 0));
let healthRaceSuspended = false;
const healthRaceSuspension = healthRaceService.suspendForExternalCapture("wake-calibration").then((release) => {
  healthRaceSuspended = true;
  return release;
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(healthRaceSuspended, false, "external capture waits for an in-flight wake health check");
resolveWakeHealth({ ready: true });
await assert.rejects(healthRaceStart, (error: unknown) => error instanceof Error && error.name === "AbortError");
const resumeHealthRace = await healthRaceSuspension;
assert.equal(healthRaceCaptureStarts, 0, "a stale wake health result cannot acquire the microphone during calibration");
await resumeHealthRace();
assert.equal(healthRaceService.snapshot().armed, true);
assert.equal(healthRaceCaptureStarts, 1, "ambient wake re-arms after calibration releases the microphone");
await healthRaceService.dispose();

let resolvePendingWakeCapture!: (session: VoiceWakePcmSession) => void;
const pendingWakeCapture = new Promise<VoiceWakePcmSession>((resolve) => { resolvePendingWakeCapture = resolve; });
let pendingWakeCaptureStarts = 0;
const pendingWakeCaptureSession: VoiceWakePcmSession = {
  owner: "wake",
  startedAt: 1_000,
  onFrame: () => () => undefined,
  async stop() {},
};
const pendingWakeService = new VoiceWakeWordService({
  runtime: {
    health: () => ({ ready: true, method: "sherpa-onnx", version: "test", modelId: "test-model" }),
    async start() { return { sendFrame() {}, reset() {}, async stop() {}, onEvent: () => () => undefined }; },
    dispose() {},
  },
  capture: {
    async startWakePcmStream() {
      pendingWakeCaptureStarts += 1;
      return pendingWakeCaptureStarts === 1 ? pendingWakeCapture : pendingWakeCaptureSession;
    },
  },
  transcription: { async transcribe() { return "unused"; } },
  companion: { async sendUserTurn() { return {}; }, cancel() {} },
  output: idleOutput,
  getCompanionSettings: () => ({ enabled: true, wake: { enabled: true } }),
  getVoiceSettings: () => ({ wake: { engine: "custom-sherpa", phrase: "Hey OpenPet" } }),
  getDefaultPetId: () => "default-pet",
});
const pendingWakeStart = pendingWakeService.start();
await new Promise((resolve) => setTimeout(resolve, 0));
let pendingSuspensionResolved = false;
const pendingSuspension = pendingWakeService.suspendForExternalCapture("wake-calibration").then((release) => {
  pendingSuspensionResolved = true;
  return release;
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(pendingSuspensionResolved, false, "external capture waits for an in-flight ambient wake acquisition to release its resources");
resolvePendingWakeCapture(pendingWakeCaptureSession);
await assert.rejects(pendingWakeStart, (error: unknown) => error instanceof Error && error.name === "AbortError");
const resumePendingWake = await pendingSuspension;
assert.equal(pendingWakeService.snapshot().captureState, "suspended");
await resumePendingWake();
assert.equal(pendingWakeService.snapshot().armed, true, "ambient wake can re-arm after the serialized external capture");
await pendingWakeService.dispose();

let externalCaptureStarts = 0;
let externalCaptureStops = 0;
const externalCaptureService = new VoiceWakeWordService({
  runtime: {
    health: () => ({ ready: true, method: "sherpa-onnx", version: "test", modelId: "test-model" }),
    async start() {
      return { sendFrame() {}, reset() {}, async stop() {}, onEvent: () => () => undefined };
    },
    dispose() {},
  },
  capture: {
    async startWakePcmStream() {
      externalCaptureStarts += 1;
      return {
        owner: "wake",
        startedAt: 1_000,
        onFrame: () => () => undefined,
        async stop() { externalCaptureStops += 1; },
      };
    },
  },
  transcription: { async transcribe() { return "unused"; } },
  companion: { async sendUserTurn() { return {}; }, cancel() {} },
  output: idleOutput,
  getCompanionSettings: () => ({ enabled: true, wake: { enabled: true } }),
  getVoiceSettings: () => ({ wake: { engine: "custom-sherpa", phrase: "Hey OpenPet" } }),
  getDefaultPetId: () => "default-pet",
});
await externalCaptureService.start();
const resumeExternalCapture = await externalCaptureService.suspendForExternalCapture("plugin-listen");
assert.equal(externalCaptureService.snapshot().captureState, "suspended");
assert.equal(externalCaptureService.snapshot().armed, false);
assert.equal(externalCaptureStops, 1, "one-shot microphone use first releases persistent wake capture");
await resumeExternalCapture();
assert.equal(externalCaptureService.snapshot().armed, true);
assert.equal(externalCaptureStarts, 2, "persistent wake automatically resumes after one-shot microphone use");
await resumeExternalCapture();
assert.equal(externalCaptureStarts, 2, "the resume callback is idempotent");
await externalCaptureService.dispose();

// Contract: after spoken output and the companion turn both finish, the
// completed response remains visible while one brief follow-up turn is
// accepted without another keyword. Explicit cancellation aborts active work.
let followUpFrame: ((frame: VoicePcmFrame) => void) | null = null;
let followUpEvent: ((event: VoiceWakeHelperEvent) => void) | null = null;
let followUpOutput: ((snapshot: VoiceOutputActivitySnapshot) => void) | null = null;
const followUpAcks: Array<{ readonly followUp: boolean; readonly completedText?: string }> = [];
const followUpTurns: string[] = [];
const followUpReleases: Array<() => void> = [];
const followUpCancellations: string[] = [];
const followUpService = new VoiceWakeWordService({
  runtime: {
    health: () => ({ ready: true, method: "sherpa-onnx", version: "test", modelId: "test-model" }),
    async start() {
      return {
        sendFrame() {},
        reset() {},
        async stop() {},
        onEvent(listener) {
          followUpEvent = listener;
          return () => { if (followUpEvent === listener) followUpEvent = null; };
        },
      };
    },
    dispose() {},
  },
  capture: {
    async startWakePcmStream() {
      return {
        owner: "wake",
        startedAt: 1_000,
        onFrame(listener) {
          followUpFrame = listener;
          return () => { if (followUpFrame === listener) followUpFrame = null; };
        },
        async stop() {},
      };
    },
  },
  transcription: { async transcribe() { return `turn-${followUpTurns.length + 1}`; } },
  companion: {
    async sendUserTurn(request) {
      followUpTurns.push(request.text);
      await new Promise<void>((resolve) => { followUpReleases.push(resolve); });
      return { text: `response-${followUpTurns.length}` };
    },
    cancel(petId) { followUpCancellations.push(petId); },
  },
  output: {
    getActivitySnapshot: () => ({ active: false, activePetIds: [], activeReasons: [] }),
    onActivityChanged(listener) {
      followUpOutput = listener;
      return () => { if (followUpOutput === listener) followUpOutput = null; };
    },
  },
  acknowledgement: {
    showListening(input) {
      followUpAcks.push({
        followUp: input.followUp,
        ...(input.completedText ? { completedText: input.completedText } : {}),
      });
    },
    showThinking() {},
    clearListening() {},
  },
  getCompanionSettings: () => ({ enabled: true, wake: { enabled: true, followUpEnabled: true } }),
  getVoiceSettings: () => ({ wake: { engine: "custom-sherpa", phrase: "Hey OpenPet" } }),
  getDefaultPetId: () => "default-pet",
  followUpTimeoutMs: 25,
});
await followUpService.start();
const sendFollowUpEvent = (event: VoiceWakeHelperEvent) => {
  const listener = followUpEvent as ((value: VoiceWakeHelperEvent) => void) | null;
  assert.ok(listener);
  listener(event);
};
const sendFollowUpFrame = () => {
  const listener = followUpFrame as ((value: VoicePcmFrame) => void) | null;
  assert.ok(listener);
  listener({ sampleRate: 16_000, channels: 1, format: "f32", samples: new Float32Array(4_800).fill(0.25), capturedAt: 1_000 });
};
sendFollowUpEvent({ version: 2, type: "keyword", score: 0.9 });
sendFollowUpEvent({ version: 2, type: "vad", state: "speech-start", score: 0.8 });
sendFollowUpFrame();
sendFollowUpEvent({ version: 2, type: "vad", state: "speech-end", score: 0.8 });
await waitFor(() => followUpTurns.length === 1);
assert.deepEqual(followUpAcks, [{ followUp: false }]);
const emitFollowUpOutput = followUpOutput as ((snapshot: VoiceOutputActivitySnapshot) => void) | null;
assert.ok(emitFollowUpOutput);
emitFollowUpOutput({ active: true, activePetIds: ["default-pet"], activeReasons: ["conversation"] });
emitFollowUpOutput({ active: false, activePetIds: [], activeReasons: [] });
assert.equal(followUpService.snapshot().turnState, "speaking", "follow-up waits for the completed response text");
assert.deepEqual(followUpAcks, [{ followUp: false }]);
followUpReleases.shift()?.();
await waitFor(() => followUpService.snapshot().turnState === "follow-up");
assert.deepEqual(followUpAcks, [
  { followUp: false },
  { followUp: true, completedText: "response-1" },
]);
sendFollowUpEvent({ version: 2, type: "vad", state: "speech-start", score: 0.8 });
sendFollowUpFrame();
await new Promise<void>((resolve) => setTimeout(resolve, 40));
assert.equal(
  followUpService.snapshot().turnState,
  "collecting",
  "accepted follow-up speech outlives the short no-speech timer",
);
assert.deepEqual(followUpTurns, ["turn-1"], "follow-up waits for speech endpointing before transcription");
sendFollowUpFrame();
sendFollowUpEvent({ version: 2, type: "vad", state: "speech-end", score: 0.8 });
await waitFor(() => followUpTurns.length === 2);
assert.equal(followUpService.cancelConversation("test-shortcut"), true);
assert.equal(followUpService.snapshot().turnState, "idle");
assert.deepEqual(followUpCancellations, ["default-pet"]);
followUpReleases.shift()?.();
await followUpService.dispose();

const sensitiveReasonService = new VoiceWakeWordService({
  runtime: {
    health: () => ({
      ready: false,
      method: "sherpa-onnx",
      reason: "failed /Users/example/model.onnx https://secret.example/path sk-secretvalue123",
    }),
    async start() { throw new Error("unused"); },
    dispose() {},
  },
  getVoiceSettings: () => ({ wake: { engine: "custom-sherpa", phrase: "Hey OpenPet" } }),
});
const sanitizedHealthReason = sensitiveReasonService.health().reason ?? "";
const sanitizedSnapshotReason = sensitiveReasonService.snapshot().reason ?? "";
assert.doesNotMatch(sanitizedHealthReason, /\/Users\/example|secret\.example|sk-secretvalue123/i);
assert.doesNotMatch(sanitizedSnapshotReason, /\/Users\/example|secret\.example|sk-secretvalue123/i);
await sensitiveReasonService.dispose();

function emitFrame(sampleCount: number): void {
  assert.ok(frameListener, "capture frame listener is installed");
  frameListener({
    sampleRate: 16_000,
    channels: 1,
    format: "f32",
    samples: new Float32Array(sampleCount).fill(0.25),
    capturedAt: 1_000,
  });
}

function emitCaptureEnded(reason: string): void {
  const listener = captureEndedListener as ((reason: string) => void) | null;
  assert.ok(listener, "capture end listener is installed");
  listener(reason);
}

function emitRuntime(event: VoiceWakeHelperEvent): void {
  assert.ok(runtimeListener, "runtime event listener is installed");
  runtimeListener(event);
}

function emitOutput(activity: VoiceOutputActivitySnapshot): void {
  const listener = outputListener as ((snapshot: VoiceOutputActivitySnapshot) => void) | null;
  assert.ok(listener, "output activity listener is installed");
  listener(activity);
}

function releaseTurn(): void {
  const release = releaseCompanionTurn as (() => void) | null;
  assert.ok(release, "Companion turn is waiting for spoken output");
  releaseCompanionTurn = null;
  release();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(predicate(), true, "timed out waiting for wake turn");
}

console.log("wake coordinator flow and lifecycle verified");
