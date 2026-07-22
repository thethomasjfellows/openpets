import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getVoiceSettings, initializeVoiceSettings, updateVoiceSettings } from "../src/voice-settings.js";
import { VoiceWakeCalibrationCollector } from "../src/voice-wake-calibration-collector.js";
import { selectRuntimeWakeVariants } from "../src/voice-wake-calibration-normalization.js";
import { normalizeCalibrationVariants, VoiceWakeCalibrationService } from "../src/voice-wake-calibration-service.js";
import type { VoiceWakeHelperEvent } from "../src/voice-wake-helper-protocol.js";
import type { VoiceWakePcmSession, VoiceWakeRuntimeSession } from "../src/voice-wake-runtime.js";
import type { VoicePcmFrame } from "../src/voice-wake-types.js";

function verifyCollectorUsesPreRollAndRejectsSilence(): void {
  const collector = new VoiceWakeCalibrationCollector();
  collector.ingest(frame(0.2));
  collector.vad("speech-start");
  for (let index = 0; index < 10; index += 1) collector.ingest(frame(0.2));
  const samples = collector.vad("speech-end");
  assert.ok(samples && samples.length > 10 * 320, "accepted setup audio includes bounded audio immediately before VAD start");

  const silent = new VoiceWakeCalibrationCollector();
  silent.vad("speech-start");
  for (let index = 0; index < 10; index += 1) silent.ingest(frame(0));
  assert.equal(silent.vad("speech-end"), null, "silent attempts are never sent to transcription");
  assert.deepEqual(
    normalizeCalibrationVariants("Hey Pedro", ["My private bank account number is seven", "Hey pay drill."]),
    ["Hey pay drill"],
    "unrelated speech is not proposed as a persistent wake alias",
  );
  const saved = Array.from({ length: 18 }, (_, index) => `Hey Pedro ${index + 1}`);
  assert.deepEqual(
    selectRuntimeWakeVariants("Hey Pedro", saved),
    saved.slice(0, 15),
    "saved and active wake alternatives share the visible fifteen-item limit",
  );
}

async function verifyTenLocalSamplesMergeEditableTextInterpretations(): Promise<void> {
  initializeVoiceSettings(mkdtempSync(join(tmpdir(), "openpets-wake-calibration-")));
  updateVoiceSettings({ wake: { engine: "custom-sherpa", phrase: "Hey Pedro", calibration: { phrase: "Hey Pedro", variants: ["Hay Pedro"], updatedAt: 1 } } });
  const capture = new FakeCapture();
  const runtime = new FakeRuntime();
  const transcription = new FakeTranscription(tenTranscripts());
  let suspended = 0;
  let released = 0;
  const service = new VoiceWakeCalibrationService({
    capture,
    runtime,
    transcription,
    wake: {
      suspendForExternalCapture: async () => {
        suspended += 1;
        return async () => { released += 1; };
      },
    },
    now: () => 123_456,
  });

  await service.start("Hey Pedro");
  assert.equal(service.snapshot().state, "listening");
  assert.equal(suspended, 1);
  assert.equal(capture.owner, "wake-calibration");
  for (let sample = 0; sample < 10; sample += 1) {
    capture.emit(frame(0.15));
    runtime.primary.emit({ version: 2, type: "vad", state: "speech-start", score: 1 });
    runtime.primary.emit({ version: 2, type: "keyword", score: 0.9 });
    for (let index = 0; index < 10; index += 1) capture.emit(frame(0.15));
    runtime.primary.emit({ version: 2, type: "vad", state: "speech-end", score: 1 });
    await waitFor(() => service.snapshot().completedSamples === sample + 1);
  }
  assert.equal(service.snapshot().state, "review");
  assert.equal(service.snapshot().detectedSamples, 10, "setup reports how many recordings the current wake detector recognized");
  assert.deepEqual(service.snapshot().batchInterpretations, ["Hey pay drill", "A pay drill"], "the intended phrase is not saved as its own interpretation");
  assert.equal(transcription.calls, 10, "only the ten bounded setup samples are transcribed");

  await service.save();
  assert.equal(released, 1, "ambient wake listening resumes after setup is saved");
  assert.equal(service.snapshot().completedSamples, 10, "interpretation filtering does not erase completed recordings");
  assert.deepEqual(getVoiceSettings().wake.calibration, {
    phrase: "Hey Pedro",
    variants: ["Hey pay drill", "A pay drill", "Hay Pedro"],
    updatedAt: 123_456,
  });
  assert.equal(runtime.starts.length, 4, "the VAD helper, each learned variant, and the final primary phrase are validated");
  assert.deepEqual(runtime.starts.at(-1), { phrase: "Hey Pedro", variants: ["Hey pay drill", "A pay drill", "Hay Pedro"] });

  await service.deleteInterpretation("A pay drill");
  assert.deepEqual(getVoiceSettings().wake.calibration?.variants, ["Hey pay drill", "Hay Pedro"], "users can delete one visible interpretation without resetting the batch history");

  await service.reset();
  assert.equal(getVoiceSettings().wake.calibration, undefined, "reset removes learned text variants");
  assert.equal(service.snapshot().phrase, "Hey Pedro", "reset returns current settings without stale setup metadata");
}

