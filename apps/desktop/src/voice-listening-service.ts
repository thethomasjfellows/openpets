import { getDefaultPetWindowForPlugins } from "./default-pet-controller.js";
import { debug } from "./logger.js";
import { playPetVoiceCue, setPetVoiceListeningState } from "./pet-window.js";
import { VoiceCaptureStartGuard } from "./voice-capture-start-guard.js";
import type { VoiceCaptureHandle, VoiceCaptureService } from "./voice-capture.js";
import type { VoiceTranscriptionService } from "./voice-transcription-service.js";

export type VoiceListeningState = "idle" | "starting" | "listening" | "transcribing" | "complete" | "cancelled" | "error";
export type VoiceListeningSnapshot = {
  readonly state: VoiceListeningState;
  readonly owner?: "plugin-listen";
  readonly startedAt?: number;
  readonly transcript?: string;
  readonly error?: string;
};

/**
 * Preserves the plugin SDK's explicit one-shot microphone contract. Companion
 * wake listening has its own activation coordinator and consent boundary.
 */
export class VoiceListeningService {
  readonly #capture: VoiceCaptureService;
  readonly #transcription: VoiceTranscriptionService;
  readonly #wake?: { suspendForExternalCapture(reason: string): Promise<() => Promise<void>> };
  readonly #startGuard = new VoiceCaptureStartGuard();
  #snapshot: VoiceListeningSnapshot = { state: "idle" };
  #transcriptionController: AbortController | null = null;
  #resumeWake: (() => Promise<void>) | null = null;

  constructor(input: { capture: VoiceCaptureService; transcription: VoiceTranscriptionService; wake?: { suspendForExternalCapture(reason: string): Promise<() => Promise<void>> } }) {
    this.#capture = input.capture;
    this.#transcription = input.transcription;
    this.#wake = input.wake;
  }

  getSnapshot(): VoiceListeningSnapshot {
    return this.#snapshot;
  }

  async listenOncePlugin(timeoutMs: number): Promise<{ text: string }> {
    if (this.#startGuard.pending || this.#transcriptionController) throw new Error("Another voice activity is already active.");
    const window = getDefaultPetWindowForPlugins();
    const pending = this.#startGuard.begin("plugin-listen");
    let handle: VoiceCaptureHandle | undefined;
    this.#set({ state: "starting", owner: "plugin-listen", startedAt: Date.now() });
    try {
      this.#resumeWake = await this.#wake?.suspendForExternalCapture("plugin-listen") ?? null;
      handle = await this.#capture.start("plugin-listen", timeoutMs);
      if (!await this.#startGuard.accept(pending, handle)) throw abortError();
      if (window) {
        setPetVoiceListeningState(window, "listening");
        playPetVoiceCue(window, "voice-start");
      }
      this.#set({ state: "listening", owner: "plugin-listen", startedAt: Date.now() });
      const capture = await handle.result;
      if (window) {
        playPetVoiceCue(window, "voice-stop");
        setPetVoiceListeningState(window, "transcribing");
      }
      this.#set({ state: "transcribing", owner: "plugin-listen" });
      const controller = new AbortController();
      this.#transcriptionController = controller;
      const text = await this.#transcription.transcribe(capture, controller.signal);
      this.#set({ state: "complete", owner: "plugin-listen", transcript: text });
      return { text };
    } catch (error) {
      if (handle && this.#snapshot.state === "starting") await handle.cancel("voice-start-failed").catch(() => undefined);
      this.#startGuard.clear(pending);
      this.#set(pending.cancelled || isAbortError(error) || (this.#snapshot.state === "cancelled" && this.#snapshot.owner === "plugin-listen")
        ? { state: "cancelled", owner: "plugin-listen" }
        : { state: "error", owner: "plugin-listen", error: cleanError(error) });
      throw error;
    } finally {
      this.#transcriptionController = null;
      await this.#releaseWake();
      if (window) setPetVoiceListeningState(window, "idle");
      setTimeout(() => { if (this.#snapshot.owner === "plugin-listen") this.#set({ state: "idle" }); }, 1_000).unref?.();
    }
  }

  async cancel(reason = "cancelled"): Promise<VoiceListeningSnapshot> {
    const pending = this.#startGuard.cancel(reason);
    this.#transcriptionController?.abort();
    this.#transcriptionController = null;
    await this.#capture.cancelActive(reason).catch(() => undefined);
    await this.#releaseWake();
    const owner = pending?.owner ?? this.#snapshot.owner;
    if (owner) this.#set({ state: "cancelled", owner });
    return this.#snapshot;
  }

  async shutdown(): Promise<void> {
    await this.cancel("shutdown");
    this.#set({ state: "idle" });
  }

  #set(snapshot: VoiceListeningSnapshot): void {
    this.#snapshot = snapshot;
    debug("app", "voice listening state", { state: snapshot.state, owner: snapshot.owner });
  }

  async #releaseWake(): Promise<void> {
    const resume = this.#resumeWake;
    this.#resumeWake = null;
    await resume?.().catch(() => undefined);
  }
}

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/https?:\/\/[^\s]+/g, "provider endpoint").slice(0, 240);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
  const error = new Error("Voice activity was cancelled.");
  error.name = "AbortError";
  return error;
}
