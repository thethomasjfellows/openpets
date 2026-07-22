import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { canonicalWakeText, normalizeWakeInterpretations } from "./voice-wake-calibration-normalization.js";
import {
  officialVoiceWakePhrase,
  officialVoiceWakePhraseId,
  type VoiceWakeEngine,
  type VoiceWakeMicrophoneSelection,
  type VoiceWakeSensitivity,
} from "./voice-wake-types.js";

export { canonicalWakeText };

export const voiceProviderIds = ["system", "pockettts", "openai-compatible", "elevenlabs"] as const;
export type VoiceProviderId = typeof voiceProviderIds[number];
export type VoiceOverlapPolicy = "interrupt" | "queue" | "ignore";
export type VoiceProviderFallbackPolicy = "system" | "fail";
export type VoiceFallbackPolicy = "provider-default" | "fail";

export type VoiceSelection = {
  readonly providerId: VoiceProviderId;
  readonly voiceId?: string;
  readonly model?: string;
  readonly overlapPolicy: VoiceOverlapPolicy;
  readonly providerFallback: VoiceProviderFallbackPolicy;
  readonly voiceFallback: VoiceFallbackPolicy;
};

export type VoiceAttemptPlanEntry = {
  readonly providerId: VoiceProviderId;
  readonly useProviderDefault: boolean;
  readonly fallbackReason?: string;
};

export type VoiceSettings = {
  readonly version: 4;
  readonly output: VoiceSelection;
  readonly providers: {
    readonly system: { readonly voiceId?: string; readonly rate: number };
    readonly pockettts: { readonly baseUrl: string; readonly voiceId: string };
    readonly "openai-compatible": { readonly baseUrl: string; readonly voiceId: string; readonly model: string };
    readonly elevenlabs: { readonly baseUrl: string; readonly voiceId: string; readonly model: string; readonly outputFormat: string };
  };
  readonly wake: {
    readonly engine: VoiceWakeEngine;
    readonly phraseId: typeof officialVoiceWakePhraseId;
    readonly phrase: string;
    readonly sensitivity: VoiceWakeSensitivity;
    readonly microphone?: VoiceWakeMicrophoneSelection;
    readonly calibration?: {
      readonly phrase: string;
      readonly variants: readonly string[];
      readonly updatedAt: number;
    };
  };
};

export type VoiceSettingsSnapshot = VoiceSettings & {
  readonly installedPets: ReadonlyArray<{ readonly id: string; readonly displayName: string; readonly available: boolean }>;
};

export const defaultVoiceSettings: VoiceSettings = {
  version: 4,
  output: {
    providerId: "system",
    overlapPolicy: "interrupt",
    providerFallback: "system",
    voiceFallback: "provider-default",
  },
  providers: {
    system: { rate: 1 },
    pockettts: { baseUrl: "http://127.0.0.1:8000", voiceId: "alba" },
    "openai-compatible": { baseUrl: "https://api.openai.com/v1", voiceId: "alloy", model: "gpt-4o-mini-tts" },
    elevenlabs: { baseUrl: "https://api.elevenlabs.io", voiceId: "", model: "eleven_multilingual_v2", outputFormat: "mp3_44100_128" },
  },
  wake: {
    engine: "official-livekit",
    phraseId: officialVoiceWakePhraseId,
    phrase: officialVoiceWakePhrase,
    sensitivity: "easy",
  },
};

const settingsFileName = "openpets-voice-settings.json";
let settingsPath: string | null = null;
let cached: VoiceSettings = defaultVoiceSettings;
const listeners = new Set<(settings: VoiceSettings) => void>();

export function initializeVoiceSettings(userDataPath: string): VoiceSettings {
  settingsPath = join(userDataPath, settingsFileName);
  cached = readVoiceSettingsFile(settingsPath);
  return cached;
}

export function getVoiceSettings(): VoiceSettings {
  return cached;
}

export function getVoiceSettingsSnapshot(installedPets: ReadonlyArray<{ readonly id: string; readonly displayName: string; readonly broken?: boolean; readonly brokenReason?: string }>): VoiceSettingsSnapshot {
  return {
    ...cached,
    installedPets: installedPets.map((pet) => ({ id: pet.id, displayName: pet.displayName, available: !pet.broken && !pet.brokenReason })),
  };
}

