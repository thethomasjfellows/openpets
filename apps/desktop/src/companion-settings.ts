import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { companionFrequencies, companionTargetIds, type CompanionFrequency, type CompanionTargetId } from "./companion-types.js";

export type CompanionProfile = {
  readonly name: string;
  readonly preferredAddress: string;
  readonly aboutYou: string;
};

export type CompanionCharacterProfile = {
  readonly visibleName: string;
  readonly species: string;
  readonly origin: string;
  readonly appearance: string;
  readonly personality: string;
  readonly quirks: string;
  readonly lifeStory: string;
};

export type CompanionSettings = {
  readonly version: 2;
  /** Version 0 has not accepted the Companion disclosure and therefore cannot be enabled. */
  readonly consentVersion: 0 | 1;
  readonly enabled: boolean;
  readonly target: CompanionTargetId;
  readonly codex: { readonly model: string; readonly reasoningEffort: string };
  readonly profile: CompanionProfile;
  readonly characters: Readonly<Record<string, CompanionCharacterProfile>>;
  readonly memory: { readonly enabled: boolean };
  readonly proactivity: { readonly enabled: boolean; readonly frequency: CompanionFrequency };
  readonly wake: { readonly enabled: boolean; readonly followUpEnabled: boolean };
};

export type CompanionSettingsPatch = {
  readonly target?: CompanionTargetId;
  readonly codex?: { readonly model?: string; readonly reasoningEffort?: string };
  readonly profile?: Partial<CompanionProfile>;
  readonly memory?: { readonly enabled?: boolean };
  readonly proactivity?: { readonly enabled?: boolean; readonly frequency?: CompanionFrequency };
  readonly wake?: { readonly enabled?: boolean; readonly followUpEnabled?: boolean };
};

export const maxCompanionGoals = 5;
export const maxCompanionGoalCharacters = 240;
export const maxCompanionAboutYouCharacters = 4_000;
export const maxCompanionCharacterProfiles = 200;
export const companionCharacterFieldLimits = {
  visibleName: 120,
  species: 160,
  origin: 500,
  appearance: 700,
  personality: 900,
  quirks: 700,
  lifeStory: 1_200,
} as const;

export const defaultCompanionSettings: CompanionSettings = {
  version: 2,
  consentVersion: 0,
  enabled: false,
  target: "codex",
  codex: { model: "", reasoningEffort: "" },
  profile: { name: "", preferredAddress: "", aboutYou: "" },
  characters: {},
  memory: { enabled: false },
  proactivity: { enabled: false, frequency: "sometimes" },
  wake: { enabled: false, followUpEnabled: true },
};

export const companionSettingsFileName = "openpets-companion-settings.json";

let settingsPath: string | null = null;
let cached: CompanionSettings = defaultCompanionSettings;
const listeners = new Set<(settings: CompanionSettings) => void>();

export function initializeCompanionSettings(userDataPath: string): CompanionSettings {
  settingsPath = join(userDataPath, companionSettingsFileName);
  cached = readCompanionSettingsFile(settingsPath);
  return cached;
}

export function getCompanionSettings(): CompanionSettings {
  return cached;
}

export function getCompanionSettingsFilePath(): string {
  if (!settingsPath) throw new Error("Companion settings have not been initialized.");
  return settingsPath;
}

/**
 * Accept the disclosure and turn Companion on. The first call commits all
 * disclosed defaults as one atomic file replacement; later re-enables preserve
 * the user's independently reversible choices.
 */
export function enableCompanion(): CompanionSettings {
  const next = cached.consentVersion === 0
    ? normalizeCompanionSettings({
      ...cached,
      consentVersion: 1,
      enabled: true,
      memory: { enabled: true },
      proactivity: { enabled: true, frequency: "sometimes" },
      wake: { enabled: false, followUpEnabled: cached.wake.followUpEnabled },
    })
    : normalizeCompanionSettings({ ...cached, enabled: true });
  return commitSettings(next);
}

export function disableCompanion(): CompanionSettings {
  return commitSettings(normalizeCompanionSettings({ ...cached, enabled: false }));
}

/** Update allow-listed preferences without granting disclosure consent. */
export function updateCompanionSettings(patch: unknown): CompanionSettings {
  if (!isRecord(patch)) throw new Error("Invalid companion settings patch.");
  const next: Record<string, unknown> = { ...cached };
  if ("target" in patch) next.target = patch.target;
  if (isRecord(patch.codex)) next.codex = { ...cached.codex, ...patch.codex };
  if (isRecord(patch.profile)) next.profile = { ...cached.profile, ...patch.profile };
  if (isRecord(patch.memory)) next.memory = { ...cached.memory, ...patch.memory };
  if (isRecord(patch.proactivity)) next.proactivity = { ...cached.proactivity, ...patch.proactivity };
  if (isRecord(patch.wake)) next.wake = { ...cached.wake, ...patch.wake };
  return commitSettings(normalizeCompanionSettings(next));
}

export function updateCompanionCharacterSettings(petId: string, patch: unknown): CompanionSettings {
  assertSafeCompanionPetId(petId);
  if (!isRecord(patch)) throw new Error("Invalid companion character settings patch.");
  const previous = cached.characters[petId] ?? emptyCompanionCharacterProfile();
  const character = normalizeCharacterProfile({ ...previous, ...patch });
  const characters = { ...cached.characters };
  if (hasCharacterContent(character)) characters[petId] = character;
  else delete characters[petId];
  return commitSettings(normalizeCompanionSettings({ ...cached, characters }));
}

export function removeCompanionCharacterSettings(petId: string): CompanionSettings {
  assertSafeCompanionPetId(petId);
  if (!cached.characters[petId]) return cached;
  const characters = { ...cached.characters };
  delete characters[petId];
  return commitSettings(normalizeCompanionSettings({ ...cached, characters }));
}

