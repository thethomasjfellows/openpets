import { encodePcm16Wav } from "./voice-audio.js";
import { getVoiceSettings, updateVoiceSettings } from "./voice-settings.js";
import { VoiceWakeCalibrationCollector } from "./voice-wake-calibration-collector.js";
import {
  canonicalWakeText,
  mergeWakeInterpretations,
  normalizeWakeInterpretations,
  normalizeWakeTranscript,
  selectRuntimeWakeVariants,
} from "./voice-wake-calibration-normalization.js";
import { normalizeVoiceWakePhrase } from "./voice-wake-helper-protocol.js";
import type { VoiceWakeCaptureSource, VoiceWakePcmSession, VoiceWakeRuntime, VoiceWakeRuntimeSession } from "./voice-wake-runtime.js";

export type VoiceWakeCalibrationState = "idle" | "preparing" | "listening" | "transcribing" | "review" | "saving" | "complete" | "error";
export type VoiceWakeCalibrationSnapshot = {
  readonly state: VoiceWakeCalibrationState;
  readonly phrase: string;
  readonly completedSamples: number;
  readonly requiredSamples: 10;
  readonly attempts: number;
  readonly maximumAttempts: 40;
  readonly detectedSamples: number;
  readonly calibrated: boolean;
  readonly batchInterpretations?: readonly string[];
  readonly savedInterpretations?: readonly string[];
  readonly activeRuntimeInterpretations?: readonly string[];
  readonly lastPcmRms?: number;
  readonly lastPcmFrameAt?: number;
  readonly skippedInterpretations?: number;
  readonly reason?: string;
};

type LocalCalibrationTranscription = {
  health(): Promise<{ readonly ready: boolean; readonly reason?: string }>;
  transcribe(audio: Uint8Array, mimeType: string, signal?: AbortSignal): Promise<string>;
};

type CalibrationWakeCoordinator = {
  suspendForExternalCapture(reason: string): Promise<() => Promise<void>>;
};

const requiredSamples = 10 as const;
const maximumAttempts = 40;

export class VoiceWakeCalibrationService {
  readonly #capture: VoiceWakeCaptureSource;
  readonly #runtime: VoiceWakeRuntime;
  readonly #transcription: LocalCalibrationTranscription;
  readonly #wake: CalibrationWakeCoordinator;
  readonly #now: () => number;
  readonly #log: (level: "info" | "warn", message: string, fields?: Record<string, unknown>) => void;
  #state: VoiceWakeCalibrationState = "idle";
  #phrase = "";
  #transcripts: string[] = [];
  #acceptedSamples = 0;
  #detectedSamples = 0;
  #keywordDetectedForAttempt = false;
  #skippedInterpretations = 0;
  #reason: string | undefined;
  #collector = new VoiceWakeCalibrationCollector();
  #controller: AbortController | null = null;
  #captureSession: VoiceWakePcmSession | null = null;
  #runtimeSession: VoiceWakeRuntimeSession | null = null;
  #unsubscribeFrame: (() => void) | null = null;
  #unsubscribeRuntime: (() => void) | null = null;
  #unsubscribeEnded: (() => void) | null = null;
  #releaseWake: (() => Promise<void>) | null = null;
  #saveController: AbortController | null = null;
  #generation = 0;
  #processing = false;
  #lastPcmRms: number | undefined;
  #lastPcmFrameAt: number | undefined;

  constructor(input: {
    readonly capture: VoiceWakeCaptureSource;
    readonly runtime: VoiceWakeRuntime;
    readonly transcription: LocalCalibrationTranscription;
    readonly wake: CalibrationWakeCoordinator;
    readonly now?: () => number;
    readonly log?: (level: "info" | "warn", message: string, fields?: Record<string, unknown>) => void;
  }) {
    this.#capture = input.capture;
    this.#runtime = input.runtime;
    this.#transcription = input.transcription;
    this.#wake = input.wake;
    this.#now = input.now ?? Date.now;
    this.#log = input.log ?? (() => undefined);
  }

