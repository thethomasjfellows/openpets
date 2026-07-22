import { companionCharacterFieldLimits, type CompanionCharacterProfile } from "./companion-settings.js";

export type CompanionCharacterGenerationMode = "complete" | "reimagine";

export type CompanionCharacterGenerationInput = {
  readonly mode: CompanionCharacterGenerationMode;
  readonly pet: { readonly id: string; readonly displayName: string; readonly description?: string };
  readonly draft: CompanionCharacterProfile;
  readonly sourceText?: string;
};

const characterFields = ["visibleName", "species", "origin", "appearance", "personality", "quirks", "lifeStory"] as const;

export function buildCompanionCharacterGenerationPrompt(input: CompanionCharacterGenerationInput): string {
  const sourceText = normalizeText(input.sourceText, 8_000);
  const instructions = input.mode === "complete"
    ? "Fill every blank field. Preserve every non-blank draft field exactly as written."
    : "Create a fresh, surprising, internally coherent identity. Replace every field, including visibleName.";
  return [
    "OpenPets character profile draft request",
    "Return one JSON object only. Do not use markdown or code fences.",
    `Required string keys: ${characterFields.join(", ")}.`,
    instructions,
    "Keep the character suitable for warm everyday companion conversation. Avoid references to AI, prompts, tools, providers, or software implementation.",
    `Original pet asset ID: ${JSON.stringify(input.pet.id)}`,
    `Original pet name: ${JSON.stringify(input.pet.displayName)}`,
    `Original package/catalog description (inspiration only): ${input.pet.description ? JSON.stringify(input.pet.description) : "not provided"}`,
    `Current editable draft: ${JSON.stringify(input.draft)}`,
    `Optional imported source notes: ${sourceText ? JSON.stringify(sourceText) : "not provided"}`,
  ].join("\n");
}

export function parseCompanionCharacterDraft(
  response: string,
  input: Pick<CompanionCharacterGenerationInput, "mode" | "draft">,
): CompanionCharacterProfile {
  const parsed = parseFirstJsonObject(response);
  const generated = normalizeCharacterRecord(parsed);
  if (input.mode === "reimagine" && characterFields.some((field) => !generated[field])) {
    throw new Error("The AI Brain returned an incomplete character profile. Try again.");
  }
  const completed = input.mode === "complete"
    ? Object.fromEntries(characterFields.map((field) => [field, input.draft[field].trim() || generated[field]])) as unknown as CompanionCharacterProfile
    : generated;
  if (!completed.visibleName) throw new Error("The AI Brain did not provide a character name. Try again.");
  return completed;
}

function normalizeCharacterRecord(value: unknown): CompanionCharacterProfile {
  if (!isRecord(value)) throw new Error("The AI Brain did not return a character profile object. Try again.");
  for (const field of characterFields) {
    if (typeof value[field] !== "string") throw new Error(`The AI Brain returned an invalid ${field} field. Try again.`);
  }
  return {
    visibleName: normalizeInline(value.visibleName, companionCharacterFieldLimits.visibleName),
    species: normalizeInline(value.species, companionCharacterFieldLimits.species),
    origin: normalizeText(value.origin, companionCharacterFieldLimits.origin),
    appearance: normalizeText(value.appearance, companionCharacterFieldLimits.appearance),
    personality: normalizeText(value.personality, companionCharacterFieldLimits.personality),
    quirks: normalizeText(value.quirks, companionCharacterFieldLimits.quirks),
    lifeStory: normalizeText(value.lifeStory, companionCharacterFieldLimits.lifeStory),
  };
}

function parseFirstJsonObject(value: string): unknown {
  const text = normalizeText(value, 32_000).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = text.indexOf("{");
  if (start < 0) throw new Error("The AI Brain did not return JSON. Try again.");
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) {
      try { return JSON.parse(text.slice(start, index + 1)); }
      catch { throw new Error("The AI Brain returned invalid character JSON. Try again."); }
    }
  }
  throw new Error("The AI Brain returned incomplete character JSON. Try again.");
}

function normalizeInline(value: unknown, maxCharacters: number): string {
  return normalizeText(value, maxCharacters).replace(/\s+/g, " ");
}

function normalizeText(value: unknown, maxCharacters: number): string {
  return typeof value === "string" ? value.replace(/\0/g, "").trim().slice(0, maxCharacters) : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
