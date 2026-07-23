import { getCompanionSettings, onCompanionSettingsChanged } from "./companion-settings.js";
import { encodePcm16Wav, type VoiceFiniteAudioCapture } from "./voice-audio.js";
import { canonicalWakeText, getVoiceSettings, onVoiceSettingsChanged } from "./voice-settings.js";
import { selectRuntimeWakeVariants } from "./voice-wake-calibration-normalization.js";
import { VoiceWakeActivation, type FinalizedVoiceUtterance } from "./voice-wake-activation.js";
import { isValidVoiceWakePcmFrame, normalizeVoiceWakePhrase, sanitizeVoiceWakeMessage, type VoiceWakeHelperEvent } from "./voice-wake-helper-protocol.js";
import {
  UnavailableVoiceWakeRuntime,
  type VoiceWakeCaptureSource,
  type VoiceWakePcmSession,
  type VoiceWakeRuntime,
  type VoiceWakeRuntimeSelection,
  type VoiceWakeRuntimeSession,
} from "./voice-wake-runtime.js";
import type { VoiceOutputActivitySnapshot } from "./voice-output-service.js";
import type {
  VoiceWakeHealth,
  VoiceWakePowerEvent,
  VoiceWakeSnapshot,
  VoiceWakeSensitivity,
} from "./voice-wake-types.js";
import { officialVoiceWakePhrase, officialVoiceWakePhraseId } from "./voice-wake-types.js";

export type { VoiceWakeHealth, VoiceWakeSnapshot } from "./voice-wake-types.js";

type WakeTranscription = {
  health?(): Promise<{ readonly ready: boolean; readonly reason?: string }>;
  transcribe(capture: VoiceFiniteAudioCapture, signal?: AbortSignal): Promise<string>;
};

type WakePrivacyIndicator = {
  trackStarted(): void;
  trackStopped(): void;
};

type WakeCompanion = {
  sendUserTurn(request: { readonly petId: string; readonly text: string; readonly kind: "voice"; readonly speak: true }): Promise<unknown>;
  cancel(petId: string): void;
};

type WakeOutput = {
  getActivitySnapshot(): VoiceOutputActivitySnapshot;
  onActivityChanged(listener: (snapshot: VoiceOutputActivitySnapshot) => void): () => void;
};

type WakeAcknowledgement = {
  showListening(input: { readonly petId: string; readonly phrase: string; readonly followUp: boolean; readonly completedText?: string }): void;
  showThinking(input: { readonly petId: string }): void;
  clearListening(input: { readonly petId: string; readonly clearBubble: boolean }): void;
};

type WakePresentationOwnership = {
  acquire(): () => void;
};

type WakeCompanionSettings = {
  readonly enabled: boolean;
  readonly wake: { readonly enabled: boolean; readonly followUpEnabled?: boolean };
};

type WakeVoiceSettings = {
  readonly wake: {
    readonly engine?: "official-livekit" | "custom-sherpa";
    readonly phraseId?: typeof officialVoiceWakePhraseId;
    readonly phrase: string;
    readonly sensitivity?: VoiceWakeSensitivity;
    readonly microphone?: { readonly deviceId: string; readonly label?: string };
    readonly calibration?: { readonly phrase: string; readonly variants: readonly string[] };
  };
};

export type VoiceWakeWordServiceOptions = {
  readonly runtime?: VoiceWakeRuntime;
  readonly capture?: VoiceWakeCaptureSource;
  readonly transcription?: WakeTranscription;
  readonly companion?: WakeCompanion;
  readonly output?: WakeOutput;
  readonly privacyIndicator?: WakePrivacyIndicator;
  readonly acknowledgement?: WakeAcknowledgement;
  readonly presentation?: WakePresentationOwnership;
  readonly presentationHoldMs?: number;
  readonly activationTimeoutMs?: number;
  readonly followUpTimeoutMs?: number;
  readonly getCompanionSettings?: () => WakeCompanionSettings;
  readonly getVoiceSettings?: () => WakeVoiceSettings;
  readonly subscribeCompanionSettings?: (listener: () => void) => () => void;
  readonly subscribeVoiceSettings?: (listener: () => void) => () => void;
  readonly getDefaultPetId?: () => string;
  readonly now?: () => number;
  readonly log?: (level: "debug" | "info" | "warn", message: string, fields?: Record<string, unknown>) => void;
};

type WakeMutableState = Omit<VoiceWakeSnapshot, "checkedAt" | "phraseConfigured" | "diagnostics">;
type WakeDiagnostics = NonNullable<VoiceWakeSnapshot["diagnostics"]>;

const cooldownMs = 750;
const activationTimeoutMs = 8_000;
export const defaultFollowUpTimeoutMs = 5_000;

export class VoiceWakeWordService {
  readonly #runtime: VoiceWakeRuntime;
  readonly #capture?: VoiceWakeCaptureSource;
  readonly #transcription?: WakeTranscription;
  readonly #companion?: WakeCompanion;
  readonly #output?: WakeOutput;
  readonly #privacyIndicator?: WakePrivacyIndicator;
  readonly #acknowledgement?: WakeAcknowledgement;
  readonly #presentation?: WakePresentationOwnership;
  readonly #presentationHoldMs: number;
  readonly #activationTimeoutMs: number;
  readonly #followUpTimeoutMs: number;
  readonly #getCompanionSettings: () => WakeCompanionSettings;
  readonly #getVoiceSettings: () => WakeVoiceSettings;
  readonly #getDefaultPetId: () => string;
  readonly #now: () => number;
  readonly #log: NonNullable<VoiceWakeWordServiceOptions["log"]>;