  snapshot(): VoiceWakeCalibrationSnapshot {
    const settings = getVoiceSettings().wake;
    const calibrated = Boolean(settings.calibration && canonicalWakeText(settings.calibration.phrase) === canonicalWakeText(settings.phrase));
    const batchInterpretations = this.#state === "review" || this.#state === "saving"
      ? normalizeWakeInterpretations(this.#phrase, this.#transcripts)
      : undefined;
    const savedInterpretations = calibrated ? settings.calibration?.variants ?? [] : [];
    const activeRuntimeInterpretations = selectRuntimeWakeVariants(settings.phrase, savedInterpretations);
    return {
      state: this.#state,
      phrase: this.#phrase || settings.phrase,
      completedSamples: this.#acceptedSamples,
      requiredSamples,
      attempts: this.#collector.attempts,
      maximumAttempts,
      detectedSamples: this.#detectedSamples,
      calibrated,
      ...(batchInterpretations ? { batchInterpretations } : {}),
      savedInterpretations,
      activeRuntimeInterpretations,
      ...(this.#lastPcmRms !== undefined ? { lastPcmRms: this.#lastPcmRms } : {}),
      ...(this.#lastPcmFrameAt !== undefined ? { lastPcmFrameAt: this.#lastPcmFrameAt } : {}),
      ...(this.#skippedInterpretations ? { skippedInterpretations: this.#skippedInterpretations } : {}),
      ...(this.#reason ? { reason: this.#reason } : {}),
    };
  }

  async start(rawPhrase: unknown): Promise<VoiceWakeCalibrationSnapshot> {
    if (this.#controller || this.#saveController || !["idle", "error", "complete"].includes(this.#state)) {
      throw new Error("Finish or cancel the current wake phrase setup first.");
    }
    const phrase = normalizeVoiceWakePhrase(rawPhrase);
    if (!phrase) throw new Error("Enter the wake phrase you want to teach first.");
    this.#state = "preparing";
    this.#phrase = phrase;
    this.#transcripts = [];
    this.#acceptedSamples = 0;
    this.#detectedSamples = 0;
    this.#keywordDetectedForAttempt = false;
    this.#skippedInterpretations = 0;
    this.#reason = undefined;
    this.#collector = new VoiceWakeCalibrationCollector();
    this.#processing = false;
    this.#lastPcmRms = undefined;
    this.#lastPcmFrameAt = undefined;
    const controller = new AbortController();
    const generation = ++this.#generation;
    this.#controller = controller;
    let releaseWake: (() => Promise<void>) | null = null;
    let captureSession: VoiceWakePcmSession | null = null;
    let runtimeSession: VoiceWakeRuntimeSession | null = null;
    try {
      const health = await this.#transcription.health();
      this.#assertCurrent(generation, controller.signal);
      if (!health.ready) throw new Error(health.reason ?? "Download built-in speech recognition before wake phrase setup.");
      releaseWake = await this.#wake.suspendForExternalCapture("wake-calibration");
      this.#assertCurrent(generation, controller.signal);
      this.#releaseWake = releaseWake;
      const microphone = getVoiceSettings().wake.microphone;
      captureSession = await this.#capture.startWakePcmStream({
        frameMs: 20,
        owner: "wake-calibration",
        ...(microphone ? { microphone } : {}),
        signal: controller.signal,
      });
      this.#assertCurrent(generation, controller.signal);
      this.#captureSession = captureSession;
      this.#log("info", "wake phrase calibration microphone live", {
        microphoneResolved: captureSession.microphone?.usedDefault === false ? "saved-device" : "system-default",
        fallbackReason: captureSession.microphone?.fallbackReason,
      });
      const savedCalibration = getVoiceSettings().wake.calibration;
      const savedInterpretations = savedCalibration && canonicalWakeText(savedCalibration.phrase) === canonicalWakeText(phrase)
        ? savedCalibration.variants
        : [];
      runtimeSession = await this.#runtime.start({
        engine: "custom-sherpa",
        phrase,
        variants: selectRuntimeWakeVariants(phrase, savedInterpretations),
        signal: controller.signal,
      });
      this.#assertCurrent(generation, controller.signal);
      this.#runtimeSession = runtimeSession;
      const activeRuntimeSession = runtimeSession;
      this.#unsubscribeFrame = captureSession.onFrame((frame) => {
        if (generation !== this.#generation) return;
        let squareSum = 0;
        for (const sample of frame.samples) squareSum += sample * sample;
        this.#lastPcmRms = Math.sqrt(squareSum / Math.max(1, frame.samples.length));
        this.#lastPcmFrameAt = this.#now();
        if (!this.#processing) this.#collector.ingest(frame);
        try {
          activeRuntimeSession.sendFrame(frame);
        } catch (error) {
          void this.#fail(error, generation);
        }
      });
      this.#unsubscribeEnded = captureSession.onEnded?.((reason) => { void this.#fail(new Error(`Microphone capture ended: ${reason}`), generation); }) ?? null;
      this.#unsubscribeRuntime = activeRuntimeSession.onEvent((event) => {
        if (generation !== this.#generation) return;
        if (event.type === "error") void this.#fail(new Error(event.message), generation);
        else if (event.type === "keyword" && !this.#processing) this.#keywordDetectedForAttempt = true;
        else if (event.type === "vad" && !this.#processing) void this.#handleVad(event.state, generation);
      });
      this.#state = "listening";
      this.#log("info", "wake phrase calibration started", { phraseCharacters: phrase.length });
      return this.snapshot();
    } catch (error) {
      if (generation === this.#generation && !isAbortError(error)) {
        await this.#fail(error, generation);
      } else {
        await Promise.allSettled([
          runtimeSession?.stop(),
          captureSession?.stop("wake-calibration-stale-start"),
        ].filter((value): value is Promise<void> => Boolean(value)));
        if (this.#releaseWake === releaseWake) this.#releaseWake = null;
        try { await releaseWake?.(); } catch { /* cancellation cleanup is best effort */ }
      }
      throw error;
    }
  }

  async cancel(): Promise<VoiceWakeCalibrationSnapshot> {
    return this.#cancelSetup(true);
  }

  async #cancelSetup(releaseWake: boolean): Promise<VoiceWakeCalibrationSnapshot> {
    this.#generation += 1;
    this.#saveController?.abort();
    this.#saveController = null;
    await this.#stopSessions();
    if (releaseWake) await this.#releaseWakeListening();
    this.#state = "idle";
    this.#phrase = getVoiceSettings().wake.phrase;
    this.#skippedInterpretations = 0;
    this.#reason = undefined;
    this.#transcripts = [];
    this.#acceptedSamples = 0;
    this.#detectedSamples = 0;
    this.#keywordDetectedForAttempt = false;
    this.#collector = new VoiceWakeCalibrationCollector();
    this.#processing = false;
    this.#lastPcmRms = undefined;
    this.#lastPcmFrameAt = undefined;
    return this.snapshot();
  }

