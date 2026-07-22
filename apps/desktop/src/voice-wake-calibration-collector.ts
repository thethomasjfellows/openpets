import type { VoicePcmFrame } from "./voice-wake-types.js";

const sampleRate = 16_000;
const preRollSamples = sampleRate / 2;
const maximumUtteranceSamples = sampleRate * 20;
const minimumUtteranceSamples = sampleRate / 5;
const minimumRms = 0.001;

export class VoiceWakeCalibrationCollector {
  #preRoll: Float32Array[] = [];
  #preRollLength = 0;
  #utterance: Float32Array[] | null = null;
  #utteranceLength = 0;
  #attempts = 0;

  get attempts(): number {
    return this.#attempts;
  }

  get recording(): boolean {
    return this.#utterance !== null;
  }

  ingest(frame: VoicePcmFrame): void {
    const samples = new Float32Array(frame.samples);
    this.#rememberPreRoll(samples);
    if (!this.#utterance || this.#utteranceLength >= maximumUtteranceSamples) return;
    const remaining = maximumUtteranceSamples - this.#utteranceLength;
    const accepted = samples.length <= remaining ? samples : samples.slice(0, remaining);
    this.#utterance.push(accepted);
    this.#utteranceLength += accepted.length;
  }

  vad(state: "speech-start" | "speech-end"): Float32Array | null {
    if (state === "speech-start") {
      if (this.#utterance) return null;
      this.#attempts += 1;
      this.#utterance = this.#preRoll.map((samples) => new Float32Array(samples));
      this.#utteranceLength = this.#utterance.reduce((sum, samples) => sum + samples.length, 0);
      return null;
    }
    if (!this.#utterance) return null;
    const chunks = this.#utterance;
    const length = this.#utteranceLength;
    this.#utterance = null;
    this.#utteranceLength = 0;
    if (length < minimumUtteranceSamples) return null;
    const samples = new Float32Array(length);
    let offset = 0;
    let squareSum = 0;
    for (const chunk of chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
      for (const sample of chunk) squareSum += sample * sample;
    }
    return Math.sqrt(squareSum / Math.max(1, samples.length)) >= minimumRms ? samples : null;
  }

  resetUtterance(): void {
    this.#utterance = null;
    this.#utteranceLength = 0;
  }

  #rememberPreRoll(samples: Float32Array): void {
    this.#preRoll.push(samples);
    this.#preRollLength += samples.length;
    while (this.#preRollLength > preRollSamples && this.#preRoll.length > 0) {
      const first = this.#preRoll[0]!;
      const overflow = this.#preRollLength - preRollSamples;
      if (first.length <= overflow) {
        this.#preRoll.shift();
        this.#preRollLength -= first.length;
      } else {
        this.#preRoll[0] = first.slice(overflow);
        this.#preRollLength -= overflow;
      }
    }
  }
}
