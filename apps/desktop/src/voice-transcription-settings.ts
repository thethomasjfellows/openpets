import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type VoiceTranscriptionProviderId = "local" | "openai" | "none";

export type VoiceTranscriptionSettings = {
  readonly version: 2;
  readonly providerId: VoiceTranscriptionProviderId;
  readonly baseUrl: string;
  readonly model: string;
};

export const defaultVoiceTranscriptionSettings: VoiceTranscriptionSettings = {
  version: 2,
  providerId: "local",
  baseUrl: "https://api.openai.com/v1",
  model: "whisper-1",
};

const settingsFileName = "openpets-transcription-settings.json";
let settingsPath: string | null = null;
let cached = defaultVoiceTranscriptionSettings;

export function initializeVoiceTranscriptionSettings(userDataPath: string): VoiceTranscriptionSettings {
  settingsPath = join(userDataPath, settingsFileName);
  cached = readSettings(settingsPath);
  return cached;
}

export function getVoiceTranscriptionSettings(): VoiceTranscriptionSettings {
  return cached;
}

export function updateVoiceTranscriptionSettings(patch: unknown): VoiceTranscriptionSettings {
  if (!isRecord(patch)) throw new Error("Invalid speech recognition settings.");
  for (const key of Object.keys(patch)) {
    if (key !== "providerId" && key !== "baseUrl" && key !== "model") throw new Error("Invalid speech recognition setting.");
  }
  cached = normalize({ ...cached, ...patch });
  if (settingsPath) writeSettings(settingsPath, cached);
  return cached;
}

export function normalizeVoiceTranscriptionSettings(value: unknown): VoiceTranscriptionSettings {
  return normalize(value);
}

function normalize(value: unknown): VoiceTranscriptionSettings {
  const raw = isRecord(value) ? value : {};
  const providerId: VoiceTranscriptionProviderId = raw.providerId === "openai"
    ? "openai"
    : raw.providerId === "local"
      ? "local"
      : "none";
  const baseUrl = normalizeUrl(raw.baseUrl) || defaultVoiceTranscriptionSettings.baseUrl;
  const model = normalizeText(raw.model, 120) || defaultVoiceTranscriptionSettings.model;
  return { version: 2, providerId, baseUrl, model };
}

function readSettings(path: string): VoiceTranscriptionSettings {
  try {
    return existsSync(path) ? normalize(JSON.parse(readFileSync(path, "utf8"))) : defaultVoiceTranscriptionSettings;
  } catch {
    return defaultVoiceTranscriptionSettings;
  }
}

function writeSettings(path: string, settings: VoiceTranscriptionSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
}

function normalizeUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) return "";
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && !(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"))) return "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function normalizeText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\0/g, "").trim().slice(0, max) : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
