export const officialVoiceWakePhraseId = "openpets.hey-pedra.v1" as const;
export const officialVoiceWakePhrase = "Hey Pedra" as const;

export type VoiceWakeEngine = "official-livekit" | "custom-sherpa";
export type VoiceWakeSensitivity = "strict" | "balanced" | "easy";
export type VoiceWakeMethod = "unavailable" | "sherpa-onnx" | "livekit-wakeword";

export type VoiceWakeHealth = {
  readonly checkedAt: number;
  readonly ready: boolean;
  readonly enabled: boolean;
  readonly method: VoiceWakeMethod;
  readonly reason?: string;
};

export type VoiceWakeCaptureState =
  | "disabled"
  | "blocked"
  | "starting-capture"
  | "starting-helper"
  | "armed"
  | "suspended"
  | "recovering-device"
  | "recovering-capture"
  | "recovering-helper"
  | "error"
  | "stopping";

export type VoiceWakeTurnState =
  | "idle"
  | "follow-up"
  | "activated"
  | "collecting"
  | "endpointing"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "cooldown";

export type VoiceWakeSnapshot = {
  readonly checkedAt: number;
  readonly enabled: boolean;
  readonly armed: boolean;
  readonly captureState: VoiceWakeCaptureState;
  readonly turnState: VoiceWakeTurnState;
  readonly phraseConfigured: boolean;
  readonly activePetId?: string;
  readonly reason?: string;
  readonly diagnostics?: {
    readonly captureStartedAt?: number;
    readonly helperStartedAt?: number;
    readonly lastPcmFrameAt?: number;
    readonly pcmFramesReceived: number;
    readonly lastPcmRms?: number;
    readonly lastHelperEventAt?: number;
    readonly lastKeywordAt?: number;
    readonly lastKeywordAudioAt?: number;
    readonly lastKeywordTransportMs?: number;
    readonly detectorWindowMs?: number;
    readonly detectorStrideMs?: number;
    readonly lastVadAt?: number;
    readonly lastVadState?: "speech-start" | "speech-end";
    readonly lastFinalizedUtteranceMs?: number;
    readonly lastTranscriptionAt?: number;
    readonly lastCompanionTurnAt?: number;
    readonly lastError?: string;
    readonly lastFailureStage?: "transcription" | "companion";
  };
};

export type VoiceWakePowerEvent = "suspend" | "resume" | "lock" | "unlock";

export type VoiceWakeMicrophoneSelection = {
  readonly deviceId: string;
  readonly label?: string;
};

export type VoiceWakeMicrophoneResolution = {
  readonly requestedDevice: boolean;
  readonly usedDefault: boolean;
  readonly fallbackReason?: "saved-device-unavailable";
};

export type VoicePcmFrame = {
  readonly sampleRate: 16_000;
  readonly channels: 1;
  readonly format: "f32";
  readonly samples: Float32Array;
  readonly capturedAt: number;
};