  #state: WakeMutableState = {
    enabled: false,
    armed: false,
    captureState: "blocked",
    turnState: "idle",
  };
  #activation = new VoiceWakeActivation({ cooldownMs });
  #captureSession: VoiceWakePcmSession | null = null;
  #runtimeSession: VoiceWakeRuntimeSession | null = null;
  #sessionController: AbortController | null = null;
  #turnController: AbortController | null = null;
  #unsubscribeFrame: (() => void) | null = null;
  #unsubscribeCaptureEnded: (() => void) | null = null;
  #unsubscribeRuntime: (() => void) | null = null;
  #unsubscribeOutput: (() => void) | null = null;
  #unsubscribeSettings: Array<() => void> = [];
  #cooldownTimer: NodeJS.Timeout | null = null;
  #activationTimer: NodeJS.Timeout | null = null;
  #followUpTimer: NodeJS.Timeout | null = null;
  #startPromise: Promise<VoiceWakeSnapshot> | null = null;
  #activePhrase: string | null = null;
  #activeVariantsKey = "";
  #activeRuntimeKey = "";
  #activeMicrophoneDeviceId = "";
  #generation = 0;
  #powerBlockers = new Set<"suspend" | "lock">();
  #externalCaptureCount = 0;
  #diagnostics: WakeDiagnostics = { pcmFramesReceived: 0 };
  #lastPcmLogAt = 0;
  #commandPrivacyActive = false;
  #vadSpeechActive = false;
  #listeningAckPetId: string | null = null;
  #releasePresentation: (() => void) | null = null;
  #presentationReleaseTimer: NodeJS.Timeout | null = null;
  #queuedTurn: { readonly capture: VoiceFiniteAudioCapture; readonly generation: number } | null = null;
  #pendingFollowUpAfterTurn = false;
  #completedResponseText = "";

  constructor(options: VoiceWakeWordServiceOptions = {}) {
    this.#runtime = options.runtime ?? new UnavailableVoiceWakeRuntime();
    this.#capture = options.capture;
    this.#transcription = options.transcription;
    this.#companion = options.companion;
    this.#output = options.output;
    this.#privacyIndicator = options.privacyIndicator;
    this.#acknowledgement = options.acknowledgement;
    this.#presentation = options.presentation;
    this.#presentationHoldMs = Math.max(0, Math.min(30_000, Math.round(options.presentationHoldMs ?? 12_000)));
    this.#activationTimeoutMs = Math.max(10, Math.min(60_000, Math.round(options.activationTimeoutMs ?? activationTimeoutMs)));
    this.#followUpTimeoutMs = Math.max(10, Math.min(10_000, Math.round(options.followUpTimeoutMs ?? defaultFollowUpTimeoutMs)));
    this.#getCompanionSettings = options.getCompanionSettings ?? getCompanionSettings;
    this.#getVoiceSettings = options.getVoiceSettings ?? getVoiceSettings;
    this.#getDefaultPetId = options.getDefaultPetId ?? (() => { throw new Error("Default pet resolution is not available in this build."); });
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (() => undefined);
    const subscribeCompanionSettings = options.subscribeCompanionSettings
      ?? (options.getCompanionSettings ? null : onCompanionSettingsChanged);
    const subscribeVoiceSettings = options.subscribeVoiceSettings
      ?? (options.getVoiceSettings ? null : onVoiceSettingsChanged);
    const syncAfterSettingsChange = () => {
      void this.syncFromSettings().catch(() => undefined);
    };
    if (subscribeCompanionSettings) this.#unsubscribeSettings.push(subscribeCompanionSettings(syncAfterSettingsChange));
    if (subscribeVoiceSettings) this.#unsubscribeSettings.push(subscribeVoiceSettings(syncAfterSettingsChange));
    const runtimeHealth = this.#runtime.health();
    this.#state = {
      ...this.#state,
      captureState: runtimeHealth.ready ? "disabled" : "blocked",
      ...(runtimeHealth.reason ? { reason: cleanError(runtimeHealth.reason) } : {}),
    };
  }

  health(): VoiceWakeHealth {
    const runtime = this.#runtime.health(this.#resolveRuntimeSelection());
    const pipelineReady = Boolean(this.#capture && this.#transcription && this.#companion && this.#output);
    const requestedAndBlocked = this.#getCompanionSettings().wake.enabled && this.#state.captureState === "blocked";
    const reason = runtime.reason
      ? cleanError(runtime.reason)
      : (!pipelineReady
          ? "Wake word capture is not available in this build."
          : (requestedAndBlocked ? this.#state.reason : undefined));
    return {
      checkedAt: this.#now(),
      ready: runtime.ready && pipelineReady && !requestedAndBlocked,
      enabled: this.#state.enabled,
      method: runtime.method,
      ...(reason ? { reason } : {}),
    };
  }

  snapshot(): VoiceWakeSnapshot {
    return {
      checkedAt: this.#now(),
      ...this.#state,
      phraseConfigured: normalizeVoiceWakePhrase(this.#getVoiceSettings().wake.phrase).length > 0,
      diagnostics: { ...this.#diagnostics },
    };
  }

  async syncFromSettings(): Promise<VoiceWakeSnapshot> {
    if (this.#powerBlockers.size > 0) return this.snapshot();
    if (this.#externalCaptureCount > 0) {
      this.#state = {
        enabled: false,
        armed: false,
        captureState: "suspended",
        turnState: "idle",
        reason: "Wake listening is paused while another voice activity uses the microphone.",
      };
      return this.snapshot();
    }
    const eligibility = this.#eligibility();
    this.#log("info", "wake settings evaluated", {
      ready: eligibility.ready,
      blocked: eligibility.blocked,
      phraseConfigured: Boolean(eligibility.phrase),
      reason: eligibility.reason,
    });
    if (!eligibility.ready) {
      const stopGeneration = await this.#stopSessions("settings-ineligible");
      if (this.#generation !== stopGeneration) return this.snapshot();
      this.#state = {
        enabled: false,
        armed: false,
        captureState: eligibility.blocked ? "blocked" : "disabled",
        turnState: "idle",
        ...(eligibility.reason ? { reason: eligibility.reason } : {}),
      };
      return this.snapshot();
    }
    const started = await this.start();
    const latest = this.#eligibility();
    if (latest.ready && this.#activeRuntimeKey !== latest.runtimeKey) {
      return this.start();
    }
    return started;
  }

  start(): Promise<VoiceWakeSnapshot> {
    if (this.#startPromise) return this.#startPromise;
    const start = this.#startOnce();
    this.#startPromise = start;
    void start.finally(() => {
      if (this.#startPromise === start) this.#startPromise = null;
    }).catch(() => undefined);
    return start;
  }

  async #startOnce(): Promise<VoiceWakeSnapshot> {
    const eligibility = this.#eligibility();
    if (
      this.#state.armed &&
      this.#captureSession &&
      this.#runtimeSession &&
      this.#activePhrase === eligibility.phrase &&
      this.#activeRuntimeKey === eligibility.runtimeKey &&
      this.#activeMicrophoneDeviceId === microphoneKey(eligibility.microphone)
    ) {
      return this.snapshot();
    }
    if (this.#captureSession || this.#runtimeSession) {
      this.#state = { ...this.#state, armed: false, captureState: "stopping" };
      const stopGeneration = await this.#stopSessions("wake-phrase-changed");
      if (this.#generation !== stopGeneration) return this.snapshot();
    }
    if (!eligibility.ready || !this.#capture || !this.#transcription || !this.#companion || !this.#output) {
      const reason = eligibility.reason ?? "Wake word capture is not available in this build.";
      this.#state = {
        enabled: false,
        armed: false,
        captureState: eligibility.blocked ? "blocked" : "disabled",
        turnState: "idle",
        reason,
      };
      throw new Error(reason);
    }

    if (this.#externalCaptureCount > 0) throw abortError();
    if (this.#transcription.health) {
      const healthGeneration = this.#generation;
      const transcriptionHealth = await this.#transcription.health();
      if (this.#generation !== healthGeneration || this.#externalCaptureCount > 0) throw abortError();
      if (!transcriptionHealth.ready) {
        const reason = transcriptionHealth.reason ?? "Speech recognition is not ready.";
        this.#state = {
          enabled: false,
          armed: false,
          captureState: "blocked",
          turnState: "idle",
          reason,
        };
        throw new Error(reason);
      }
    }

    const output = this.#output;
    const generation = ++this.#generation;
    const controller = new AbortController();
    this.#sessionController = controller;
    this.#state = { enabled: true, armed: false, captureState: "starting-capture", turnState: "idle" };
    this.#diagnostics = { pcmFramesReceived: 0 };
    this.#lastPcmLogAt = 0;
    this.#log("info", "wake microphone capture requested", {
      phraseConfigured: true,
      activeVariantCount: eligibility.variants.length,
      microphoneRequested: eligibility.microphone ? "saved-device" : "system-default",
      generation,
    });

    let captureSession: VoiceWakePcmSession | null = null;
    let runtimeSession: VoiceWakeRuntimeSession | null = null;
    try {
      captureSession = await this.#capture.startWakePcmStream({
        frameMs: 20,
        ...(eligibility.microphone ? { microphone: eligibility.microphone } : {}),
        signal: controller.signal,
      });
      if (generation !== this.#generation || controller.signal.aborted) throw abortError();
      this.#diagnostics = { ...this.#diagnostics, captureStartedAt: captureSession.startedAt };
      this.#log("info", "wake microphone capture live", {
        generation,
        frameMs: 20,
        microphoneResolved: captureSession.microphone?.usedDefault === false ? "saved-device" : "system-default",
        fallbackReason: captureSession.microphone?.fallbackReason,
      });
      this.#state = { ...this.#state, captureState: "starting-helper" };
      this.#log("info", "wake helper start requested", { generation });
      runtimeSession = await this.#runtime.start({ ...eligibility.selection, signal: controller.signal });
      if (generation !== this.#generation || controller.signal.aborted) throw abortError();
      this.#diagnostics = { ...this.#diagnostics, helperStartedAt: this.#now() };
      this.#log("info", "wake helper ready", { generation, activeVariantCount: eligibility.variants.length });

      this.#captureSession = captureSession;
      this.#runtimeSession = runtimeSession;
      this.#activePhrase = eligibility.phrase;
      this.#activeVariantsKey = eligibility.variants.join("\n");
      this.#activeRuntimeKey = eligibility.runtimeKey;
      this.#activeMicrophoneDeviceId = microphoneKey(eligibility.microphone);
      this.#unsubscribeFrame = captureSession.onFrame((frame) => this.#handleFrame(frame, generation));
      this.#unsubscribeCaptureEnded = captureSession.onEnded?.((reason) => {
        if (generation !== this.#generation) return;
        void this.#failRuntime(new Error("Wake microphone ended unexpectedly: " + reason), generation);
      }) ?? null;
      this.#unsubscribeRuntime = runtimeSession.onEvent((event) => this.#handleRuntimeEvent(event, generation));
      this.#unsubscribeOutput = output.onActivityChanged((activity) => this.#handleOutputActivity(activity));
      this.#state = { enabled: true, armed: true, captureState: "armed", turnState: "idle" };
      this.#handleOutputActivity(output.getActivitySnapshot());
      return this.snapshot();
    } catch (error) {
      const stale = generation !== this.#generation || controller.signal.aborted;
      controller.abort();
      await Promise.allSettled([
        runtimeSession?.stop(),
        captureSession?.stop("wake-start-failed"),
      ].filter((item): item is Promise<void> => Boolean(item)));
      if (this.#sessionController === controller) this.#sessionController = null;
      if (!stale) {
        const reason = cleanError(error);
        this.#diagnostics = { ...this.#diagnostics, lastError: reason };
        this.#log("warn", "wake listening failed to start", { generation, reason });
        this.#state = { enabled: false, armed: false, captureState: "error", turnState: "idle", reason };
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    const wasLive = this.#captureSession !== null || this.#runtimeSession !== null;
    if (wasLive) this.#state = { ...this.#state, armed: false, captureState: "stopping" };
    const stopGeneration = await this.#stopSessions("wake-stopped");
    if (this.#generation !== stopGeneration) return;
    this.#state = { enabled: false, armed: false, captureState: "disabled", turnState: "idle" };
  }

  async handlePowerEvent(event: VoiceWakePowerEvent): Promise<void> {
    if (event === "suspend" || event === "lock") {
      this.#powerBlockers.add(event);
      const stopGeneration = await this.#stopSessions(event);
      if (this.#generation !== stopGeneration) return;
      this.#state = { enabled: false, armed: false, captureState: "suspended", turnState: "idle" };
      return;
    }
    this.#powerBlockers.delete(event === "resume" ? "suspend" : "lock");
    if (this.#powerBlockers.size > 0) {
      this.#state = { enabled: false, armed: false, captureState: "suspended", turnState: "idle" };
      return;
    }
    await this.syncFromSettings();
  }

  async suspendForExternalCapture(reason: string): Promise<() => Promise<void>> {
    this.#externalCaptureCount += 1;
    const pendingStart = this.#startPromise;
    const stopGeneration = await this.#stopSessions(reason);
    if (pendingStart) await pendingStart.catch(() => undefined);
    if (this.#generation === stopGeneration) {
      this.#state = {
        enabled: false,
        armed: false,
        captureState: "suspended",
        turnState: "idle",
        reason: "Wake listening is paused while another voice activity uses the microphone.",
      };
    }
    this.#log("info", "wake listening suspended for external capture", { reason, count: this.#externalCaptureCount });
    let resumed = false;
    return async () => {
      if (resumed) return;
      resumed = true;
      this.#externalCaptureCount = Math.max(0, this.#externalCaptureCount - 1);
      this.#log("info", "wake external capture released", { reason, count: this.#externalCaptureCount });
      if (this.#externalCaptureCount === 0) await this.syncFromSettings();
    };
  }

  async dispose(): Promise<void> {
    for (const unsubscribe of this.#unsubscribeSettings.splice(0)) unsubscribe();
    await this.stop();
    await this.#runtime.dispose();
  }

  /** Cancel the current voice turn while leaving ordinary wake listening armed. */
  cancelConversation(reason = "user"): boolean {
    if (this.#state.turnState === "idle" || this.#state.turnState === "cooldown") return false;
    const petId = this.#state.activePetId ?? this.#getDefaultPetId();
    this.#state = { ...this.#state, turnState: "idle", activePetId: undefined, reason: undefined };
    this.#clearActivationTimer();
    this.#clearFollowUpTimer();
    if (this.#cooldownTimer) clearTimeout(this.#cooldownTimer);
    this.#cooldownTimer = null;
    this.#turnController?.abort();
    this.#turnController = null;
    this.#queuedTurn = null;
    this.#pendingFollowUpAfterTurn = false;
    this.#completedResponseText = "";
    try { this.#companion?.cancel(petId); } catch { /* cancellation is best effort */ }
    this.#activation.cancel();
    this.#endCommandPrivacy();
    this.#clearWakeAcknowledgement(true, petId);
    this.#releaseConversationPresentation();
    this.#vadSpeechActive = false;
    this.#resetRuntimeOrFail(this.#generation);
    this.#log("info", "voice conversation cancelled", { reason });
    return true;
  }

  #eligibility(): { readonly ready: boolean; readonly blocked: boolean; readonly phrase: string; readonly variants: readonly string[]; readonly selection: VoiceWakeRuntimeSelection; readonly runtimeKey: string; readonly microphone?: { readonly deviceId: string; readonly label?: string }; readonly reason?: string } {
    const wakeSettings = this.#getVoiceSettings().wake;
    const phrase = normalizeVoiceWakePhrase(wakeSettings.phrase);
    const variants = wakeSettings.calibration && canonicalWakeText(wakeSettings.calibration.phrase) === canonicalWakeText(phrase)
      ? selectRuntimeWakeVariants(phrase, wakeSettings.calibration.variants)
      : [];
    const selection = this.#resolveRuntimeSelection();
    const runtimeKey = selection.engine === "official-livekit"
      ? `${selection.engine}:${selection.phraseId}:${selection.sensitivity}`
      : `${selection.engine}:${selection.phrase}:${(selection.variants ?? []).join("\n")}`;
    const runtime = this.#runtime.health(selection);
    const microphone = wakeSettings.microphone;
    const common = { phrase, variants, selection, runtimeKey, ...(microphone ? { microphone } : {}) };
    if (!runtime.ready) return { ready: false, blocked: true, ...common, ...(runtime.reason ? { reason: cleanError(runtime.reason) } : {}) };
    const companion = this.#getCompanionSettings();
    if (!companion.enabled) return { ready: false, blocked: false, ...common, reason: "Enable Companion before wake listening." };
    if (!companion.wake.enabled) return { ready: false, blocked: false, ...common, reason: "Wake listening is turned off." };
    if (!phrase) return { ready: false, blocked: false, ...common, reason: "Choose a wake phrase first." };
    if (!this.#capture || !this.#transcription || !this.#companion || !this.#output) {
      return { ready: false, blocked: true, ...common, reason: "Wake word capture is not available in this build." };
    }
    return { ready: true, blocked: false, ...common };
  }

  #resolveRuntimeSelection(): VoiceWakeRuntimeSelection {
    const wake = this.#getVoiceSettings().wake;
    if (wake.engine === "custom-sherpa") {
      const phrase = normalizeVoiceWakePhrase(wake.phrase);
      const variants = wake.calibration && canonicalWakeText(wake.calibration.phrase) === canonicalWakeText(phrase)
        ? selectRuntimeWakeVariants(phrase, wake.calibration.variants)
        : [];
      return { engine: "custom-sherpa", phrase, variants };
    }
    return {
      engine: "official-livekit",
      phraseId: officialVoiceWakePhraseId,
      phrase: officialVoiceWakePhrase,
      sensitivity: wake.sensitivity ?? "balanced",
    };
  }

  #handleFrame(frame: unknown, generation: number): void {
    if (generation !== this.#generation || !this.#state.armed || !isValidVoiceWakePcmFrame(frame)) return;
    const now = this.#now();
    const frameCount = this.#diagnostics.pcmFramesReceived + 1;
    let squareSum = 0;
    for (const sample of frame.samples) squareSum += sample * sample;
    const rms = Math.sqrt(squareSum / Math.max(1, frame.samples.length));
    this.#diagnostics = { ...this.#diagnostics, pcmFramesReceived: frameCount, lastPcmFrameAt: now, lastPcmRms: rms };
    if (frameCount === 1) this.#log("info", "wake PCM frames received", { generation });
    if (now - this.#lastPcmLogAt >= 5_000) {
      this.#lastPcmLogAt = now;
      this.#log("debug", "wake PCM capture active", { generation, frameCount, inputLevel: voiceInputLevel(rms) });
    }
    const acceptsWakeAudio = this.#state.turnState === "idle"
      || this.#state.turnState === "follow-up"
      || this.#state.turnState === "activated"
      || this.#state.turnState === "collecting";
    if (!acceptsWakeAudio) return;
    this.#activation.ingest(frame);
    try {
      this.#runtimeSession?.sendFrame(frame);
    } catch (error) {
      void this.#failRuntime(error, generation);
      return;
    }
    const utterance = this.#activation.consumeFinalized();
    if (utterance) {
      this.#beginTurn(utterance, generation);
    } else if (
      (this.#state.turnState === "follow-up" || this.#state.turnState === "activated" || this.#state.turnState === "collecting")
      && this.#activation.turnState === "idle"
    ) {
      this.#clearFollowUpTimer();
      this.#endCommandPrivacy();
      this.#clearWakeAcknowledgement(true);
      this.#releaseConversationPresentation();
      if (!this.#resetRuntimeOrFail(generation)) return;
      this.#state = { ...this.#state, turnState: "idle", activePetId: undefined };
    }
  }

  #handleRuntimeEvent(event: VoiceWakeHelperEvent, generation: number): void {
    if (generation !== this.#generation || !this.#state.armed) return;
    const eventAt = this.#now();
    this.#diagnostics = { ...this.#diagnostics, lastHelperEventAt: eventAt };
    if (event.type === "error") {
      this.#log("warn", "wake helper reported an error", { generation, code: event.code, reason: event.message });
      void this.#failRuntime(new Error(event.message), generation);
      return;
    }
    if (event.type === "keyword") {
      const transportMs = event.capturedAt === undefined ? undefined : Math.max(0, Math.round(eventAt - event.capturedAt));
      this.#diagnostics = {
        ...this.#diagnostics,
        lastKeywordAt: eventAt,
        ...(event.capturedAt === undefined ? {} : { lastKeywordAudioAt: event.capturedAt }),
        ...(transportMs === undefined ? {} : { lastKeywordTransportMs: transportMs }),
        ...(event.windowMs === undefined ? {} : { detectorWindowMs: event.windowMs }),
        ...(event.strideMs === undefined ? {} : { detectorStrideMs: event.strideMs }),
      };
      this.#handleWakeDetected(generation, event);
      return;
    }
    if (event.type !== "vad") return;

    this.#diagnostics = { ...this.#diagnostics, lastVadAt: this.#now(), lastVadState: event.state };
    this.#log("debug", "wake voice activity changed", { generation, state: event.state });
    this.#vadSpeechActive = event.state === "speech-start";
    this.#activation.vad(event.state);
    if (event.state === "speech-start" && this.#activation.turnState === "collecting") {
      // The activation and follow-up timers only protect against no speech
      // starting. Once either command starts, VAD endpointing and
      // VoiceWakeActivation's bounded 30-second cap own completion.
      this.#clearActivationTimer();
      this.#clearFollowUpTimer();
      this.#state = { ...this.#state, turnState: "collecting" };
      return;
    }
    if (event.state === "speech-end") {
      if (this.#state.turnState !== "follow-up" && this.#state.turnState !== "activated" && this.#state.turnState !== "collecting") return;
      const utterance = this.#activation.consumeFinalized();
      if (!utterance) {
        if (this.#activation.turnState === "activated") return;
        this.#endCommandPrivacy();
        this.#clearWakeAcknowledgement(true);
        this.#releaseConversationPresentation();
        if (!this.#resetRuntimeOrFail(generation)) return;
        this.#state = { ...this.#state, turnState: "idle", activePetId: undefined };
        return;
      }
      this.#beginTurn(utterance, generation);
    }
  }

  #beginTurn(utterance: FinalizedVoiceUtterance, generation: number): void {
    // The bounded microphone command is complete at endpointing. Replace the
    // listening acknowledgement with a visible working state while local
    // transcription and the selected AI Brain prepare the answer.
    this.#endCommandPrivacy();
    this.#clearActivationTimer();
    this.#clearFollowUpTimer();
    this.#pendingFollowUpAfterTurn = false;
    this.#completedResponseText = "";
    const petId = this.#state.activePetId ?? this.#getDefaultPetId();
    this.#acknowledgement?.showThinking({ petId });
    this.#state = { ...this.#state, turnState: "endpointing" };
    this.#diagnostics = { ...this.#diagnostics, lastFinalizedUtteranceMs: Math.round(utterance.samples.length / utterance.sampleRate * 1_000) };
    this.#log("info", "wake utterance finalized", { generation, durationMs: this.#diagnostics.lastFinalizedUtteranceMs });
    try {
      const capture = encodePcm16Wav(utterance.samples, utterance.sampleRate);
      void this.#runTurn(capture, generation);
    } catch (error) {
      void this.#failRuntime(error, generation);
    }
  }

  async #runTurn(capture: VoiceFiniteAudioCapture, generation: number): Promise<void> {
    if (!this.#transcription || !this.#companion) return;
    if (this.#turnController) {
      this.#queuedTurn = { capture, generation };
      this.#log("debug", "follow-up turn queued until prior turn settles", { generation });
      return;
    }
    const petId = this.#state.activePetId ?? this.#getDefaultPetId();
    const controller = new AbortController();
    this.#turnController = controller;
    let stage: "transcription" | "companion" = "transcription";
    try {
      this.#state = { ...this.#state, turnState: "transcribing", activePetId: petId, reason: undefined };
      this.#log("info", "wake transcription started", { generation, petId });
      const transcript = await this.#transcription.transcribe(capture, controller.signal);
      if (generation !== this.#generation || controller.signal.aborted) throw abortError();
      this.#diagnostics = { ...this.#diagnostics, lastTranscriptionAt: this.#now(), lastError: undefined, lastFailureStage: undefined };
      this.#log("info", "wake transcription completed", { generation, petId, characters: transcript.length });
      this.#state = { ...this.#state, turnState: "thinking" };
      stage = "companion";
      this.#log("info", "wake companion turn started", { generation, petId });
      const result = await this.#companion.sendUserTurn({ petId, text: transcript, kind: "voice", speak: true });
      if (generation !== this.#generation || controller.signal.aborted) throw abortError();
      const resultText = result && typeof result === "object" && "text" in result ? (result as { readonly text?: unknown }).text : undefined;
      this.#completedResponseText = typeof resultText === "string" ? resultText.trim().slice(0, 4_000) : "";
      this.#diagnostics = { ...this.#diagnostics, lastCompanionTurnAt: this.#now() };
      this.#log("info", "wake companion turn completed", { generation, petId });
      if (this.#pendingFollowUpAfterTurn && this.#getCompanionSettings().wake.followUpEnabled === true) {
        this.#pendingFollowUpAfterTurn = false;
        this.#enterFollowUp(this.#completedResponseText);
      } else if (this.#state.turnState === "thinking") {
        this.#enterCooldown();
      }
    } catch (error) {
      const stale = generation !== this.#generation || controller.signal.aborted;
      if (!stale && !isAbortError(error)) {
        const reason = cleanError(error);
        this.#diagnostics = { ...this.#diagnostics, lastError: reason, lastFailureStage: stage };
        this.#log("warn", stage === "transcription" ? "wake transcription failed" : "wake companion turn failed", { generation, petId, reason });
        this.#state = { ...this.#state, reason };
        this.#enterCooldown();
      }
    } finally {
      if (this.#turnController === controller) this.#turnController = null;
      const queued = this.#queuedTurn;
      this.#queuedTurn = null;
      if (queued && queued.generation === this.#generation && !controller.signal.aborted) {
        void this.#runTurn(queued.capture, queued.generation);
      }
    }
  }

  #handleOutputActivity(activity: VoiceOutputActivitySnapshot): void {
    if (!this.#state.armed) return;
    const petId = this.#getDefaultPetId();
    const active = activity.active && activity.activePetIds.includes(petId);
    if (active) {
      this.#pendingFollowUpAfterTurn = false;
      this.#clearActivationTimer();
      this.#clearWakeAcknowledgement();
      this.#activation.outputStarted();
      this.#state = { ...this.#state, turnState: "speaking", activePetId: petId };
      return;
    }
    if (this.#state.turnState === "speaking") {
      if (this.#getCompanionSettings().wake.followUpEnabled === true && this.#turnController) this.#pendingFollowUpAfterTurn = true;
      else if (this.#getCompanionSettings().wake.followUpEnabled === true) this.#enterFollowUp(this.#completedResponseText);
      else this.#enterCooldown();
    }
  }

  #enterFollowUp(completedText = ""): void {
    this.#pendingFollowUpAfterTurn = false;
    this.#endCommandPrivacy();
    this.#clearActivationTimer();
    this.#clearFollowUpTimer();
    if (this.#cooldownTimer) clearTimeout(this.#cooldownTimer);
    this.#cooldownTimer = null;
    const petId = this.#state.activePetId ?? this.#getDefaultPetId();
    if (!this.#resetRuntimeOrFail(this.#generation)) return;
    this.#activation.beginFollowUp();
    this.#beginCommandPrivacy();
    this.#state = { ...this.#state, turnState: "follow-up", activePetId: petId, reason: undefined };
    this.#listeningAckPetId = petId;
    this.#acknowledgement?.showListening({ petId, phrase: this.#activePhrase ?? "", followUp: true, ...(completedText ? { completedText } : {}) });
    const generation = this.#generation;
    this.#followUpTimer = setTimeout(() => {
      this.#followUpTimer = null;
      if (generation !== this.#generation || this.#state.turnState !== "follow-up") return;
      this.#activation.cancel();
      this.#endCommandPrivacy();
      this.#clearWakeAcknowledgement(true);
      this.#releaseConversationPresentation();
      if (!this.#resetRuntimeOrFail(generation)) return;
      this.#state = { ...this.#state, turnState: "idle", activePetId: undefined };
      this.#log("info", "follow-up listening ended without speech", { generation });
    }, this.#followUpTimeoutMs);
    this.#followUpTimer.unref?.();
  }

  #enterCooldown(): void {
    this.#pendingFollowUpAfterTurn = false;
    this.#endCommandPrivacy();
    this.#clearActivationTimer();
    this.#clearFollowUpTimer();
    this.#clearWakeAcknowledgement();
    this.#releaseConversationPresentation(this.#presentationHoldMs);
    this.#activation.outputEnded(this.#now());
    this.#state = { ...this.#state, turnState: "cooldown" };
    if (this.#cooldownTimer) clearTimeout(this.#cooldownTimer);
    this.#cooldownTimer = setTimeout(() => {
      this.#cooldownTimer = null;
      this.#activation.tick(this.#now() + cooldownMs);
      if (this.#state.turnState !== "cooldown") return;
      if (!this.#resetRuntimeOrFail(this.#generation)) return;
      this.#state = { ...this.#state, turnState: "idle", activePetId: undefined };
    }, cooldownMs);
    this.#cooldownTimer.unref?.();
  }

  #resetRuntimeOrFail(generation: number): boolean {
    try {
      this.#runtimeSession?.reset();
      return true;
    } catch (error) {
      void this.#failRuntime(error, generation);
      return false;
    }
  }

  async #failRuntime(error: unknown, generation: number): Promise<void> {
    if (generation !== this.#generation) return;
    const reason = cleanError(error);
    this.#diagnostics = { ...this.#diagnostics, lastError: reason };
    this.#log("warn", "wake runtime failed", { generation, reason });
    const stopGeneration = await this.#stopSessions("wake-runtime-error");
    if (this.#generation !== stopGeneration) return;
    this.#state = { enabled: false, armed: false, captureState: "error", turnState: "idle", reason };
  }

  async #stopSessions(reason: string): Promise<number> {
    this.#endCommandPrivacy();
    this.#clearActivationTimer();
    this.#clearFollowUpTimer();
    this.#clearWakeAcknowledgement(true);
    this.#releaseConversationPresentation();
    this.#vadSpeechActive = false;
    const stopGeneration = ++this.#generation;
    if (this.#cooldownTimer) clearTimeout(this.#cooldownTimer);
    this.#cooldownTimer = null;
    this.#sessionController?.abort();
    this.#sessionController = null;
    this.#turnController?.abort();
    this.#turnController = null;
    this.#queuedTurn = null;
    this.#pendingFollowUpAfterTurn = false;
    this.#completedResponseText = "";
    const activePetId = this.#state.activePetId;
    if (activePetId) {
      try { this.#companion?.cancel(activePetId); } catch { /* coordinator shutdown is best effort */ }
    }
    this.#unsubscribeFrame?.();
    this.#unsubscribeCaptureEnded?.();
    this.#unsubscribeRuntime?.();
    this.#unsubscribeOutput?.();
    this.#unsubscribeFrame = null;
    this.#unsubscribeCaptureEnded = null;
    this.#unsubscribeRuntime = null;
    this.#unsubscribeOutput = null;
    const runtimeSession = this.#runtimeSession;
    const captureSession = this.#captureSession;
    this.#runtimeSession = null;
    this.#captureSession = null;
    this.#activePhrase = null;
    this.#activeVariantsKey = "";
    this.#activeRuntimeKey = "";
    this.#activeMicrophoneDeviceId = "";
    this.#activation.reset();
    await Promise.allSettled([
      runtimeSession?.stop(),
      captureSession?.stop(reason),
    ].filter((item): item is Promise<void> => Boolean(item)));
    return stopGeneration;
  }

  #beginCommandPrivacy(): void {
    if (this.#commandPrivacyActive) return;
    this.#commandPrivacyActive = true;
    this.#privacyIndicator?.trackStarted();
  }

  #endCommandPrivacy(): void {
    if (!this.#commandPrivacyActive) return;
    this.#commandPrivacyActive = false;
    this.#privacyIndicator?.trackStopped();
  }

  #handleWakeDetected(generation: number, event: Extract<VoiceWakeHelperEvent, { readonly type: "keyword" }>): void {
    if (generation !== this.#generation || !this.#state.armed) return;
    const requireNextUtterance = this.#vadSpeechActive;
    if (!this.#activation.keywordDetected(this.#now(), { requireNextUtterance })) return;
    const petId = this.#getDefaultPetId();
    this.#releaseConversationPresentation();
    this.#releasePresentation = this.#presentation?.acquire() ?? null;
    this.#beginCommandPrivacy();
    this.#log("info", "wake phrase detected", {
      generation,
      source: "keyword",
      score: event.score,
      transportMs: this.#diagnostics.lastKeywordTransportMs,
      detectorWindowMs: event.windowMs,
      detectorStrideMs: event.strideMs,
      activeVariantCount: this.#activeVariantsKey ? this.#activeVariantsKey.split("\n").length : 0,
    });
    this.#state = { ...this.#state, turnState: "activated", activePetId: petId, reason: undefined };
    this.#listeningAckPetId = petId;
    this.#acknowledgement?.showListening({ petId, phrase: this.#activePhrase ?? "", followUp: false });
    this.#clearActivationTimer();
    this.#activationTimer = setTimeout(() => {
      this.#activationTimer = null;
      if (generation !== this.#generation || (this.#state.turnState !== "activated" && this.#state.turnState !== "collecting")) return;
      this.#activation.cancel();
      this.#endCommandPrivacy();
      this.#clearWakeAcknowledgement(true);
      this.#releaseConversationPresentation();
      if (!this.#resetRuntimeOrFail(generation)) return;
      this.#state = { ...this.#state, turnState: "idle", activePetId: undefined };
      this.#log("info", "wake command timed out", { generation });
    }, this.#activationTimeoutMs);
    this.#activationTimer.unref?.();
  }

  #clearActivationTimer(): void {
    if (this.#activationTimer) clearTimeout(this.#activationTimer);
    this.#activationTimer = null;
  }

  #clearFollowUpTimer(): void {
    if (this.#followUpTimer) clearTimeout(this.#followUpTimer);
    this.#followUpTimer = null;
  }

  #clearWakeAcknowledgement(clearBubble = false, fallbackPetId?: string): void {
    const petId = this.#listeningAckPetId;
    this.#listeningAckPetId = null;
    const targetPetId = petId ?? (clearBubble ? fallbackPetId : undefined);
    if (targetPetId) this.#acknowledgement?.clearListening({ petId: targetPetId, clearBubble });
  }

  #releaseConversationPresentation(delayMs = 0): void {
    if (this.#presentationReleaseTimer) clearTimeout(this.#presentationReleaseTimer);
    this.#presentationReleaseTimer = null;
    const release = this.#releasePresentation;
    if (!release) return;
    if (delayMs > 0) {
      this.#presentationReleaseTimer = setTimeout(() => {
        this.#presentationReleaseTimer = null;
        if (this.#releasePresentation !== release) return;
        this.#releasePresentation = null;
        release();
      }, delayMs);
      this.#presentationReleaseTimer.unref?.();
      return;
    }
    this.#releasePresentation = null;
    release();
  }
}

function cleanError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const withoutUrls = text.replace(/https?:\/\/[^\s]+/gi, "[url]");
  return sanitizeVoiceWakeMessage(withoutUrls)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|[A-Fa-f0-9]{32,}|[A-Za-z0-9_-]{40,})\b/g, "[redacted-token]")
    .slice(0, 300)
    || "Wake listening failed.";
}

function voiceInputLevel(rms: number): "very-quiet" | "low" | "good" | "loud" {
  if (rms < 0.003) return "very-quiet";
  if (rms < 0.015) return "low";
  if (rms < 0.08) return "good";
  return "loud";
}

function microphoneKey(microphone: { readonly deviceId: string; readonly label?: string } | undefined): string {
  return microphone ? `${microphone.deviceId}\n${microphone.label ?? ""}` : "";
}

function abortError(): Error {
  const error = new Error("Wake listening was cancelled.");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
