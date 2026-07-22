import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const hostAiProviderIds = ["anthropic", "openai", "openrouter", "ollama", "custom"] as const;
export type HostAiProfileId = typeof hostAiProviderIds[number];
export type HostAiProviderKind = "none" | HostAiProfileId;
export type AiBrainProviderKind = HostAiProviderKind | "codex";

export type HostAiProviderConfig = {
  readonly model: string;
  readonly baseUrl: string;
  readonly requiresApiKey: boolean;
};

export type HostAiSettings = {
  readonly version: 2;
  /** The active direct/local provider. Companion target selection still owns Codex vs host AI. */
  readonly provider: HostAiProviderKind;
  readonly providers: Readonly<Record<HostAiProfileId, HostAiProviderConfig>>;
};

export const defaultHostAiModels: Readonly<Record<HostAiProfileId, string>> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
  openrouter: "openrouter/free",
  ollama: "llama3.2",
  custom: "",
};

export const defaultHostAiBaseUrls: Readonly<Record<HostAiProfileId, string>> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://127.0.0.1:11434/v1",
  custom: "",
};

const defaultRequiresApiKey: Readonly<Record<HostAiProfileId, boolean>> = {
  anthropic: true,
  openai: true,
  openrouter: true,
  ollama: false,
  custom: true,
};

export const defaultHostAiSettings: HostAiSettings = {
  version: 2,
  provider: "none",
  providers: createDefaultProfiles(),
};

export type InitializeHostAiSettingsOptions = {
  readonly legacyAi?: unknown;
  readonly migrateLegacyIfConfigured?: boolean;
};

const settingsFileName = "openpets-host-ai-settings.json";
let settingsPath: string | null = null;
let cached: HostAiSettings = defaultHostAiSettings;

export function initializeHostAiSettings(userDataPath: string, options: InitializeHostAiSettingsOptions = {}): HostAiSettings {
  settingsPath = join(userDataPath, settingsFileName);
  const persisted = readSettingsFile(settingsPath);
  if (persisted.valid) {
    cached = persisted.settings;
    if (persisted.migrated) writeSettingsFile(settingsPath, cached);
    return getHostAiSettings();
  }

  const legacy = normalizeHostAiSettings(options.legacyAi);
  if (options.migrateLegacyIfConfigured === true && legacy.provider !== "none") {
    cached = legacy;
    writeSettingsFile(settingsPath, cached);
    return getHostAiSettings();
  }

  cached = cloneSettings(defaultHostAiSettings);
  return getHostAiSettings();
}

export function getHostAiSettings(): HostAiSettings {
  return cloneSettings(cached);
}

/** Compatibility patch for existing internal callers; new UI should use provider-scoped updates. */
export function updateHostAiSettings(patch: Partial<HostAiSettings> & { readonly model?: string; readonly baseUrl?: string }): HostAiSettings {
  const nextProvider = patch.provider === undefined ? cached.provider : normalizeProvider(patch.provider);
  let providers = normalizeProfiles({ ...cached.providers, ...(isRecord(patch.providers) ? patch.providers : {}) });
  if (nextProvider !== "none" && (patch.model !== undefined || patch.baseUrl !== undefined)) {
    providers = {
      ...providers,
      [nextProvider]: normalizeProviderConfig(nextProvider, {
        ...providers[nextProvider],
        ...(patch.model === undefined ? {} : { model: patch.model }),
        ...(patch.baseUrl === undefined ? {} : { baseUrl: patch.baseUrl }),
      }),
    };
  }
  return commit({ version: 2, provider: nextProvider, providers });
}

export function setActiveHostAiProvider(provider: unknown): HostAiSettings {
  if (!isHostAiProviderId(provider)) throw new Error("Unknown AI provider.");
  return commit({ ...cached, provider });
}

export function updateHostAiProviderConfig(provider: unknown, patch: unknown): HostAiSettings {
  if (!isHostAiProviderId(provider)) throw new Error("Unknown AI provider.");
  if (!isRecord(patch)) throw new Error("Invalid AI provider settings.");
  const allowed = provider === "custom"
    ? new Set(["model", "baseUrl", "requiresApiKey"])
    : provider === "ollama"
      ? new Set(["model", "baseUrl"])
      : new Set(["model"]);
  if (Object.keys(patch).some((key) => !allowed.has(key))) throw new Error("Invalid AI provider setting.");
  const next = normalizeProviderConfig(provider, { ...cached.providers[provider], ...patch });
  if (!next.model && provider !== "custom") throw new Error("Enter a model for this AI provider.");
  if ((provider === "ollama" || provider === "custom") && !next.baseUrl) throw new Error("Enter a valid HTTP or HTTPS provider URL.");
  return commit({ ...cached, providers: { ...cached.providers, [provider]: next } });
}