export function resolveVoiceSelection(settings: VoiceSettings, _petId: string): VoiceSelection {
  return settings.output;
}

export function resolveVoiceAttemptPlan(selection: VoiceSelection, chosenVoice: string | undefined, allowFallback: boolean): VoiceAttemptPlanEntry[] {
  const attempts: VoiceAttemptPlanEntry[] = [{ providerId: selection.providerId, useProviderDefault: false }];
  if (!allowFallback) return attempts;
  if (chosenVoice && selection.voiceFallback === "provider-default") {
    attempts.push({ providerId: selection.providerId, useProviderDefault: true, fallbackReason: `Fallback after voice ${chosenVoice} failed.` });
  }
  if (selection.providerFallback === "system" && selection.providerId !== "system") {
    attempts.push({ providerId: "system", useProviderDefault: true, fallbackReason: `Fallback after ${selection.providerId} failed.` });
  }
  return attempts;
}

export function updateVoiceSettings(patch: unknown): VoiceSettings {
  if (!isRecord(patch)) throw new Error("Invalid voice settings patch.");
  cached = normalizeVoiceSettings(mergeVoiceSettings(cached, patch));
  if (settingsPath) writeVoiceSettingsFile(settingsPath, cached);
  for (const listener of listeners) {
    try { listener(cached); } catch { /* listeners are isolated */ }
  }
  return cached;
}

export function onVoiceSettingsChanged(listener: (settings: VoiceSettings) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function normalizeVoiceSettings(value: unknown): VoiceSettings {
  const raw = isRecord(value) ? value : {};
  const output = isRecord(raw.output) ? raw.output : {};
  const providers = isRecord(raw.providers) ? raw.providers : {};
  const system = isRecord(providers.system) ? providers.system : {};
  const pocket = isRecord(providers.pockettts) ? providers.pockettts : {};
  const openai = isRecord(providers["openai-compatible"]) ? providers["openai-compatible"] : {};
  const eleven = isRecord(providers.elevenlabs) ? providers.elevenlabs : {};
  const wake = isRecord(raw.wake) ? raw.wake : {};
  const requestedPhrase = normalizeText(wake.phrase, 120, defaultVoiceSettings.wake.phrase);
  const calibration = normalizeWakeCalibration(wake.calibration);
  const microphone = normalizeWakeMicrophone(wake.microphone);
  const engine = normalizeWakeEngine(wake.engine, requestedPhrase);
  const phrase = engine === "official-livekit" ? officialVoiceWakePhrase : requestedPhrase;
  const sensitivity = normalizeEnum(wake.sensitivity, ["strict", "balanced", "easy"] as const, "easy");
  return {
    version: 4,
    output: {
      providerId: normalizeProviderId(output.providerId, "system"),
      voiceId: normalizeOptionalText(output.voiceId, 160),
      model: normalizeOptionalText(output.model, 160),
      overlapPolicy: normalizeEnum(output.overlapPolicy, ["interrupt", "queue", "ignore"], "interrupt"),
      providerFallback: normalizeEnum(output.providerFallback, ["system", "fail"], "system"),
      voiceFallback: normalizeEnum(output.voiceFallback, ["provider-default", "fail"], "provider-default"),
    },
    providers: {
      system: { voiceId: normalizeOptionalText(system.voiceId, 160), rate: clampNumber(system.rate, 0.5, 2, 1) },
      pockettts: { baseUrl: normalizeUrl(pocket.baseUrl, defaultVoiceSettings.providers.pockettts.baseUrl), voiceId: normalizeText(pocket.voiceId, 160, "alba") },
      "openai-compatible": { baseUrl: normalizeUrl(openai.baseUrl, defaultVoiceSettings.providers["openai-compatible"].baseUrl), voiceId: normalizeText(openai.voiceId, 160, "alloy"), model: normalizeText(openai.model, 160, "gpt-4o-mini-tts") },
      elevenlabs: { baseUrl: normalizeUrl(eleven.baseUrl, defaultVoiceSettings.providers.elevenlabs.baseUrl), voiceId: normalizeText(eleven.voiceId, 200, ""), model: normalizeText(eleven.model, 160, "eleven_multilingual_v2"), outputFormat: normalizeText(eleven.outputFormat, 80, "mp3_44100_128") },
    },
    // Legacy wake.enabled is intentionally ignored. Companion settings own
    // explicit always-armed microphone consent; Voice settings own the phrase.
    wake: {
      engine,
      phraseId: officialVoiceWakePhraseId,
      phrase,
      sensitivity,
      ...(microphone ? { microphone } : {}),
      ...(engine === "custom-sherpa" && calibration ? { calibration } : {}),
    },
  };
}

function normalizeWakeEngine(value: unknown, phrase: string): VoiceWakeEngine {
  if (value === "official-livekit" || value === "custom-sherpa") return value;
  const canonical = canonicalWakeText(phrase);
  return canonical === canonicalWakeText(officialVoiceWakePhrase)
    || canonical === canonicalWakeText("Hey OpenPet")
    ? "official-livekit"
    : "custom-sherpa";
}

function normalizeWakeMicrophone(value: unknown): VoiceWakeMicrophoneSelection | undefined {
  if (!isRecord(value)) return undefined;
  const deviceId = normalizeOptionalText(value.deviceId, 512);
  const label = normalizeOptionalText(value.label, 160);
  return deviceId ? { deviceId, ...(label ? { label } : {}) } : undefined;
}

function normalizeWakeCalibration(value: unknown): VoiceSettings["wake"]["calibration"] {
  if (!isRecord(value)) return undefined;
  const phrase = normalizeText(value.phrase, 120, "");
  const updatedAt = typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) && value.updatedAt > 0
    ? Math.round(value.updatedAt)
    : 0;
  if (!phrase || !updatedAt || !Array.isArray(value.variants)) return undefined;
  const variants = normalizeWakeInterpretations(phrase, value.variants);
  return { phrase, variants, updatedAt };
}

