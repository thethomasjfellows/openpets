import { Buffer } from "node:buffer";

import type { VoiceFiniteAudioCapture } from "./voice-audio.js";
import { isValidVoiceWakePcmFrame } from "./voice-wake-helper-protocol.js";
import type { VoiceWakeCaptureSource, VoiceWakePcmSession } from "./voice-wake-runtime.js";
import type { VoicePcmFrame, VoiceWakeMicrophoneResolution, VoiceWakeMicrophoneSelection } from "./voice-wake-types.js";

export type VoiceCaptureOwner = "plugin-listen" | "wake" | "wake-calibration";
export type VoiceCaptureResult = VoiceFiniteAudioCapture & { readonly mimeType: "audio/wav" };
export type VoiceCaptureHandle = {
  readonly owner: VoiceCaptureOwner;
  readonly result: Promise<VoiceCaptureResult>;
  stop(): Promise<VoiceCaptureResult>;
  cancel(reason?: string): Promise<void>;
};

export type VoiceCaptureWindowMode = "finite-wav" | "wake-pcm";

export function getVoiceCaptureAudioConstraints(mode: VoiceCaptureWindowMode): {
  readonly channelCount: 1;
  readonly echoCancellation: boolean;
  readonly noiseSuppression: boolean;
  readonly autoGainControl: true;
} {
  return mode === "wake-pcm"
    ? { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true }
    : { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
}

export type VoiceCaptureWindowHandle = {
  readonly senderId: number;
  load(): Promise<void>;
  isDestroyed(): boolean;
  destroy(): void;
  onUnexpectedEnd(listener: (reason: string) => void): () => void;
};

export type VoiceCaptureWakeStart = {
  readonly generation: number;
  readonly sessionToken: string;
  readonly frameMs: 20 | 30;
  readonly microphone?: VoiceWakeMicrophoneSelection;
};

export type VoiceCapturePcmMessage = {
  readonly senderId: number;
  readonly payload: unknown;
};

export type VoiceCaptureRuntime = {
  now(): number;
  newSessionToken(): string;
  preparePartition(partition: string): void;
  clearPartition(partition: string): Promise<void>;
  createWindow(options: { readonly partition: string; readonly mode: VoiceCaptureWindowMode }): VoiceCaptureWindowHandle;
  startFiniteWav(window: VoiceCaptureWindowHandle): Promise<void>;
  finishFiniteWav(window: VoiceCaptureWindowHandle, cancelled: boolean): Promise<string>;
  startWakePcm(window: VoiceCaptureWindowHandle, config: VoiceCaptureWakeStart): Promise<VoiceWakeMicrophoneResolution>;
  stopWakePcm(window: VoiceCaptureWindowHandle): Promise<void>;
  onPcmFrame(listener: (message: VoiceCapturePcmMessage) => void): () => void;
};

type VoiceCaptureIndicator = {
  trackStarted(): void;
  trackStopped(): void;
};

type VoiceCaptureLog = (message: string, fields?: Record<string, unknown>) => void;
type VoiceCaptureTiming = {
  readonly microphoneAcquisitionTimeoutMs?: number;
  readonly savedMicrophoneAcquisitionTimeoutMs?: number;
};

type ActiveBase = {
  readonly generation: number;
  readonly owner: VoiceCaptureOwner;
  readonly window: VoiceCaptureWindowHandle;
  readonly partition: string;
  readonly startedAt: number;
  ready: boolean;
  liveTrackStarted: boolean;
  unsubscribeWindow: (() => void) | null;
  unsubscribeAbort: (() => void) | null;
  teardown: Promise<void> | null;
};

type ActiveFiniteCapture = ActiveBase & {
  readonly mode: "finite-wav";
  readonly result: Promise<VoiceCaptureResult>;
  readonly resolve: (result: VoiceCaptureResult) => void;
  readonly reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
  finishing: Promise<VoiceCaptureResult> | null;
};

type ActiveWakePcmCapture = ActiveBase & {
  readonly mode: "wake-pcm";
  readonly owner: "wake" | "wake-calibration";
  readonly sessionToken: string;
  readonly frameMs: 20 | 30;
  readonly frameSamples: 320 | 480;
  readonly listeners: Set<(frame: VoicePcmFrame) => void>;
  readonly endedListeners: Set<(reason: string) => void>;
  stopping: Promise<void> | null;
  endedReason?: string;
};

type ActiveCapture = ActiveFiniteCapture | ActiveWakePcmCapture;

const microphoneAcquisitionTimeoutMs = 15_000;
const savedMicrophoneAcquisitionTimeoutMs = 4_000;

export class VoiceCaptureServiceCore implements VoiceWakeCaptureSource {
  readonly #indicator: VoiceCaptureIndicator;
  readonly #runtime: VoiceCaptureRuntime;
  readonly #log: VoiceCaptureLog;
  readonly #microphoneAcquisitionTimeoutMs: number;
  readonly #savedMicrophoneAcquisitionTimeoutMs: number;
  #active: ActiveCapture | null = null;
  #generation = 0;
  #unsubscribePcm: (() => void) | null;
  #disposed = false;

  constructor(indicator: VoiceCaptureIndicator, runtime: VoiceCaptureRuntime, log: VoiceCaptureLog = () => undefined, timing: VoiceCaptureTiming = {}) {
    this.#indicator = indicator;
    this.#runtime = runtime;
    this.#log = log;
    this.#microphoneAcquisitionTimeoutMs = clampTimeout(timing.microphoneAcquisitionTimeoutMs, microphoneAcquisitionTimeoutMs);
    this.#savedMicrophoneAcquisitionTimeoutMs = clampTimeout(timing.savedMicrophoneAcquisitionTimeoutMs, savedMicrophoneAcquisitionTimeoutMs);
    this.#unsubscribePcm = runtime.onPcmFrame((message) => this.#handlePcmFrame(message));
  }

  async start(owner: VoiceCaptureOwner, timeoutMs: number): Promise<VoiceCaptureHandle> {
    this.#assertAvailable();
    const duration = Math.min(30_000, Math.max(1_000, Math.round(timeoutMs)));
    const active = this.#createFiniteCapture(owner);
    this.#active = active;
    try {
      await active.window.load();
      await this.#withAcquisitionTimeout(this.#runtime.startFiniteWav(active.window));
      if (this.#active !== active) throw new Error("Voice capture was cancelled before microphone acquisition.");
      active.ready = true;
      active.liveTrackStarted = true;
      this.#indicator.trackStarted();
      this.#installWindowEndHandler(active);
      this.#log("voice capture live", { owner, timeoutMs: duration, generation: active.generation });
      active.timer = setTimeout(() => { void this.#finishFiniteCapture(active, false).catch(() => undefined); }, duration);
      active.timer.unref?.();
      return {
        owner,
        result: active.result,
        stop: () => this.#finishFiniteCapture(active, false),
        cancel: async (reason) => {
          this.#log("voice capture cancelled", { owner, reason, generation: active.generation });
          await this.#finishFiniteCapture(active, true).then(() => undefined, () => undefined);
        },
      };
    } catch (error) {
      await this.#runtime.finishFiniteWav(active.window, true).catch(() => undefined);
      await this.#teardown(active);
      throw error;
    }
  }

  async captureOneShot(owner: VoiceCaptureOwner, timeoutMs: number): Promise<VoiceCaptureResult> {
    return (await this.start(owner, timeoutMs)).result;
  }

  async startWakePcmStream(options: { readonly frameMs: 20 | 30; readonly owner?: "wake" | "wake-calibration"; readonly microphone?: VoiceWakeMicrophoneSelection; readonly signal?: AbortSignal }): Promise<VoiceWakePcmSession> {
    this.#assertAvailable();
    if (options.frameMs !== 20 && options.frameMs !== 30) throw new Error("Wake PCM frame duration must be 20 or 30 milliseconds.");
    const active = this.#createWakeCapture(options.frameMs, options.owner ?? "wake");
    this.#active = active;
    if (options.signal) {
      const onAbort = () => {
        if (this.#active === active) void this.#stopWake(active, "wake-start-aborted", false);
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      active.unsubscribeAbort = () => { options.signal?.removeEventListener("abort", onAbort); };
    }
    try {
      if (options.signal?.aborted) throw abortError();
      await active.window.load();
      const microphone = await this.#withAcquisitionTimeout(this.#runtime.startWakePcm(active.window, {
        generation: active.generation,
        sessionToken: active.sessionToken,
        frameMs: active.frameMs,
        ...(options.microphone ? { microphone: options.microphone } : {}),
      }), options.microphone ? this.#savedMicrophoneAcquisitionTimeoutMs : this.#microphoneAcquisitionTimeoutMs);
      if (options.signal?.aborted) throw abortError();
      if (this.#active !== active) throw new Error("Wake PCM capture was cancelled before microphone acquisition.");
      active.ready = true;
      if (active.owner === "wake-calibration") {
        active.liveTrackStarted = true;
        this.#indicator.trackStarted();
      }
      // Ambient wake audio stays local in the validated KWS/VAD helper and can
      // remain armed for hours. The OS microphone indicator already discloses
      // that live device use; OpenPets' floating badge is reserved for bounded
      // user-command capture after the wake phrase, not this ambient stream.
      this.#installWindowEndHandler(active);
      this.#log("wake PCM capture live", {
        frameMs: active.frameMs,
        generation: active.generation,
        microphoneRequested: microphone.requestedDevice ? "saved-device" : "system-default",
        microphoneResolved: microphone.usedDefault ? "system-default" : "saved-device",
        fallbackReason: microphone.fallbackReason,
      });
      return {
        owner: active.owner,
        startedAt: active.startedAt,
        microphone,
        onFrame: (listener) => {
          if (this.#active !== active || active.endedReason) return () => undefined;
          active.listeners.add(listener);
          return () => { active.listeners.delete(listener); };
        },
        onEnded: (listener) => {
          if (active.endedReason) {
            const reason = active.endedReason;
            queueMicrotask(() => listener(reason));
            return () => undefined;
          }
          if (this.#active !== active) return () => undefined;
          active.endedListeners.add(listener);
          return () => { active.endedListeners.delete(listener); };
        },
        stop: (reason = "wake-stopped") => this.#stopWake(active, reason, false),
      };
    } catch (error) {
      if (active.stopping) {
        await active.stopping;
      } else {
        await this.#runtime.stopWakePcm(active.window).catch(() => undefined);
        await this.#teardown(active);
      }
      if (options.microphone && isAcquisitionTimeout(error) && !options.signal?.aborted) {
        this.#log("saved microphone acquisition timed out; retrying system default", {
          owner: active.owner,
          generation: active.generation,
        });
        const fallback = await this.startWakePcmStream({
          frameMs: options.frameMs,
          owner: options.owner,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        return {
          ...fallback,
          microphone: { requestedDevice: true, usedDefault: true, fallbackReason: "saved-device-unavailable" },
        };
      }
      throw error;
    }
  }

  async cancelActive(reason = "shutdown"): Promise<void> {
    const active = this.#active;
    if (!active) return;
    this.#log("active voice capture cancelled", {
      mode: active.mode,
      owner: active.owner,
      reason,
      generation: active.generation,
    });
    if (active.mode === "finite-wav") {
      await this.#finishFiniteCapture(active, true).then(() => undefined, () => undefined);
      return;
    }
    await this.#stopWake(active, reason, false);
  }

  async shutdown(): Promise<void> {
    if (this.#disposed) return;
    await this.cancelActive("shutdown");
    this.#disposed = true;
    this.#unsubscribePcm?.();
    this.#unsubscribePcm = null;
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error("Voice capture service is shut down.");
    if (this.#active) throw new Error("A voice capture is already in progress.");
  }

  #createFiniteCapture(owner: VoiceCaptureOwner): ActiveFiniteCapture {
    const base = this.#createBase(owner, "finite-wav");
    let resolveResult!: (result: VoiceCaptureResult) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<VoiceCaptureResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    void result.catch(() => undefined);
    return {
      ...base,
      mode: "finite-wav",
      result,
      resolve: resolveResult,
      reject: rejectResult,
      timer: null,
      finishing: null,
    };
  }

  #createWakeCapture(frameMs: 20 | 30, owner: "wake" | "wake-calibration"): ActiveWakePcmCapture {
    return {
      ...this.#createBase(owner, "wake-pcm"),
      mode: "wake-pcm",
      owner,
      sessionToken: this.#runtime.newSessionToken(),
      frameMs,
      frameSamples: frameMs === 20 ? 320 : 480,
      listeners: new Set(),
      endedListeners: new Set(),
      stopping: null,
    };
  }

  #createBase(owner: VoiceCaptureOwner, mode: VoiceCaptureWindowMode): ActiveBase {
    const generation = ++this.#generation;
    const startedAt = this.#runtime.now();
    const partition = ["openpets-voice-capture", startedAt, generation].join(":");
    this.#runtime.preparePartition(partition);
    return {
      generation,
      owner,
      window: this.#runtime.createWindow({ partition, mode }),
      partition,
      startedAt,
      ready: false,
      liveTrackStarted: false,
      unsubscribeWindow: null,
      unsubscribeAbort: null,
      teardown: null,
    };
  }

  #installWindowEndHandler(active: ActiveCapture): void {
    active.unsubscribeWindow = active.window.onUnexpectedEnd((reason) => {
      if (this.#active !== active) return;
      if (active.mode === "finite-wav") {
        const error = new Error("Voice capture ended unexpectedly: " + reason);
        active.reject(error);
        void this.#teardown(active);
        return;
      }
      void this.#stopWake(active, reason, true);
    });
  }

  #finishFiniteCapture(active: ActiveFiniteCapture, cancelled: boolean): Promise<VoiceCaptureResult> {
    if (active.finishing) return active.finishing;
    active.finishing = (async () => {
      if (active.timer) clearTimeout(active.timer);
      active.timer = null;
      try {
        if (!active.ready || active.window.isDestroyed()) throw new Error(cancelled ? "Voice capture was cancelled." : "Voice capture window closed unexpectedly.");
        const base64 = await this.#runtime.finishFiniteWav(active.window, cancelled);
        if (cancelled) throw new Error("Voice capture was cancelled.");
        const bytes = Buffer.from(base64, "base64");
        if (bytes.byteLength < 128) throw new Error("Voice capture produced no audio.");
        if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("Voice capture is too large.");
        const capture = {
          bytes,
          mimeType: "audio/wav" as const,
          durationMs: Math.max(0, this.#runtime.now() - active.startedAt),
        };
        active.resolve(capture);
        return capture;
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        active.reject(normalized);
        throw normalized;
      } finally {
        await this.#teardown(active);
      }
    })();
    return active.finishing;
  }

  #stopWake(active: ActiveWakePcmCapture, reason: string, unexpected: boolean): Promise<void> {
    if (active.stopping) return active.stopping;
    active.stopping = (async () => {
      const endedListeners = unexpected ? [...active.endedListeners] : [];
      if (unexpected) active.endedReason = reason;
      active.listeners.clear();
      active.endedListeners.clear();
      try {
        if (!active.window.isDestroyed()) await this.#runtime.stopWakePcm(active.window);
      } catch {
        // Renderer teardown remains best effort after crashes and shutdown.
      } finally {
        await this.#teardown(active);
      }
      for (const listener of endedListeners) {
        try { listener(reason); } catch { /* one observer cannot block capture cleanup */ }
      }
    })();
    return active.stopping;
  }

  #handlePcmFrame(message: VoiceCapturePcmMessage): void {
    const active = this.#active;
    if (!active || active.mode !== "wake-pcm" || !active.ready) return;
    if (message.senderId !== active.window.senderId) return;
    const payload = asRecord(message.payload);
    if (!payload) return;
    if (payload.generation !== active.generation || payload.sessionToken !== active.sessionToken || payload.frameMs !== active.frameMs) return;
    if (typeof payload.capturedAt !== "number" || !Number.isFinite(payload.capturedAt)) return;
    if (!(payload.samples instanceof Float32Array) || payload.samples.length !== active.frameSamples) return;

    const samples = new Float32Array(payload.samples.length);
    for (let index = 0; index < samples.length; index += 1) {
      const value = payload.samples[index];
      samples[index] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
    }
    const frame: VoicePcmFrame = {
      sampleRate: 16_000,
      channels: 1,
      format: "f32",
      samples,
      capturedAt: payload.capturedAt,
    };
    if (!isValidVoiceWakePcmFrame(frame)) return;
    for (const listener of [...active.listeners]) {
      try {
        listener(frame);
      } catch (error) {
        this.#log("wake PCM listener failed", {
          reason: error instanceof Error ? error.message : String(error),
          generation: active.generation,
        });
      }
    }
  }

  #teardown(active: ActiveCapture): Promise<void> {
    if (active.teardown) return active.teardown;
    active.teardown = (async () => {
      if (active.mode === "finite-wav" && active.timer) clearTimeout(active.timer);
      if (active.mode === "finite-wav") active.timer = null;
      if (this.#active === active) this.#active = null;
      active.unsubscribeWindow?.();
      active.unsubscribeWindow = null;
      active.unsubscribeAbort?.();
      active.unsubscribeAbort = null;
      if (active.liveTrackStarted) {
        active.liveTrackStarted = false;
        this.#indicator.trackStopped();
      }
      if (!active.window.isDestroyed()) active.window.destroy();
      await this.#runtime.clearPartition(active.partition).catch(() => undefined);
    })();
    return active.teardown;
  }

  async #withAcquisitionTimeout<T>(promise: Promise<T>, timeoutMs = this.#microphoneAcquisitionTimeoutMs): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Microphone acquisition timed out.")), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function isAcquisitionTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === "Microphone acquisition timed out.";
}

function clampTimeout(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(60_000, Math.max(10, Math.round(value)))
    : fallback;
}

function abortError(): Error {
  const error = new Error("Wake PCM capture was aborted.");
  error.name = "AbortError";
  return error;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