export function onCompanionSettingsChanged(listener: (settings: CompanionSettings) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function normalizeCompanionSettings(value: unknown): CompanionSettings {
  const raw = isRecord(value) ? value : {};
  const profile = isRecord(raw.profile) ? raw.profile : {};
  const memory = isRecord(raw.memory) ? raw.memory : {};
  const proactivity = isRecord(raw.proactivity) ? raw.proactivity : {};
  const wake = isRecord(raw.wake) ? raw.wake : {};
  const codex = isRecord(raw.codex) ? raw.codex : {};
  const consentVersion = raw.consentVersion === 1 ? 1 : 0;

  return {
    version: 2,
    consentVersion,
    enabled: consentVersion === 1 && raw.enabled === true,
    target: companionTargetIds.includes(raw.target as CompanionTargetId) ? raw.target as CompanionTargetId : "codex",
    codex: {
      model: normalizeText(codex.model, 120),
      reasoningEffort: normalizeText(codex.reasoningEffort, 40),
    },
    profile: {
      name: normalizeText(profile.name, 120),
      preferredAddress: normalizeText(profile.preferredAddress, 120),
      aboutYou: normalizeAboutYou(profile.aboutYou, profile.goals),
    },
    characters: normalizeCharacterProfiles(raw.characters, raw.pets),
    memory: { enabled: memory.enabled === true },
    proactivity: {
      enabled: proactivity.enabled === true,
      frequency: companionFrequencies.includes(proactivity.frequency as CompanionFrequency)
        ? proactivity.frequency as CompanionFrequency
        : "sometimes",
    },
    // Enabling wake remains an explicit user choice. Runtime availability is
    // checked separately so a missing or invalid bundle cannot arm the microphone.
    wake: { enabled: wake.enabled === true, followUpEnabled: wake.followUpEnabled !== false },
  };
}

export function assertSafeCompanionPetId(petId: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(petId)) throw new Error(`Invalid companion pet id: ${petId}`);
}

export function emptyCompanionCharacterProfile(): CompanionCharacterProfile {
  return { visibleName: "", species: "", origin: "", appearance: "", personality: "", quirks: "", lifeStory: "" };
}

function normalizeCharacterProfiles(value: unknown, legacyPets: unknown): Readonly<Record<string, CompanionCharacterProfile>> {
  const source = isRecord(value) ? value : {};
  const legacy = isRecord(legacyPets) ? legacyPets : {};
  const characters: Record<string, CompanionCharacterProfile> = {};
  const petIds = new Set([...Object.keys(legacy), ...Object.keys(source)]);
  for (const petId of petIds) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(petId)) continue;
    const entry = isRecord(source[petId]) ? source[petId] : {};
    const legacyEntry = isRecord(legacy[petId]) ? legacy[petId] : {};
    const character = normalizeCharacterProfile({
      ...entry,
      personality: normalizeText(entry.personality, companionCharacterFieldLimits.personality)
        || normalizeText(legacyEntry.personality, companionCharacterFieldLimits.personality),
    });
    if (hasCharacterContent(character)) characters[petId] = character;
    if (Object.keys(characters).length >= maxCompanionCharacterProfiles) break;
  }
  return characters;
}

function normalizeCharacterProfile(value: unknown): CompanionCharacterProfile {
  const raw = isRecord(value) ? value : {};
  return {
    visibleName: normalizeText(raw.visibleName, companionCharacterFieldLimits.visibleName),
    species: normalizeText(raw.species, companionCharacterFieldLimits.species),
    origin: normalizeText(raw.origin, companionCharacterFieldLimits.origin),
    appearance: normalizeText(raw.appearance, companionCharacterFieldLimits.appearance),
    personality: normalizeText(raw.personality, companionCharacterFieldLimits.personality),
    quirks: normalizeText(raw.quirks, companionCharacterFieldLimits.quirks),
    lifeStory: normalizeText(raw.lifeStory, companionCharacterFieldLimits.lifeStory),
  };
}

function hasCharacterContent(character: CompanionCharacterProfile): boolean {
  return Object.values(character).some(Boolean);
}

function normalizeAboutYou(value: unknown, legacyGoals: unknown): string {
  const normalized = normalizeText(value, maxCompanionAboutYouCharacters);
  if (normalized) return normalized;
  const goals = normalizeGoals(legacyGoals);
  return goals.length > 0
    ? normalizeText(`Things I was working toward:\n${goals.map((goal) => `- ${goal}`).join("\n")}`, maxCompanionAboutYouCharacters)
    : "";
}

function normalizeGoals(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const goals: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const goal = normalizeText(entry, maxCompanionGoalCharacters);
    const key = goal.toLowerCase();
    if (!goal || seen.has(key)) continue;
    seen.add(key);
    goals.push(goal);
    if (goals.length >= maxCompanionGoals) break;
  }
  return goals;
}

function normalizeText(value: unknown, maxCharacters: number): string {
  return typeof value === "string" ? value.replace(/\0/g, "").trim().slice(0, maxCharacters) : "";
}

function readCompanionSettingsFile(path: string): CompanionSettings {
  try {
    if (!existsSync(path)) return normalizeCompanionSettings(undefined);
    return normalizeCompanionSettings(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return normalizeCompanionSettings(undefined);
  }
}

function commitSettings(next: CompanionSettings): CompanionSettings {
  if (settingsPath) writeCompanionSettingsFile(settingsPath, next);
  cached = next;
  for (const listener of listeners) {
    try { listener(cached); } catch { /* listeners are isolated */ }
  }
  return cached;
}

function writeCompanionSettingsFile(path: string, settings: CompanionSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
