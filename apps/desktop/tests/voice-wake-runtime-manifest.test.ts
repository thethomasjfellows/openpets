import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  validateSherpaVoiceWakeBundle,
  type SherpaVoiceWakeBundleFileRole,
} from "../src/voice-wake-sherpa-manifest.js";

type TestManifestFile = {
  role: SherpaVoiceWakeBundleFileRole;
  path: string;
  sha256: string;
  bytes: number;
  sourceId: string;
};

type TestManifest = {
  version: number;
  runtime: string;
  protocolVersion: number;
  bundleId: string;
  bundleVersion: string;
  modelId: string;
  sherpaOnnxVersion: string;
  buildInputSha256: string;
  platforms: Record<string, { helper: string; runtimeLibraries: string[] }>;
  keyword: {
    encoder: string;
    decoder: string;
    joiner: string;
    bpeModel: string;
    tokens: string;
  };
  vad: { model: string };
  sources: Array<{
    id: string;
    version: string;
    url: string;
    sha256: string;
    license: string;
  }>;
  files: TestManifestFile[];
};

const testRoot = mkdtempSync(join(tmpdir(), "openpets-wake-manifest-"));
const testPlatform: "darwin" | "win32" | "linux" = process.platform === "win32" || process.platform === "linux"
  ? process.platform
  : "darwin";
const testArch: "x64" | "arm64" = process.arch === "x64" ? "x64" : "arm64";
const testPlatformId = `${testPlatform}-${testArch}`;
const helperRelativePath = testPlatform === "win32"
  ? "bin/openpets-wake-helper.exe"
  : "bin/openpets-wake-helper";

try {
  const missing = join(testRoot, "missing");
  mkdirSync(missing);
  assertFailure(missing, /manifest is missing/i);

  const malformed = join(testRoot, "malformed");
  mkdirSync(malformed);
  writeFileSync(join(malformed, "openpets-voice-wake.manifest.json"), "{bad");
  assertFailure(malformed, /valid JSON/i);

  const protocol = createBundle("protocol", (manifest) => { manifest.protocolVersion = 3; });
  assertFailure(protocol, /protocol version/i);

  const oldManifest = createBundle("old-manifest", (manifest) => { manifest.version = 1; });
  assertFailure(oldManifest, /manifest version/i);

  const invalidBuildInput = createBundle("invalid-build-input", (manifest) => { manifest.buildInputSha256 = "stale"; });
  assertFailure(invalidBuildInput, /build-input digest/i);

  const unsupported = createBundle("unsupported", (manifest) => { manifest.platforms = {}; });
  assertFailure(unsupported, /no supported platform/i);

  const extraPlatformId = testPlatformId === "linux-x64" ? "darwin-x64" : "linux-x64";
  const multiPlatform = createBundle("multi-platform", (manifest) => {
    manifest.platforms[extraPlatformId] = {
      helper: helperRelativePath,
      runtimeLibraries: ["lib/sherpa-runtime.bin"],
    };
  });
  assertFailure(multiPlatform, /exactly the selected target platform/i);

  const missingNotice = createBundle("missing-notice", (manifest) => {
    manifest.files = manifest.files.filter((file) => file.role !== "notice");
  });
  assertFailure(missingNotice, /required file role/i);

  const missingEncoder = createBundle("missing-encoder", (manifest) => {
    manifest.files = manifest.files.filter((file) => file.role !== "kws-encoder");
  });
  assertFailure(missingEncoder, /required-file count/i);

  const badSource = createBundle("bad-source", (manifest) => {
    manifest.files[0]!.sourceId = "not-declared";
  });
  assertFailure(badSource, /invalid file source/i);

  const modelMismatch = createBundle("model-mismatch", (manifest) => {
    manifest.keyword.encoder = manifest.keyword.decoder;
  });
  assertFailure(modelMismatch, /model map/i);

  const absolute = createBundle("absolute", (manifest) => {
    manifest.files[0]!.path = "/tmp/helper";
    manifest.platforms[testPlatformId] = {
      helper: "/tmp/helper",
      runtimeLibraries: ["lib/sherpa-runtime.bin"],
    };
  });
  assertFailure(absolute, /platform map|file path/i);

  const traversal = createBundle("traversal", (manifest) => {
    manifest.files[0]!.path = "../helper";
    manifest.platforms[testPlatformId] = {
      helper: "../helper",
      runtimeLibraries: ["lib/sherpa-runtime.bin"],
    };
  });
  assertFailure(traversal, /platform map|file path/i);

  const undeclared = createBundle("undeclared");
  writeFileSync(join(undeclared, "unexpected.bin"), "unexpected");
  assertFailure(undeclared, /undeclared file/i);

  const wrongSize = createBundle("wrong-size", (manifest) => { manifest.files[1]!.bytes += 1; });
  assertFailure(wrongSize, /wrong size/i);

  const wrongHash = createBundle("wrong-hash", (manifest) => {
    manifest.files[1]!.sha256 = "0".repeat(64);
  });
  assertFailure(wrongHash, /checksum/i);

  const oversizedFile = createBundle("oversized-file", (manifest) => {
    manifest.files[1]!.bytes = 512 * 1024 * 1024 + 1;
  });
  assertFailure(oversizedFile, /file size/i);

  const oversizedBundle = createBundle("oversized-bundle", (manifest) => {
    for (const file of manifest.files) file.bytes = 100 * 1024 * 1024;
  });
  assertFailure(oversizedBundle, /total size/i);

  if (testPlatform !== "win32") {
    const nonExecutable = createBundle("non-executable");
    chmodSync(join(nonExecutable, ...helperRelativePath.split("/")), 0o644);
    assertFailure(nonExecutable, /not executable/i);
  }

  if (process.platform !== "win32") {
    const symlink = createBundle("symlink");
    const outside = join(testRoot, "outside.tokens");
    writeFileSync(outside, "outside");
    const tokenPath = join(symlink, "models", "kws", "tokens.txt");
    unlinkSync(tokenPath);
    symlinkSync(outside, tokenPath);
    assertFailure(symlink, /symbolic link|regular file/i);
  }

  const validRoot = createBundle("valid");
  const valid = validateSherpaVoiceWakeBundle({
    rootDir: validRoot,
    platform: testPlatform,
    arch: testArch,
  });
  assert.ok(valid.ok);
  assert.equal(valid.bundle.platformId, testPlatformId);
  assert.equal(valid.bundle.bundleVersion, "1.2.3");
  assert.equal(valid.bundle.modelId, "openpets-default-en");
  assert.equal(valid.bundle.sherpaOnnxVersion, "1.13.4");
  assert.equal(valid.bundle.buildInputSha256, "d".repeat(64));
  assert.equal(valid.bundle.runtimeLibraryPaths.length, 1);
  assert.ok(valid.bundle.helperPath.endsWith(
    helperRelativePath.replaceAll("/", process.platform === "win32" ? "\\" : "/"),
  ));
  assert.ok(valid.bundle.keywordEncoderPath.endsWith(join("models", "kws", "encoder.onnx")));
  assert.ok(valid.bundle.keywordBpeModelPath.endsWith(join("models", "kws", "bpe.model")));
  assert.ok(valid.bundle.keywordTokensPath.endsWith(join("models", "kws", "tokens.txt")));
  assert.equal(valid.bundle.files.length, 11);

  console.log("Sherpa wake bundle manifest validation verified");
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}

