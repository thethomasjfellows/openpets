import type { VoiceWakeHelperEvent } from "./voice-wake-helper-protocol.js";
import type { VoicePcmFrame, VoiceWakeMethod, VoiceWakeMicrophoneResolution, VoiceWakeMicrophoneSelection } from "./voice-wake-types.js";
import type { VoiceWakeSensitivity } from "./voice-wake-types.js";

export type VoiceWakeRuntimeSelection =
  | {
      readonly engine: "official-livekit";
      readonly phraseId: "openpets.hey-pedra.v1";
      readonly phrase: "Hey Pedra";
      readonly sensitivity: VoiceWakeSensitivity;
    }
  | {
      readonly engine: "custom-sherpa";
      readonly phrase: string;
      readonly variants?: readonly string[];
    };

export type VoiceWakeRuntimeStartConfig = VoiceWakeRuntimeSelection & {
  readonly signal: AbortSignal;
};

export type VoiceWakeRuntimeHealth = {
  readonly ready: boolean;
  readonly method: VoiceWakeMethod;
  readonly reason?: string;
  readonly version?: string;
  readonly modelId?: string;
};

export type VoiceWakeRuntimeSession = {
  sendFrame(frame: VoicePcmFrame): void;
  reset(): void;
  stop(): Promise<void>;
  onEvent(listener: (event: VoiceWakeHelperEvent) => void): () => void;
};

export type VoiceWakeRuntime = {
  health(selection?: VoiceWakeRuntimeSelection): VoiceWakeRuntimeHealth;
  start(config: VoiceWakeRuntimeStartConfig): Promise<VoiceWakeRuntimeSession>;
  dispose(): void | Promise<void>;
};

export type VoiceWakePcmSession = {
  readonly owner: "wake" | "wake-calibration";
  readonly startedAt: number;
  readonly microphone?: VoiceWakeMicrophoneResolution;
  onFrame(listener: (frame: VoicePcmFrame) => void): () => void;
  onEnded?(listener: (reason: string) => void): () => void;
  stop(reason?: string): Promise<void>;
};

export type VoiceWakeCaptureSource = {
  startWakePcmStream(options: { readonly frameMs: 20 | 30; readonly owner?: "wake" | "wake-calibration"; readonly microphone?: VoiceWakeMicrophoneSelection; readonly signal: AbortSignal }): Promise<VoiceWakePcmSession>;
};

const unavailableReason = "Wake word is not available: no approved local runtime and model are packaged with OpenPets yet.";

export class UnavailableVoiceWakeRuntime implements VoiceWakeRuntime {
  readonly #reason: string;

  constructor(reason = unavailableReason) {
    this.#reason = reason;
  }

  health(): VoiceWakeRuntimeHealth {
    return { ready: false, method: "unavailable", reason: this.#reason };
  }

  async start(): Promise<never> {
    throw new Error(this.#reason);
  }

  dispose(): void {
    // No helper process exists in gated builds.
  }
}

export { unavailableReason as voiceWakeUnavailableReason };
