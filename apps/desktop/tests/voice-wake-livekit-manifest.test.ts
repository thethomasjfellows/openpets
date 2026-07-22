import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { liveKitWakeManifestFileName, validateLiveKitWakeBundle } from "../src/voice-wake-livekit-manifest.js";

const root = mkdtempSync(join(tmpdir(), "openpets-livekit-wake-"));
const files = [
  ["bin/openpets-livekit-wake-helper", "helper"],
  ["models/hey_pedra.onnx", "classifier"],
  ["THIRD_PARTY_NOTICES.md", "notice"],
  ["classifier-provenance.json", "provenance"],
] as const;

for (const [path, contents] of files) {
  const absolute = join(root, ...path.split("/"));
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, contents);
}

const manifest = {
  version: 1,
  runtime: "livekit-wakeword",
  protocolVersion: 2,
  bundleVersion: "1.0.0",
  phraseId: "openpets.hey-pedra.v1",
  phrase: "Hey Pedra",
  target: `${process.platform}-${process.arch}`,
  helper: files[0][0],
  classifier: files[1][0],
  thresholds: { strict: 0.8, balanced: 0.68, easy: 0.55 },
  files: files.map(([path, contents]) => ({
    path,
    bytes: Buffer.byteLength(contents),
    sha256: createHash("sha256").update(contents).digest("hex"),
  })),
};

writeFileSync(join(root, liveKitWakeManifestFileName), JSON.stringify(manifest));
assert.equal(validateLiveKitWakeBundle({ rootDir: root }).ok, true, "a fully attested official classifier bundle is accepted");

writeFileSync(join(root, files[1][0]), "tampered");
const tampered = validateLiveKitWakeBundle({ rootDir: root });
assert.equal(tampered.ok, false, "a changed classifier is rejected");
if (!tampered.ok) assert.match(tampered.reason, /size|integrity/i);

console.log("LiveKit wake bundle integrity verified");