function createBundle(name: string, mutate?: (manifest: TestManifest) => void): string {
  const root = join(testRoot, name);
  const contents: Array<{
    role: SherpaVoiceWakeBundleFileRole;
    path: string;
    content: string;
  }> = [
    { role: "helper", path: helperRelativePath, content: "test-helper" },
    { role: "runtime-library", path: "lib/sherpa-runtime.bin", content: "runtime-library" },
    { role: "kws-encoder", path: "models/kws/encoder.onnx", content: "encoder" },
    { role: "kws-decoder", path: "models/kws/decoder.onnx", content: "decoder" },
    { role: "kws-joiner", path: "models/kws/joiner.onnx", content: "joiner" },
    { role: "kws-bpe-model", path: "models/kws/bpe.model", content: "bpe-model" },
    { role: "kws-tokens", path: "models/kws/tokens.txt", content: "token-a\ntoken-b\n" },
    { role: "vad-model", path: "models/vad/silero_vad.onnx", content: "vad-model" },
    { role: "license", path: "licenses/LICENSE.txt", content: "test license" },
    { role: "notice", path: "THIRD_PARTY_NOTICES.md", content: "test notice" },
    { role: "provenance", path: "provenance.json", content: "{}\n" },
  ];
  for (const file of contents) {
    const path = join(root, ...file.path.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, file.content);
  }
  if (testPlatform !== "win32") {
    chmodSync(join(root, ...helperRelativePath.split("/")), 0o755);
  }

  const manifest: TestManifest = {
    version: 2,
    runtime: "sherpa-onnx",
      protocolVersion: 2,
    bundleId: "openpets-sherpa-test",
    bundleVersion: "1.2.3",
    modelId: "openpets-default-en",
    sherpaOnnxVersion: "1.13.4",
    buildInputSha256: "d".repeat(64),
    platforms: {
      [testPlatformId]: {
        helper: helperRelativePath,
        runtimeLibraries: ["lib/sherpa-runtime.bin"],
      },
    },
    keyword: {
      encoder: "models/kws/encoder.onnx",
      decoder: "models/kws/decoder.onnx",
      joiner: "models/kws/joiner.onnx",
      bpeModel: "models/kws/bpe.model",
      tokens: "models/kws/tokens.txt",
    },
    vad: { model: "models/vad/silero_vad.onnx" },
    sources: [{
      id: "fixture",
      version: "1.0.0",
      url: "https://example.com/fixture.tar.gz",
      sha256: "a".repeat(64),
      license: "MIT",
    }],
    files: contents.map((file) => ({
      role: file.role,
      path: file.path,
      sha256: createHash("sha256").update(file.content).digest("hex"),
      bytes: Buffer.byteLength(file.content),
      sourceId: "fixture",
    })),
  };
  mutate?.(manifest);
  writeFileSync(
    join(root, "openpets-voice-wake.manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return root;
}

function assertFailure(rootDir: string, pattern: RegExp): void {
  const result = validateSherpaVoiceWakeBundle({
    rootDir,
    platform: testPlatform,
    arch: testArch,
  });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("Expected bundle validation to fail.");
  assert.match(result.reason, pattern);
  assert.equal(
    result.reason.includes(testRoot),
    false,
    "validation reasons never expose absolute paths",
  );
}
