import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const wakeRoot = resolve(scriptsDir, "..");
const desktopRoot = resolve(wakeRoot, "..");

const buildInputs = [
  "wake-helper/THIRD_PARTY_NOTICES.md",
  "wake-helper/manifest.md",
  "wake-helper/native/CMakeLists.txt",
  "wake-helper/native/src/main.cc",
  "wake-helper/openpets-voice-wake.lock.json",
  "wake-helper/protocol.md",
  "wake-helper/scripts/build-input-digest.mjs",
  "wake-helper/scripts/prepare-bundle.mjs",
  "wake-helper/scripts/smoke-test.mjs",
  "wake-helper/scripts/stage-package-resource.mjs",
  "src/voice-wake-helper-protocol.ts",
  "src/voice-wake-sherpa-manifest.ts",
  "src/voice-wake-smoke-attestation.ts",
].sort();

export async function computeWakeBuildInputDigest() {
  const hash = createHash("sha256");
  for (const label of buildInputs) {
    const path = join(desktopRoot, ...label.split("/"));
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) {
      throw new Error(`Wake build input is missing or unsafe: ${label}`);
    }
    const bytes = await readFile(path);
    hash.update(label, "utf8");
    hash.update("\0");
    hash.update(String(bytes.length), "ascii");
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}
