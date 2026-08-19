import type { VoicePcmFrame } from "./voice-wake-types.js";

export const voiceWakeProtocolVersion = 2 as const;
export const maxVoiceWakePhraseCharacters = 120;
export const maxVoiceWakeVariants = 15;
export const maxVoiceWakeFrameSamples = 16_000;
export const maxVoiceWakeMessageCharacters = 500;

export type VoiceWakeHelperCommand =
  | { readonly version: 2; readonly type: "configure"; readonly mode?: "kws-vad" | "vad-only"; readonly phrase: string; readonly variants: readonly string[] }
  | { readonly version: 2; readonly type: "pcm"; readonly frame: VoicePcmFrame }
  | { readonly version: 2; readonly type: "reset" }
  | { readonly version: 2; readonly type: "stop" };

export type VoiceWakeHelperEvent =
  | { readonly version: 2; readonly type: "ready" }
  | {
      readonly version: 2;
      readonly type: "keyword";
      readonly score: number;
      readonly capturedAt?: number;
      readonly windowMs?: number;
      readonly strideMs?: number;
    }
  | { readonly version: 2; readonly type: "vad"; readonly state: "speech-start" | "speech-end"; readonly score: number }
  | { readonly version: 2; readonly type: "error"; readonly code?: "phrase-not-supported"; readonly message: string }
  | { readonly version: 2; readonly type: "log"; readonly level: "debug" | "info" | "warn"; readonly message: string };

export function normalizeVoiceWakePhrase(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, maxVoiceWakePhraseCharacters) : "";
}

export function isValidVoiceWakePcmFrame(value: unknown): value is VoicePcmFrame {
  if (!isRecord(value)) return false;
  return value.sampleRate === 16_000
    && value.channels === 1
    && value.format === "f32"
    && value.samples instanceof Float32Array
    && value.samples.length > 0
    && value.samples.length <= maxVoiceWakeFrameSamples
    && Number.isFinite(value.capturedAt);
}

export function parseVoiceWakeHelperEvent(value: unknown): VoiceWakeHelperEvent | null {
  if (!isRecord(value) || value.version !== voiceWakeProtocolVersion || typeof value.type !== "string") return null;
  if (value.type === "ready") return { version: 2, type: "ready" };
  if (value.type === "keyword" && isScore(value.score)) {
    const capturedAt = optionalNonNegativeNumber(value.capturedAt);
    const windowMs = optionalPositiveNumber(value.windowMs);
    const strideMs = optionalPositiveNumber(value.strideMs);
    if (capturedAt === null || windowMs === null || strideMs === null) return null;
    return {
      version: 2,
      type: "keyword",
      score: value.score,
      ...(capturedAt === undefined ? {} : { capturedAt }),
      ...(windowMs === undefined ? {} : { windowMs }),
      ...(strideMs === undefined ? {} : { strideMs }),
    };
  }
  if (value.type === "vad" && (value.state === "speech-start" || value.state === "speech-end") && isScore(value.score)) {
    return { version: 2, type: "vad", state: value.state, score: value.score };
  }
  if (value.type === "error") {
    const message = sanitizeVoiceWakeMessage(value.message);
    const code = value.code === undefined
      ? undefined
      : value.code === "phrase-not-supported"
        ? value.code
        : null;
    if (!message || code === null) return null;
    return { version: 2, type: "error", ...(code ? { code } : {}), message };
  }
  if (value.type === "log" && (value.level === "debug" || value.level === "info" || value.level === "warn")) {
    const message = sanitizeVoiceWakeMessage(value.message);
    return message ? { version: 2, type: "log", level: value.level, message } : null;
  }
  return null;
}

export function sanitizeVoiceWakeMessage(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/(?:[A-Za-z]:\\|\/)[^\s]+/g, "[path]")
    .trim()
    .slice(0, maxVoiceWakeMessageCharacters);
}

function isScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function optionalNonNegativeNumber(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function optionalPositiveNumber(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
