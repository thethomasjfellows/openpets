import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { isHostAiProviderId, type HostAiProfileId } from "./host-ai-settings.js";

export const visionPauseMinutes = [30, 60, 90] as const;
export type VisionPauseMinutes = typeof visionPauseMinutes[number];

export type VisionModelPreference =
  | { readonly owner: "codex"; readonly model: string }
  | { readonly owner: "host-ai"; readonly provider: HostAiProfileId; readonly model: string };

export type VisionSettings = {
  readonly version: 1;
  readonly enabled: boolean;
  readonly pausedUntil?: number;
  readonly modelPreference?: VisionModelPreference;
};

export const defaultVisionSettings: VisionSettings = {
  version: 1,
  enabled: false,
};

export const visionSettingsFileName = "openpets-vision-settings.json";

let settingsPath: string | null = null;
let cached: VisionSettings = defaultVisionSettings;
const listeners = new Set<(settings: VisionSettings) => void>();

export function initializeVisionSettings(userDataPath: string, now = Date.now()): VisionSettings {
  settingsPath = join(userDataPath, visionSettingsFileName);
  cached = normalizeVisionSettings(readVisionSettingsFile(settingsPath), now);
  return cached;
}

export function getVisionSettings(now = Date.now()): VisionSettings {
  const normalized = normalizeVisionSettings(cached, now);
  if (!sameSettings(cached, normalized)) return commitVisionSettings(normalized);
  return cached;
}

export function getVisionSettingsFilePath(): string {
  if (!settingsPath) throw new Error("Vision settings have not been initialized.");
  return settingsPath;
}

export function updateVisionSettings(patch: unknown, now = Date.now()): VisionSettings {
  if (!isRecord(patch)) throw new Error("Invalid Vision settings patch.");
  const next: Record<string, unknown> = { ...cached };
  if ("enabled" in patch) next.enabled = patch.enabled;
  if ("pausedUntil" in patch) next.pausedUntil = patch.pausedUntil;
  if ("modelPreference" in patch) next.modelPreference = patch.modelPreference;
  return commitVisionSettings(normalizeVisionSettings(next, now));
}

export function setVisionModelPreference(preference: VisionModelPreference | undefined, now = Date.now()): VisionSettings {
  return updateVisionSettings({ modelPreference: preference }, now);
}

export function setVisionEnabled(enabled: boolean, now = Date.now()): VisionSettings {
  if (typeof enabled !== "boolean") throw new Error("Vision enabled must be a boolean.");
  return commitVisionSettings(normalizeVisionSettings({
    ...cached,
    enabled,
    ...(enabled ? {} : { pausedUntil: undefined }),
  }, now));
}

export function pauseVisionFor(minutes: VisionPauseMinutes, now = Date.now()): VisionSettings {
  if (!visionPauseMinutes.includes(minutes)) throw new Error("Vision pause must be 30, 60, or 90 minutes.");
  if (!getVisionSettings(now).enabled) return cached;
  return commitVisionSettings({
    version: 1,
    enabled: true,
    pausedUntil: Math.floor(now + minutes * 60 * 1_000),
    ...(cached.modelPreference ? { modelPreference: cached.modelPreference } : {}),
  });
}

export function resumeVision(now = Date.now()): VisionSettings {
  return commitVisionSettings(normalizeVisionSettings({
    ...cached,
    pausedUntil: undefined,
  }, now));
}

export function isVisionPaused(settings = getVisionSettings(), now = Date.now()): boolean {
  return settings.enabled && settings.pausedUntil !== undefined && settings.pausedUntil > now;
}

export function onVisionSettingsChanged(listener: (settings: VisionSettings) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function normalizeVisionSettings(value: unknown, now = Date.now()): VisionSettings {
  const raw = isRecord(value) ? value : {};
  const enabled = raw.enabled === true;
  const pausedUntil = enabled
    && typeof raw.pausedUntil === "number"
    && Number.isFinite(raw.pausedUntil)
    && raw.pausedUntil > now
    ? Math.floor(raw.pausedUntil)
    : undefined;
  const modelPreference = normalizeModelPreference(raw.modelPreference);
  return {
    version: 1,
    enabled,
    ...(pausedUntil === undefined ? {} : { pausedUntil }),
    ...(modelPreference === undefined ? {} : { modelPreference }),
  };
}

function commitVisionSettings(next: VisionSettings): VisionSettings {
  if (settingsPath) writeVisionSettingsFile(settingsPath, next);
  cached = next;
  for (const listener of listeners) {
    try { listener(cached); } catch { /* listeners are isolated */ }
  }
  return cached;
}

function readVisionSettingsFile(path: string): unknown {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function writeVisionSettingsFile(path: string, settings: VisionSettings): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
  } catch (error) {
    try { rmSync(temporaryPath, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function sameSettings(left: VisionSettings, right: VisionSettings): boolean {
  return left.enabled === right.enabled
    && left.pausedUntil === right.pausedUntil
    && JSON.stringify(left.modelPreference) === JSON.stringify(right.modelPreference);
}

function normalizeModelPreference(value: unknown): VisionModelPreference | undefined {
  if (!isRecord(value) || typeof value.model !== "string") return undefined;
  const model = value.model.trim().slice(0, 160);
  if (!model) return undefined;
  if (value.owner === "codex") return { owner: "codex", model };
  if (value.owner === "host-ai" && isHostAiProviderId(value.provider)) {
    return { owner: "host-ai", provider: value.provider, model };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
