import type { VoicePcmFrame, VoiceWakeTurnState } from "./voice-wake-types.js";

export type VoiceWakeActivationConfig = {
  readonly minimumSpeechMs: number;
  readonly maximumUtteranceMs: number;
  readonly cooldownMs: number;
};

export type FinalizedVoiceUtterance = {
  readonly sampleRate: 16_000;
  readonly samples: Float32Array;
  readonly durationMs: number;
};

const defaultConfig: VoiceWakeActivationConfig = {
  minimumSpeechMs: 250,
  maximumUtteranceMs: 30_000,
  cooldownMs: 750,
};

/** Pure in-memory activation policy; it never opens a mic, writes files, or calls a provider. */
export class VoiceWakeActivation {
  #config: VoiceWakeActivationConfig;
  #utterance: Float32Array[] = [];
  #utteranceSamples = 0;
  #speechSamples = 0;
  #finalized: FinalizedVoiceUtterance | null = null;
  #turnState: VoiceWakeTurnState = "idle";
  #cooldownUntil = 0;
  #outputActive = false;
  #acceptingCommandAudio = false;

  constructor(config: Partial<VoiceWakeActivationConfig> = {}) {
    this.#config = {
      minimumSpeechMs: clamp(config.minimumSpeechMs, 100, 2_000, defaultConfig.minimumSpeechMs),
      maximumUtteranceMs: clamp(config.maximumUtteranceMs, 1_000, 30_000, defaultConfig.maximumUtteranceMs),
      cooldownMs: clamp(config.cooldownMs, 0, 5_000, defaultConfig.cooldownMs),
    };
  }

  get turnState(): VoiceWakeTurnState {
    return this.#turnState;
  }

  ingest(frame: VoicePcmFrame): void {
    if ((this.#turnState === "activated" || this.#turnState === "collecting") && this.#acceptingCommandAudio) {
      this.#appendUtterance(frame.samples);
      if (hasSpeechEnergy(frame.samples)) {
        this.#turnState = "collecting";
        this.#speechSamples += frame.samples.length;
      }
      if (this.#utteranceSamples >= msToSamples(this.#config.maximumUtteranceMs)) this.#finish();
      return;
    }
  }

  keywordDetected(now = Date.now(), options: { readonly requireNextUtterance?: boolean } = {}): boolean {
    if (this.#turnState !== "idle" || this.#outputActive || now < this.#cooldownUntil) return false;
    this.#utterance = [];
    this.#utteranceSamples = 0;
    this.#speechSamples = 0;
    this.#acceptingCommandAudio = options.requireNextUtterance !== true;
    this.#turnState = "activated";
    return true;
  }

  /** Begin a deliberate post-response turn without requiring another keyword. */
  beginFollowUp(): void {
    this.#outputActive = false;
    this.#utterance = [];
    this.#utteranceSamples = 0;
    this.#speechSamples = 0;
    this.#finalized = null;
    this.#acceptingCommandAudio = true;
    this.#turnState = "activated";
  }

  vad(state: "speech-start" | "speech-end"): void {
    if (state === "speech-start" && this.#turnState === "activated" && this.#acceptingCommandAudio) {
      this.#turnState = "collecting";
      return;
    }
    if (state === "speech-end" && (this.#turnState === "activated" || this.#turnState === "collecting")) {
      if (!this.#acceptingCommandAudio) {
        this.#acceptingCommandAudio = true;
        return;
      }
      this.#finish();
    }
  }

  outputStarted(): void {
    this.#outputActive = true;
    this.cancel();
    this.#turnState = "speaking";
  }

  outputEnded(now = Date.now()): void {
    this.#outputActive = false;
    this.#cooldownUntil = now + this.#config.cooldownMs;
    this.#turnState = this.#config.cooldownMs > 0 ? "cooldown" : "idle";
  }

  tick(now = Date.now()): void {
    if (this.#turnState === "cooldown" && now >= this.#cooldownUntil) this.#turnState = "idle";
  }

  consumeFinalized(): FinalizedVoiceUtterance | null {
    const finalized = this.#finalized;
    this.#finalized = null;
    return finalized;
  }

  cancel(): void {
    this.#utterance = [];
    this.#utteranceSamples = 0;
    this.#speechSamples = 0;
    this.#acceptingCommandAudio = false;
    this.#finalized = null;
    if (!this.#outputActive) this.#turnState = "idle";
  }

  reset(): void {
    this.#utterance = [];
    this.#utteranceSamples = 0;
    this.#speechSamples = 0;
    this.#acceptingCommandAudio = false;
    this.#finalized = null;
    this.#outputActive = false;
    this.#cooldownUntil = 0;
    this.#turnState = "idle";
  }

  #appendUtterance(samples: Float32Array): void {
    this.#utterance.push(samples.slice());
    this.#utteranceSamples += samples.length;
  }

  #finish(): void {
    const minimum = msToSamples(this.#config.minimumSpeechMs);
    if (this.#speechSamples >= minimum) {
      const samples = joinFrames(this.#utterance, this.#utteranceSamples);
      this.#finalized = { sampleRate: 16_000, samples, durationMs: Math.round(samples.length / 16) };
      this.#turnState = "endpointing";
    } else {
      this.#turnState = "idle";
    }
    this.#utterance = [];
    this.#utteranceSamples = 0;
    this.#speechSamples = 0;
    this.#acceptingCommandAudio = false;
  }
}

function hasSpeechEnergy(samples: Float32Array): boolean {
  if (samples.length === 0) return false;
  let squaredTotal = 0;
  for (const sample of samples) squaredTotal += sample * sample;
  return Math.sqrt(squaredTotal / samples.length) >= 0.01;
}

function joinFrames(frames: readonly Float32Array[], total: number): Float32Array {
  const joined = new Float32Array(total);
  let offset = 0;
  for (const frame of frames) {
    joined.set(frame, offset);
    offset += frame.length;
  }
  return joined;
}

function msToSamples(ms: number): number {
  return Math.round(ms * 16);
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
