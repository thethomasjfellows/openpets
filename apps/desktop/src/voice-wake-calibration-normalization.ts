import { maxVoiceWakeVariants } from "./voice-wake-helper-protocol.js";

export const maxSavedWakeInterpretations = 15;

export function canonicalWakeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function normalizeWakeTranscript(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").slice(0, 120)
    : "";
}

export function normalizeWakeInterpretations(
  phrase: string,
  values: readonly unknown[],
  limit = maxSavedWakeInterpretations,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const canonicalPhrase = canonicalWakeText(phrase);
  const phraseWords = canonicalPhrase.split(" ").filter(Boolean).length;
  const phraseLength = Math.max(1, canonicalPhrase.length);
  for (const value of values) {
    const normalized = normalizeWakeTranscript(value);
    const canonical = canonicalWakeText(normalized);
    const candidateWords = canonical.split(" ").filter(Boolean).length;
    const lengthRatio = canonical.length / phraseLength;
    if (!normalized || canonical === canonicalPhrase || seen.has(canonical)) continue;
    if (Math.abs(candidateWords - phraseWords) > 1 || lengthRatio < 0.45 || lengthRatio > 2.4) continue;
    seen.add(canonical);
    result.push(normalized);
    if (result.length === limit) break;
  }
  return result;
}

export function mergeWakeInterpretations(
  phrase: string,
  incoming: readonly unknown[],
  existing: readonly unknown[],
): string[] {
  return normalizeWakeInterpretations(phrase, [...incoming, ...existing]);
}

export function selectRuntimeWakeVariants(phrase: string, saved: readonly unknown[]): string[] {
  return normalizeWakeInterpretations(phrase, saved, maxVoiceWakeVariants);
}

export const normalizeWakeCalibrationVariants = normalizeWakeInterpretations;