  async save(): Promise<VoiceWakeCalibrationSnapshot> {
    if (this.#state !== "review" || this.#transcripts.length < requiredSamples) throw new Error("Record all ten wake phrase samples before saving.");
    const generation = ++this.#generation;
    const controller = new AbortController();
    this.#saveController = controller;
    this.#state = "saving";
    try {
      const candidates = normalizeWakeInterpretations(this.#phrase, this.#transcripts);
      const supported: string[] = [];
      for (const candidate of candidates) {
        this.#assertCurrent(generation, controller.signal);
        try {
          await this.#validatePhrase(candidate, [], controller.signal);
          supported.push(candidate);
        } catch (error) {
          if (isAbortError(error)) throw error;
          this.#log("warn", "wake calibration variant skipped", { reason: cleanError(error) });
        }
      }
      this.#assertCurrent(generation, controller.signal);
      const current = getVoiceSettings().wake.calibration;
      const existing = current && canonicalWakeText(current.phrase) === canonicalWakeText(this.#phrase)
        ? current.variants
        : [];
      const merged = mergeWakeInterpretations(this.#phrase, supported, existing);
      const active = selectRuntimeWakeVariants(this.#phrase, merged);
      await this.#validatePhrase(this.#phrase, active, controller.signal);
      this.#assertCurrent(generation, controller.signal);
      this.#skippedInterpretations = candidates.length - supported.length;
      updateVoiceSettings({ wake: { calibration: { phrase: this.#phrase, variants: merged, updatedAt: this.#now() } } });
      this.#state = "complete";
      await this.#releaseWakeListening();
      this.#log("info", "wake phrase interpretations saved", {
        batch: supported.length,
        saved: merged.length,
        active: active.length,
        skipped: this.#skippedInterpretations,
      });
      return this.snapshot();
    } catch (error) {
      if (generation === this.#generation && !isAbortError(error)) await this.#fail(error, generation);
      throw error;
    } finally {
      if (this.#saveController === controller) this.#saveController = null;
    }
  }

  async deleteInterpretation(rawValue: unknown): Promise<VoiceWakeCalibrationSnapshot> {
    if (this.#controller || this.#saveController || !["idle", "complete", "error"].includes(this.#state)) {
      throw new Error("Finish or cancel the current recording batch first.");
    }
    const value = normalizeWakeTranscript(rawValue);
    if (!value) throw new Error("Choose a saved interpretation to delete.");
    const settings = getVoiceSettings().wake;
    const calibration = settings.calibration;
    if (!calibration || canonicalWakeText(calibration.phrase) !== canonicalWakeText(settings.phrase)) return this.snapshot();
    const remaining = normalizeWakeInterpretations(
      settings.phrase,
      calibration.variants.filter((candidate) => canonicalWakeText(candidate) !== canonicalWakeText(value)),
    );
    if (remaining.length === calibration.variants.length) return this.snapshot();
    const releaseWake = await this.#wake.suspendForExternalCapture("wake-calibration-delete-interpretation");
    try {
      updateVoiceSettings({ wake: { calibration: { phrase: settings.phrase, variants: remaining, updatedAt: this.#now() } } });
    } finally {
      await releaseWake();
    }
    this.#phrase = settings.phrase;
    this.#state = "complete";
    this.#log("info", "wake phrase interpretation deleted", { saved: remaining.length });
    return this.snapshot();
  }

  async reset(): Promise<VoiceWakeCalibrationSnapshot> {
    await this.#cancelSetup(false);
    if (!this.#releaseWake) {
      this.#releaseWake = await this.#wake.suspendForExternalCapture("wake-calibration-reset");
    }
    try {
      updateVoiceSettings({ wake: { calibration: undefined } });
    } finally {
      await this.#releaseWakeListening();
    }
    this.#phrase = getVoiceSettings().wake.phrase;
    return this.snapshot();
  }

  async dispose(): Promise<void> {
    await this.cancel();
  }

  async #handleVad(state: "speech-start" | "speech-end", generation: number): Promise<void> {
    if (generation !== this.#generation) return;
    if (state === "speech-start" && this.#collector.attempts >= maximumAttempts) {
      await this.#fail(new Error("Wake phrase setup stopped after too many attempts. Try again in a quieter place."), generation);
      return;
    }
    const samples = this.#collector.vad(state);
    if (state === "speech-start") {
      return;
    }
    if (!samples) {
      this.#keywordDetectedForAttempt = false;
      if (this.#collector.attempts >= maximumAttempts) await this.#fail(new Error("Wake phrase setup could not hear ten clear samples."), generation);
      return;
    }
    const signal = this.#controller?.signal;
    if (!signal) {
      await this.#fail(new Error("Wake phrase setup stopped before transcription could begin."), generation);
      return;
    }
    this.#processing = true;
    const keywordDetected = this.#keywordDetectedForAttempt;
    this.#keywordDetectedForAttempt = false;
    this.#state = "transcribing";
    try {
      const capture = encodePcm16Wav(samples);
      const transcript = normalizeWakeTranscript(await this.#transcription.transcribe(capture.bytes, capture.mimeType, signal));
      if (generation !== this.#generation || signal.aborted) throw abortError();
      if (transcript) {
        this.#transcripts.push(transcript);
        this.#acceptedSamples += 1;
        if (keywordDetected) this.#detectedSamples += 1;
      }
      if (this.#acceptedSamples >= requiredSamples) {
        await this.#stopSessions();
        if (generation !== this.#generation) return;
        this.#state = "review";
      } else if (this.#collector.attempts >= maximumAttempts) {
        await this.#fail(new Error("Wake phrase setup could not hear ten clear samples."), generation);
      } else {
        this.#state = "listening";
      }
    } catch (error) {
      if (!isAbortError(error)) await this.#fail(error, generation);
    } finally {
      if (generation === this.#generation) {
        this.#processing = false;
        this.#collector.resetUtterance();
        this.#runtimeSession?.reset();
      }
    }
  }

  async #fail(error: unknown, generation = this.#generation): Promise<void> {
    if (generation !== this.#generation) return;
    this.#reason = cleanError(error);
    this.#log("warn", "wake phrase calibration failed", { reason: this.#reason });
    await this.#stopSessions();
    await this.#releaseWakeListening();
    if (generation === this.#generation) this.#state = "error";
  }

  async #stopSessions(): Promise<void> {
    const controller = this.#controller;
    this.#controller = null;
    controller?.abort();
    this.#unsubscribeFrame?.();
    this.#unsubscribeFrame = null;
    this.#unsubscribeRuntime?.();
    this.#unsubscribeRuntime = null;
    this.#unsubscribeEnded?.();
    this.#unsubscribeEnded = null;
    const capture = this.#captureSession;
    const runtime = this.#runtimeSession;
    this.#captureSession = null;
    this.#runtimeSession = null;
    await Promise.allSettled([capture?.stop("wake-calibration-stopped"), runtime?.stop()].filter((value): value is Promise<void> => Boolean(value)));
  }

  async #releaseWakeListening(): Promise<void> {
    const release = this.#releaseWake;
    this.#releaseWake = null;
    try {
      await release?.();
    } catch (error) {
      this.#log("warn", "wake listening could not resume after setup", { reason: cleanError(error) });
    }
  }

  async #validatePhrase(phrase: string, variants: readonly string[], signal: AbortSignal): Promise<void> {
    const session = await this.#runtime.start({ engine: "custom-sherpa", phrase, variants, signal });
    try {
      this.#assertCurrent(this.#generation, signal);
    } finally {
      await session.stop();
    }
  }

  #assertCurrent(generation: number, signal: AbortSignal): void {
    if (generation !== this.#generation || signal.aborted) throw abortError();
  }
}

export { normalizeWakeInterpretations as normalizeCalibrationVariants } from "./voice-wake-calibration-normalization.js";

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/(?:[A-Za-z]:\\|\/)[^\s]+/g, "local file").trim().slice(0, 300) || "Wake phrase setup failed.";
}

function abortError(): Error {
  const error = new Error("Wake phrase setup was cancelled.");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