async function verifyCancelWinsStartupAndSaveRaces(): Promise<void> {
  initializeVoiceSettings(mkdtempSync(join(tmpdir(), "openpets-wake-calibration-race-")));
  updateVoiceSettings({ wake: { engine: "custom-sherpa", phrase: "Hey Pedro" } });
  const startupGate = deferred<() => Promise<void>>();
  let startupReleased = 0;
  const startupService = new VoiceWakeCalibrationService({
    capture: new FakeCapture(),
    runtime: new FakeRuntime(),
    transcription: new FakeTranscription([]),
    wake: { suspendForExternalCapture: () => startupGate.promise },
  });
  const starting = startupService.start("Hey Pedro");
  await tick();
  await assert.rejects(startupService.start("Hey Pedro"), /finish or cancel/i, "a second start cannot pass the asynchronous startup lock");
  await startupService.cancel();
  startupGate.resolve(async () => { startupReleased += 1; });
  await assert.rejects(starting, (error: unknown) => error instanceof Error && error.name === "AbortError");
  assert.equal(startupService.snapshot().state, "idle", "a cancelled startup cannot overwrite idle with a stale error");
  assert.equal(startupReleased, 1, "a late wake suspension is still released exactly once");

  const capture = new FakeCapture();
  const runtime = new FakeRuntime();
  const service = new VoiceWakeCalibrationService({
    capture,
    runtime,
    transcription: new FakeTranscription(tenTranscripts()),
    wake: { suspendForExternalCapture: async () => async () => undefined },
  });
  await service.start("Hey Pedro");
  await recordTenSamples(service, capture, runtime.primary);
  runtime.deferValidation = true;
  const saving = service.save();
  await waitFor(() => runtime.validationStarted);
  await service.cancel();
  await assert.rejects(saving, (error: unknown) => error instanceof Error && error.name === "AbortError");
  assert.equal(service.snapshot().state, "idle", "cancel remains authoritative while learned variants are being validated");
  assert.equal(getVoiceSettings().wake.calibration, undefined, "a cancelled save cannot persist calibration later");
}

async function verifyUnsupportedPrimaryPhraseIsNotSaved(): Promise<void> {
  initializeVoiceSettings(mkdtempSync(join(tmpdir(), "openpets-wake-calibration-primary-")));
  updateVoiceSettings({ wake: { engine: "custom-sherpa", phrase: "Hey Pedro" } });
  const capture = new FakeCapture();
  const runtime = new FakeRuntime();
  const service = new VoiceWakeCalibrationService({
    capture,
    runtime,
    transcription: new FakeTranscription(tenTranscripts()),
    wake: { suspendForExternalCapture: async () => async () => undefined },
  });
  await service.start("Hey Pedro");
  await recordTenSamples(service, capture, runtime.primary);
  runtime.unsupportedPhrase = "Hey Pedro";
  await assert.rejects(service.save(), /not supported/i);
  assert.equal(getVoiceSettings().wake.calibration, undefined, "setup cannot be saved unless the configured primary phrase can arm KWS");
  assert.equal(service.snapshot().state, "error");
}

async function verifyResumeFailureDoesNotLatchSaving(): Promise<void> {
  initializeVoiceSettings(mkdtempSync(join(tmpdir(), "openpets-wake-calibration-resume-")));
  updateVoiceSettings({ wake: { engine: "custom-sherpa", phrase: "Hey Pedro" } });
  const capture = new FakeCapture();
  const runtime = new FakeRuntime();
  const service = new VoiceWakeCalibrationService({
    capture,
    runtime,
    transcription: new FakeTranscription(tenTranscripts()),
    wake: { suspendForExternalCapture: async () => async () => { throw new Error("resume failed"); } },
  });
  await service.start("Hey Pedro");
  await recordTenSamples(service, capture, runtime.primary);
  await service.save();
  assert.equal(service.snapshot().state, "complete", "a wake re-arm failure cannot leave persisted setup stuck in saving");
  assert.equal(service.snapshot().calibrated, true);
}

