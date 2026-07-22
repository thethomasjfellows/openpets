import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const managedPocketTtsVersion = "2.1.0" as const;

export type PocketTtsSettings = {
  readonly version: 1;
  readonly enabled: boolean;
  readonly packageVersion: typeof managedPocketTtsVersion;
  readonly host: "127.0.0.1";
  readonly port: 8000;
  readonly installedAt?: number;
};

export const defaultPocketTtsSettings: PocketTtsSettings = {
  version: 1,
  enabled: false,
  packageVersion: managedPocketTtsVersion,
  host: "127.0.0.1",
  port: 8000,
};

export const pocketTtsSettingsFileName = "openpets-pockettts-settings.json";
let settingsPath: string | null = null;
let cached = defaultPocketTtsSettings;

export function initializePocketTtsSettings(userDataPath: string): PocketTtsSettings {
  settingsPath = join(userDataPath, pocketTtsSettingsFileName);
  cached = readSettings(settingsPath);
  return cached;
}

export function getPocketTtsSettings(): PocketTtsSettings {
  return cached;
}

export function updatePocketTtsSettings(patch: Partial<PocketTtsSettings>): PocketTtsSettings {
  cached = normalizeSettings({ ...cached, ...patch });
  if (settingsPath) writeSettings(settingsPath, cached);
  return cached;
}

function normalizeSettings(value: unknown): PocketTtsSettings {
  const raw = isRecord(value) ? value : {};
  const installedAt = typeof raw.installedAt === "number" && Number.isFinite(raw.installedAt) && raw.installedAt > 0
    ? Math.round(raw.installedAt)
    : undefined;
  return {
    ...defaultPocketTtsSettings,
    enabled: raw.enabled === true && installedAt !== undefined,
    ...(installedAt === undefined ? {} : { installedAt }),
  };
}

function readSettings(path: string): PocketTtsSettings {
  try {
    if (!existsSync(path)) return defaultPocketTtsSettings;
    return normalizeSettings(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return defaultPocketTtsSettings;
  }
}

function writeSettings(path: string, settings: PocketTtsSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
