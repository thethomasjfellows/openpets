import assert from "node:assert/strict";

import { validateVoiceWakeSmokeAttestation } from "../src/voice-wake-smoke-attestation.js";

const manifestSha256 = "a".repeat(64);
const helperSha256 = "b".repeat(64);
const buildInputSha256 = "d".repeat(64);
const expected = {
  target: "linux-x64",
  targetPlatform: "linux" as const,
  targetArch: "x64" as const,
  manifestSha256,
  helperSha256,
  buildInputSha256,
};
const valid = {
  version: 1,
  target: "linux-x64",
  manifestSha256,
  helperSha256,
  buildInputSha256,
  testedPlatform: "linux",
  testedArch: "x64",
};

assert.deepEqual(validateVoiceWakeSmokeAttestation(valid, expected), { ok: true });
assert.equal(
  validateVoiceWakeSmokeAttestation({ ...valid, helperSha256: "c".repeat(64) }, expected).ok,
  false,
  "changing the staged helper must invalidate its native smoke evidence",
);
assert.equal(
  validateVoiceWakeSmokeAttestation({ ...valid, buildInputSha256: "e".repeat(64) }, expected).ok,
  false,
  "changing the helper build inputs must invalidate native smoke evidence",
);
assert.equal(
  validateVoiceWakeSmokeAttestation({ ...valid, target: "win32-x64", testedPlatform: "win32" }, expected).ok,
  false,
  "smoke evidence from another target must not authorize staging",
);
assert.deepEqual(
  validateVoiceWakeSmokeAttestation(
    { ...valid, target: "darwin-x64", testedPlatform: "darwin", testedArch: "arm64" },
    { ...expected, target: "darwin-x64", targetPlatform: "darwin" },
  ),
  { ok: true },
  "a real x64 helper smoke under Rosetta is valid native evidence for the macOS x64 target",
);

console.log("voice wake smoke attestation tests passed");