async function verifyFrameWriteFailureEndsSetup(): Promise<void> {
  initializeVoiceSettings(mkdtempSync(join(tmpdir(), "openpets-wake-calibration-frame-")));
  updateVoiceSettings({ wake: { engine: "custom-sherpa", phrase: "Hey Pedro" } });
  const capture = new FakeCapture();
  const runtime = new FakeRuntime();
  let released = 0;
  const service = new VoiceWakeCalibrationService({
    capture,
    runtime,
    transcription: new FakeTranscription([]),
    wake: { suspendForExternalCapture: async () => async () => { released += 1; } },
  });
  await service.start("Hey Pedro");
  runtime.primary.throwOnFrame = true;
  capture.emit(frame(0.1));
  await waitFor(() => service.snapshot().state === "error");
  assert.equal(released, 1, "helper input failure releases suspended ambient wake listening");
}

async function verifyCancelledTranscriptionCannotAffectRestartedSetup(): Promise<void> {
  initializeVoiceSettings(mkdtempSync(join(tmpdir(), "openpets-wake-calibration-transcription-race-")));
  updateVoiceSettings({ wake: { engine: "custom-sherpa", phrase: "Hey Pedro" } });
  const capture = new FakeCapture();
  const runtime = new FakeRuntime();
  const firstTranscript = deferred<string>();
  let transcriptionCalls = 0;
  const service = new VoiceWakeCalibrationService({
    capture,
    runtime,
    transcription: {
      async health() { return { ready: true }; },
      async transcribe() {
        transcriptionCalls += 1;
        return transcriptionCalls === 1 ? firstTranscript.promise : "Hey Pedro";
      },
    },
    wake: { suspendForExternalCapture: async () => async () => undefined },
  });

  await service.start("Hey Pedro");
  capture.emit(frame(0.15));
  runtime.primary.emit({ version: 2, type: "vad", state: "speech-start", score: 1 });
  for (let index = 0; index < 10; index += 1) capture.emit(frame(0.15));
  runtime.primary.emit({ version: 2, type: "vad", state: "speech-end", score: 1 });
  await waitFor(() => service.snapshot().state === "transcribing");

  await service.cancel();
  await service.start("Hey Pedro");
  const restartedSession = runtime.sessions.at(-1)!;
  capture.emit(frame(0.15));
  restartedSession.emit({ version: 2, type: "vad", state: "speech-start", score: 1 });
  for (let index = 0; index < 10; index += 1) capture.emit(frame(0.15));
  restartedSession.emit({ version: 2, type: "vad", state: "speech-end", score: 1 });
  await waitFor(() => service.snapshot().completedSamples === 1);
  const resetCountBeforeStaleCompletion = restartedSession.resets;

  firstTranscript.resolve("Hey pay drill");
  await tick();
  assert.equal(service.snapshot().completedSamples, 1, "a cancelled transcription cannot add a sample to the restarted setup");
  assert.equal(restartedSession.resets, resetCountBeforeStaleCompletion, "stale cleanup cannot reset the restarted helper session");
  await service.cancel();
}

async function verifyCancelWinsFinalSampleShutdown(): Promise<void> {
  initializeVoiceSettings(mkdtempSync(join(tmpdir(), "openpets-wake-calibration-final-stop-race-")));
  updateVoiceSettings({ wake: { engine: "custom-sherpa", phrase: "Hey Pedro" } });
  const capture = new FakeCapture();
  const runtime = new FakeRuntime();
  const stopGate = deferred<void>();
  const service = new VoiceWakeCalibrationService({
    capture,
    runtime,
    transcription: new FakeTranscription(tenTranscripts()),
    wake: { suspendForExternalCapture: async () => async () => undefined },
  });

  await service.start("Hey Pedro");
  capture.stopGate = stopGate.promise;
  await recordTenSamples(service, capture, runtime.primary);
  assert.equal(service.snapshot().state, "transcribing", "the last sample waits for microphone shutdown before review");
  await service.cancel();
  assert.equal(service.snapshot().state, "idle");
  stopGate.resolve();
  await tick();
  assert.equal(service.snapshot().state, "idle", "late final-sample cleanup cannot overwrite a user cancellation with review");
}