export function getHostAiProviderConfig(provider: HostAiProfileId): HostAiProviderConfig {
  return { ...cached.providers[provider] };
}

export function normalizeHostAiSettings(value: unknown): HostAiSettings {
  const raw = isRecord(value) ? value : {};
  if (raw.version === 2 && isRecord(raw.providers)) {
    return {
      version: 2,
      provider: normalizeProvider(raw.provider),
      providers: normalizeProfiles(raw.providers),
    };
  }

  // Forward migration from the former single provider/model/baseUrl tuple.
  const legacyProvider = normalizeProvider(raw.provider);
  if (legacyProvider === "none") return cloneSettings(defaultHostAiSettings);
  const legacyModel = normalizeText(raw.model, 120);
  const legacyBaseUrl = normalizeUrl(raw.baseUrl);
  if (legacyProvider === "ollama" && isLegacyCodexOllamaBridge(legacyBaseUrl)) return cloneSettings(defaultHostAiSettings);
  const provider = legacyProvider === "openai" && legacyBaseUrl && trimTrailingSlash(legacyBaseUrl) !== defaultHostAiBaseUrls.openai
    ? "custom"
    : legacyProvider;
  const profiles = createDefaultProfiles();
  profiles[provider] = normalizeProviderConfig(provider, {
    ...profiles[provider],
    model: legacyModel || profiles[provider].model,
    ...(legacyBaseUrl ? { baseUrl: legacyBaseUrl } : {}),
  });
  return { version: 2, provider, providers: profiles };
}

export function isHostAiProviderId(value: unknown): value is HostAiProfileId {
  return typeof value === "string" && (hostAiProviderIds as readonly string[]).includes(value);
}

function normalizeProvider(value: unknown): HostAiProviderKind {
  return value === "none" || isHostAiProviderId(value) ? value : "none";
}

function normalizeProfiles(value: Record<string, unknown>): Record<HostAiProfileId, HostAiProviderConfig> {
  const profiles = createDefaultProfiles();
  for (const provider of hostAiProviderIds) {
    profiles[provider] = normalizeProviderConfig(provider, isRecord(value[provider]) ? value[provider] : profiles[provider]);
  }
  return profiles;
}

function normalizeProviderConfig(provider: HostAiProfileId, value: Record<string, unknown>): HostAiProviderConfig {
  const model = normalizeText(value.model, 120) || defaultHostAiModels[provider];
  const baseUrl = provider === "ollama" || provider === "custom"
    ? normalizeUrl(value.baseUrl) || defaultHostAiBaseUrls[provider]
    : defaultHostAiBaseUrls[provider];
  const requiresApiKey = provider === "custom"
    ? value.requiresApiKey !== false
    : defaultRequiresApiKey[provider];
  return { model, baseUrl, requiresApiKey };
}

function createDefaultProfiles(): Record<HostAiProfileId, HostAiProviderConfig> {
  return Object.fromEntries(hostAiProviderIds.map((provider) => [provider, {
    model: defaultHostAiModels[provider],
    baseUrl: defaultHostAiBaseUrls[provider],
    requiresApiKey: defaultRequiresApiKey[provider],
  }])) as Record<HostAiProfileId, HostAiProviderConfig>;
}

function cloneSettings(settings: HostAiSettings): HostAiSettings {
  return {
    version: 2,
    provider: settings.provider,
    providers: Object.fromEntries(hostAiProviderIds.map((provider) => [provider, { ...settings.providers[provider] }])) as Record<HostAiProfileId, HostAiProviderConfig>,
  };
}

function commit(next: HostAiSettings): HostAiSettings {
  cached = cloneSettings(next);
  if (settingsPath) writeSettingsFile(settingsPath, cached);
  return getHostAiSettings();
}

function isLegacyCodexOllamaBridge(baseUrl: string): boolean {
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    return (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      && url.port === "18081"
      && (url.pathname === "/v1" || url.pathname === "/v1/");
  } catch {
    return false;
  }
}

function normalizeText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max) : "";
}

function normalizeUrl(value: unknown): string {
  const text = normalizeText(value, 300);
  if (!text) return "";
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? trimTrailingSlash(text) : "";
  } catch {
    return "";
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSettingsFile(path: string): { readonly valid: boolean; readonly migrated: boolean; readonly settings: HostAiSettings } {
  try {
    if (!existsSync(path)) return { valid: false, migrated: false, settings: cloneSettings(defaultHostAiSettings) };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed)) return { valid: false, migrated: false, settings: cloneSettings(defaultHostAiSettings) };
    return { valid: true, migrated: parsed.version !== 2, settings: normalizeHostAiSettings(parsed) };
  } catch {
    return { valid: false, migrated: false, settings: cloneSettings(defaultHostAiSettings) };
  }
}

function writeSettingsFile(path: string, settings: HostAiSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}
