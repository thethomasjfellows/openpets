export type VoiceCaptionSegment = {
  readonly endIndex: number;
  readonly weight: number;
};

export type VoiceCaption = {
  readonly text: string;
  readonly segments: readonly VoiceCaptionSegment[];
  readonly totalWeight: number;
};

/** Build provider-neutral word timing hints for progressive speech captions. */
export function buildVoiceCaption(text: string): VoiceCaption {
  const normalized = text.trim().slice(0, 4_000);
  const segments: VoiceCaptionSegment[] = [];
  for (const match of normalized.matchAll(/\S+(?:\s+|$)/gu)) {
    const token = match[0];
    const word = token.trimEnd();
    const weight = /[.!?]["')\]]?$/u.test(word)
      ? 1.75
      : /[,;:]["')\]]?$/u.test(word)
        ? 1.35
        : 1;
    segments.push({ endIndex: (match.index ?? 0) + token.length, weight });
  }
  return {
    text: normalized,
    segments,
    totalWeight: segments.reduce((sum, segment) => sum + segment.weight, 0),
  };
}