async function verifyFailureWinsLateTranscription(): Promise<void> {
  initializeVoiceSettings(mkdtempSync(join(tmpdir(), "openpets-wake-calibration-failure-race-")));
  updateVoiceSettings({ wake: { engine: "custom-sherpa", phrase: "Hey Pedro" } });
  const capture = new FakeCapture();
  const runtime = new FakeRuntime();
  const transcript = deferred<string>();
  const service = new VoiceWakeCalibrationService({
    capture,
    runtime,
    transcription: {
      async health() { return { ready: true }; },
      async transcribe() { return transcript.promise; },
    },
    wake: { suspendForExternalCapture: async () => async () => undefined },
  });

  await service.start("Hey Pedro");
  capture.emit(frame(0.15));
  runtime.primary.emit({ version: 2, type: "vad", state: "speech-start", score: 1 });
  for (let index = 0; index < 10; index += 1) capture.emit(frame(0.15));
  runtime.primary.emit({ version: 2, type: "vad", state: "speech-end", score: 1 });
  await waitFor(() => service.snapshot().state === "transcribing");
  runtime.primary.emit({ version: 2, type: "error", message: "helper failed" });
  await waitFor(() => service.snapshot().state === "error");
  transcript.resolve("Hey pay drill");
  await tick();
  assert.equal(service.snapshot().state, "error", "a late transcript cannot hide the helper failure");
  assert.equal(service.snapshot().completedSamples, 0, "a transcript returned after failure is never accepted");
}

async function verifyResetRemovesAliasesBeforeWakeResumes(): Promise<void> {
  initializeVoiceSettings(mkdtempSync(join(tmpdir(), "openpets-wake-calibration-reset-order-")));
  updateVoiceSettings({
    wake: {
      engine: "custom-sherpa",
      phrase: "Hey Pedro",
      calibration: { phrase: "Hey Pedro", variants: ["Hey pay drill"], updatedAt: 123 },
    },
  });
  let calibrationSeenOnRelease: unknown = "not-released";
  const service = new VoiceWakeCalibrationService({
    capture: new FakeCapture(),
    runtime: new FakeRuntime(),
    transcription: new FakeTranscription([]),
    wake: {
      suspendForExternalCapture: async () => async () => {
        calibrationSeenOnRelease = getVoiceSettings().wake.calibration;
      },
    },
  });

  await service.start("Hey Pedro");
  await service.reset();
  assert.equal(calibrationSeenOnRelease, undefined, "ambient wake re-arms only after reset aliases are removed");
  assert.equal(getVoiceSettings().wake.calibration, undefined);
}

async function verifyIdleResetAwaitsWakeReconfiguration(): Promise<void> {
  initializeVoiceSettings(mkdtempSync(join(tmpdir(), "openpets-wake-calibration-idle-reset-")));
  updateVoiceSettings({
    wake: {
      engine: "custom-sherpa",
      phrase: "Hey Pedro",
      calibration: { phrase: "Hey Pedro", variants: ["Hey pay drill"], updatedAt: 123 },
    },
  });
  const rearmed = deferred<void>();
  let suspensions = 0;
  let aliasesSeenOnRearm: unknown = "not-rearmed";
  const service = new VoiceWakeCalibrationService({
    capture: new FakeCapture(),
    runtime: new FakeRuntime(),
    transcription: new FakeTranscription([]),
    wake: {
      suspendForExternalCapture: async () => {
        suspensions += 1;
        return async () => {
          aliasesSeenOnRearm = getVoiceSettings().wake.calibration;
          await rearmed.promise;
        };
      },
    },
  });

  let resetResolved = false;
  const resetting = service.reset().then((snapshot) => {
    resetResolved = true;
    return snapshot;
  });
  await tick();
  assert.equal(suspensions, 1, "idle reset temporarily suspends an already-armed wake listener");
  assert.equal(aliasesSeenOnRearm, undefined, "wake reconfiguration starts only after aliases are removed");
  assert.equal(resetResolved, false, "reset IPC waits until wake has reconfigured");
  rearmed.resolve();
  await resetting;
  assert.equal(resetResolved, true);
}

