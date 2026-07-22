export type VoiceWakeSmokeExpected = {
  readonly target: string;
  readonly targetPlatform: "darwin" | "win32" | "linux";
  readonly targetArch: "x64" | "arm64";
  readonly manifestSha256: string;
  readonly helperSha256: string;
  readonly buildInputSha256: string;
};

export type VoiceWakeSmokeAttestationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export function validateVoiceWakeSmokeAttestation(
  value: unknown,
  expected: VoiceWakeSmokeExpected,
): VoiceWakeSmokeAttestationResult {
  if (!isRecord(value)) return failure();
  const testedArchMatches = expected.targetPlatform === "darwin"
    ? value.testedArch === "x64" || value.testedArch === "arm64"
    : value.testedArch === expected.targetArch;
  if (
    value.version !== 1 ||
    value.target !== expected.target ||
    value.testedPlatform !== expected.targetPlatform ||
    !testedArchMatches ||
    value.manifestSha256 !== expected.manifestSha256 ||
    value.helperSha256 !== expected.helperSha256 ||
    value.buildInputSha256 !== expected.buildInputSha256
  ) {
    return failure();
  }
  return { ok: true };
}

function failure(): VoiceWakeSmokeAttestationResult {
  return {
    ok: false,
    reason: "Native smoke evidence is stale, invalid, or belongs to another target.",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