function mergeVoiceSettings(current: VoiceSettings, patch: Record<string, unknown>): unknown {
  return {
    ...current,
    ...patch,
    output: { ...current.output, ...(isRecord(patch.output) ? patch.output : {}) },
    providers: {
      ...current.providers,
      ...(isRecord(patch.providers) ? patch.providers : {}),
      system: { ...current.providers.system, ...(isRecord(patch.providers) && isRecord(patch.providers.system) ? patch.providers.system : {}) },
      pockettts: { ...current.providers.pockettts, ...(isRecord(patch.providers) && isRecord(patch.providers.pockettts) ? patch.providers.pockettts : {}) },
      "openai-compatible": { ...current.providers["openai-compatible"], ...(isRecord(patch.providers) && isRecord(patch.providers["openai-compatible"]) ? patch.providers["openai-compatible"] : {}) },
      elevenlabs: { ...current.providers.elevenlabs, ...(isRecord(patch.providers) && isRecord(patch.providers.elevenlabs) ? patch.providers.elevenlabs : {}) },
    },
    wake: { ...current.wake, ...(isRecord(patch.wake) ? patch.wake : {}) },
  };
}

function readVoiceSettingsFile(path: string): VoiceSettings {
  try {
    if (!existsSync(path)) return defaultVoiceSettings;
    return normalizeVoiceSettings(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return defaultVoiceSettings;
  }
}

function writeVoiceSettingsFile(path: string, settings: VoiceSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function normalizeProviderId(value: unknown, fallback: VoiceProviderId): VoiceProviderId {
  return voiceProviderIds.includes(value as VoiceProviderId) ? value as VoiceProviderId : fallback;
}

function normalizeEnum<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return values.includes(value as T) ? value as T : fallback;
}

function normalizeUrl(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length > 500) return fallback;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return fallback;
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return fallback;
  }
}

function normalizeText(value: unknown, max: number, fallback: string): string {
  return typeof value === "string" ? value.trim().slice(0, max) : fallback;
}

function normalizeOptionalText(value: unknown, max: number): string | undefined {
  const normalized = normalizeText(value, max, "");
  return normalized || undefined;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