class FakeCapture {
  owner: string | undefined;
  listener: ((value: VoicePcmFrame) => void) | null = null;
  stopGate: Promise<void> | null = null;

  async startWakePcmStream(options: { owner?: "wake" | "wake-calibration" }): Promise<VoiceWakePcmSession> {
    this.owner = options.owner;
    return {
      owner: options.owner ?? "wake",
      startedAt: 1,
      onFrame: (listener) => {
        this.listener = listener;
        return () => { if (this.listener === listener) this.listener = null; };
      },
      stop: async () => { await this.stopGate; },
    };
  }

  emit(value: VoicePcmFrame): void {
    this.listener?.(value);
  }
}

class FakeRuntimeSession implements VoiceWakeRuntimeSession {
  listener: ((event: VoiceWakeHelperEvent) => void) | null = null;
  throwOnFrame = false;
  resets = 0;
  sendFrame(): void { if (this.throwOnFrame) throw new Error("helper input failed"); }
  reset(): void { this.resets += 1; }
  async stop(): Promise<void> {}
  onEvent(listener: (event: VoiceWakeHelperEvent) => void): () => void {
    this.listener = listener;
    return () => { if (this.listener === listener) this.listener = null; };
  }
  emit(event: VoiceWakeHelperEvent): void { this.listener?.(event); }
}

class FakeRuntime {
  readonly starts: Array<{ phrase: string; variants: readonly string[] }> = [];
  readonly sessions: FakeRuntimeSession[] = [];
  readonly primary = new FakeRuntimeSession();
  deferValidation = false;
  validationStarted = false;
  unsupportedPhrase: string | null = null;
  health() { return { ready: true as const, method: "sherpa-onnx" as const }; }
  async start(config: { phrase: string; variants?: readonly string[]; signal?: AbortSignal }): Promise<VoiceWakeRuntimeSession> {
    this.starts.push({ phrase: config.phrase, variants: config.variants ?? [] });
    if (this.unsupportedPhrase === config.phrase) throw new Error("This wake phrase is not supported by the bundled model.");
    if (this.deferValidation && this.starts.length > 1) {
      this.validationStarted = true;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const error = new Error("cancelled");
          error.name = "AbortError";
          reject(error);
        };
        if (config.signal?.aborted) onAbort();
        else config.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    const session = this.starts.length === 1 ? this.primary : new FakeRuntimeSession();
    this.sessions.push(session);
    return session;
  }
  async dispose(): Promise<void> {}
}

class FakeTranscription {
  calls = 0;
  readonly #values: string[];
  constructor(values: string[]) { this.#values = values; }
  async health() { return { ready: true }; }
  async transcribe(): Promise<string> {
    const value = this.#values[this.calls++];
    assert.notEqual(value, undefined);
    return value!;
  }
}

verifyCollectorUsesPreRollAndRejectsSilence();
await verifyTenLocalSamplesMergeEditableTextInterpretations();
await verifyCancelWinsStartupAndSaveRaces();
await verifyUnsupportedPrimaryPhraseIsNotSaved();
await verifyResumeFailureDoesNotLatchSaving();
await verifyFrameWriteFailureEndsSetup();
await verifyCancelledTranscriptionCannotAffectRestartedSetup();
await verifyCancelWinsFinalSampleShutdown();
await verifyFailureWinsLateTranscription();
await verifyResetRemovesAliasesBeforeWakeResumes();
await verifyIdleResetAwaitsWakeReconfiguration();

console.log("wake phrase calibration behavior verified");

function frame(value: number): VoicePcmFrame {
  return { sampleRate: 16_000, channels: 1, format: "f32", samples: new Float32Array(320).fill(value), capturedAt: Date.now() };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for calibration state.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function recordTenSamples(service: VoiceWakeCalibrationService, capture: FakeCapture, runtime: FakeRuntimeSession): Promise<void> {
  for (let sample = 0; sample < 10; sample += 1) {
    capture.emit(frame(0.15));
    runtime.emit({ version: 2, type: "vad", state: "speech-start", score: 1 });
    for (let index = 0; index < 10; index += 1) capture.emit(frame(0.15));
    runtime.emit({ version: 2, type: "vad", state: "speech-end", score: 1 });
    await waitFor(() => service.snapshot().completedSamples === sample + 1);
  }
}

function tenTranscripts(): string[] {
  return ["Hey pay drill", "A pay drill", ...Array.from({ length: 8 }, () => "Hey Pedro")];
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
