import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, posix, relative, sep } from "node:path";

import { voiceWakeProtocolVersion } from "./voice-wake-helper-protocol.js";

export const sherpaVoiceWakeManifestFileName = "openpets-voice-wake.manifest.json";
export const sherpaVoiceWakeManifestVersion = 2;
export const supportedSherpaVoiceWakeVersion = "1.13.4";
export const maxSherpaVoiceWakeManifestBytes = 96 * 1024;

export type SherpaVoiceWakePlatformId =
  | "darwin-x64"
  | "darwin-arm64"
  | "win32-x64"
  | "win32-arm64"
  | "linux-x64"
  | "linux-arm64";

export type SherpaVoiceWakeBundleFileRole =
  | "helper"
  | "runtime-library"
  | "kws-encoder"
  | "kws-decoder"
  | "kws-joiner"
  | "kws-bpe-model"
  | "kws-tokens"
  | "vad-model"
  | "license"
  | "notice"
  | "provenance";

export type ValidatedSherpaVoiceWakeBundleFile = {
  readonly role: SherpaVoiceWakeBundleFileRole;
  readonly path: string;
  readonly absolutePath: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly sourceId: string;
};

export type ValidatedSherpaVoiceWakeBundle = {
  readonly rootDir: string;
  readonly manifestPath: string;
  readonly platformId: SherpaVoiceWakePlatformId;
  readonly helperPath: string;
  readonly runtimeLibraryPaths: readonly string[];
  readonly keywordEncoderPath: string;
  readonly keywordDecoderPath: string;
  readonly keywordJoinerPath: string;
  readonly keywordBpeModelPath: string;
  readonly keywordTokensPath: string;
  readonly vadModelPath: string;
  readonly bundleId: string;
  readonly bundleVersion: string;
  readonly modelId: string;
  readonly sherpaOnnxVersion: string;
  readonly buildInputSha256: string;
  readonly files: readonly ValidatedSherpaVoiceWakeBundleFile[];
};

export type SherpaVoiceWakeBundleValidation =
  | { readonly ok: true; readonly bundle: ValidatedSherpaVoiceWakeBundle }
  | { readonly ok: false; readonly reason: string };

type ManifestFile = {
  readonly role: SherpaVoiceWakeBundleFileRole;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly sourceId: string;
};

type ManifestSource = {
  readonly id: string;
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  readonly license: string;
};

type PlatformEntry = {
  readonly helper: string;
  readonly runtimeLibraries: readonly string[];
};

type ParsedManifest = {
  readonly bundleId: string;
  readonly bundleVersion: string;
  readonly modelId: string;
  readonly sherpaOnnxVersion: string;
  readonly buildInputSha256: string;
  readonly platforms: Record<string, PlatformEntry>;
  readonly keyword: {
    readonly encoder: string;
    readonly decoder: string;
    readonly joiner: string;
    readonly bpeModel: string;
    readonly tokens: string;
  };
  readonly vad: { readonly model: string };
  readonly sources: readonly ManifestSource[];
  readonly files: readonly ManifestFile[];
};

const fileRoles = new Set<SherpaVoiceWakeBundleFileRole>([
  "helper",
  "runtime-library",
  "kws-encoder",
  "kws-decoder",
  "kws-joiner",
  "kws-bpe-model",
  "kws-tokens",
  "vad-model",
  "license",
  "notice",
  "provenance",
]);
const exactRoleCounts = new Set<SherpaVoiceWakeBundleFileRole>([
  "kws-encoder",
  "kws-decoder",
  "kws-joiner",
  "kws-bpe-model",
  "kws-tokens",
  "vad-model",
  "provenance",
]);
const maxBundleFiles = 96;
const maxDeclaredFileBytes = 512 * 1024 * 1024;
const maxDeclaredBundleBytes = 1024 * 1024 * 1024;
const maxLegalFileBytes = 1024 * 1024;

export function validateSherpaVoiceWakeBundle(input: {
  readonly rootDir: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
}): SherpaVoiceWakeBundleValidation {
  const platformId = getSherpaVoiceWakePlatformId(
    input.platform ?? process.platform,
    input.arch ?? process.arch,
  );
  if (!platformId) {
    return failure("This operating system and CPU architecture are not supported by the wake bundle.");
  }

  let rootDir: string;
  try {
    rootDir = realpathSync(input.rootDir);
    if (!lstatSync(rootDir).isDirectory()) {
      return failure("The wake bundle root is not a directory.");
    }
  } catch {
    return failure("The wake bundle root is missing or unreadable.");
  }

  const manifestPath = join(rootDir, sherpaVoiceWakeManifestFileName);
  let manifestText: string;
  try {
    const stat = lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return failure("The wake bundle manifest must be a regular file.");
    }
    if (stat.size < 2 || stat.size > maxSherpaVoiceWakeManifestBytes) {
      return failure("The wake bundle manifest size is invalid.");
    }
    manifestText = readFileSync(manifestPath, "utf8");
  } catch {
    return failure("The wake bundle manifest is missing or unreadable.");
  }

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(manifestText);
  } catch {
    return failure("The wake bundle manifest is not valid JSON.");
  }
  const parsed = parseManifest(rawManifest);
  if (!parsed.ok) return parsed;

  const declaredPaths = new Set([
    sherpaVoiceWakeManifestFileName,
    ...parsed.manifest.files.map((file) => file.path),
  ]);
  const treeIssue = auditBundleTree(rootDir, declaredPaths);
  if (treeIssue) return failure(treeIssue);

  const declaredPlatformIds = Object.keys(parsed.manifest.platforms);
  const platformEntry = parsed.manifest.platforms[platformId];
  if (declaredPlatformIds.length !== 1 || declaredPlatformIds[0] !== platformId || !platformEntry) {
    return failure("The wake bundle must contain exactly the selected target platform.");
  }

  const seenPaths = new Set<string>();
  const files: ValidatedSherpaVoiceWakeBundleFile[] = [];
  for (const file of parsed.manifest.files) {
    if (seenPaths.has(file.path)) {
      return failure("The wake bundle declares the same file more than once.");
    }
    seenPaths.add(file.path);

    const absolutePath = join(rootDir, ...file.path.split("/"));
    let stat;
    let realPath: string;
    try {
      stat = lstatSync(absolutePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return failure("A declared wake bundle file is not a regular file.");
      }
      realPath = realpathSync(absolutePath);
    } catch {
      return failure("A declared wake bundle file is missing or unreadable.");
    }
    if (!isInside(rootDir, realPath)) {
      return failure("A declared wake bundle file escapes the bundle root.");
    }
    if (stat.size !== file.bytes) {
      return failure("A declared wake bundle file has the wrong size.");
    }
    if (hashFile(realPath) !== file.sha256.toLowerCase()) {
      return failure("A declared wake bundle file failed checksum validation.");
    }
    if (
      (file.role === "license" || file.role === "notice") &&
      stat.size > maxLegalFileBytes
    ) {
      return failure("A wake bundle license or notice file is too large.");
    }
    files.push({
      ...file,
      absolutePath: realPath,
      sha256: file.sha256.toLowerCase(),
    });
  }

  const helperFiles = files.filter((file) => file.role === "helper");
  const runtimeLibraryFiles = files.filter((file) => file.role === "runtime-library");
  const referencedRuntimeLibraries = new Set(platformEntry.runtimeLibraries);
  if (helperFiles.length !== 1 || helperFiles[0]?.path !== platformEntry.helper) {
    return failure("The wake bundle must declare exactly the selected target helper.");
  }
  if (
    runtimeLibraryFiles.length !== referencedRuntimeLibraries.size ||
    runtimeLibraryFiles.some((file) => !referencedRuntimeLibraries.has(file.path))
  ) {
    return failure("The wake bundle contains runtime libraries outside the selected target.");
  }

  const rolePath = (
    role: SherpaVoiceWakeBundleFileRole,
    path: string,
  ): ValidatedSherpaVoiceWakeBundleFile | null => {
    const found = files.find((file) => file.role === role && file.path === path);
    return found ?? null;
  };

  const helper = rolePath("helper", platformEntry.helper);
  if (!helper) {
    return failure("The current platform helper is not declared as a helper file.");
  }
  try {
    const helperStat = lstatSync(helper.absolutePath);
    if (platformId.startsWith("win32-")) {
      if (!helper.path.toLowerCase().endsWith(".exe")) {
        return failure("The Windows wake helper must use an .exe filename.");
      }
    } else if ((helperStat.mode & 0o111) === 0) {
      return failure("The wake helper is not executable.");
    }
  } catch {
    return failure("The current platform helper is unreadable.");
  }

  if (platformEntry.runtimeLibraries.length < 1) {
    return failure("The current platform has no runtime libraries.");
  }
  const runtimeLibraries: ValidatedSherpaVoiceWakeBundleFile[] = [];
  for (const path of platformEntry.runtimeLibraries) {
    const library = rolePath("runtime-library", path);
    if (!library) {
      return failure("A current-platform runtime library is not declared correctly.");
    }
    runtimeLibraries.push(library);
  }

  const encoder = rolePath("kws-encoder", parsed.manifest.keyword.encoder);
  const decoder = rolePath("kws-decoder", parsed.manifest.keyword.decoder);
  const joiner = rolePath("kws-joiner", parsed.manifest.keyword.joiner);
  const bpeModel = rolePath("kws-bpe-model", parsed.manifest.keyword.bpeModel);
  const tokens = rolePath("kws-tokens", parsed.manifest.keyword.tokens);
  const vad = rolePath("vad-model", parsed.manifest.vad.model);
  if (!encoder || !decoder || !joiner || !bpeModel || !tokens || !vad) {
    return failure("The wake bundle model map does not match its declared files.");
  }

  return {
    ok: true,
    bundle: {
      rootDir,
      manifestPath,
      platformId,
      helperPath: helper.absolutePath,
      runtimeLibraryPaths: runtimeLibraries.map((file) => file.absolutePath),
      keywordEncoderPath: encoder.absolutePath,
      keywordDecoderPath: decoder.absolutePath,
      keywordJoinerPath: joiner.absolutePath,
      keywordBpeModelPath: bpeModel.absolutePath,
      keywordTokensPath: tokens.absolutePath,
      vadModelPath: vad.absolutePath,
      bundleId: parsed.manifest.bundleId,
      bundleVersion: parsed.manifest.bundleVersion,
      modelId: parsed.manifest.modelId,
      sherpaOnnxVersion: parsed.manifest.sherpaOnnxVersion,
      buildInputSha256: parsed.manifest.buildInputSha256,
      files,
    },
  };
}

export function getSherpaVoiceWakePlatformId(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): SherpaVoiceWakePlatformId | null {
  if (platform !== "darwin" && platform !== "win32" && platform !== "linux") {
    return null;
  }
  if (arch !== "x64" && arch !== "arm64") return null;
  return `${platform}-${arch}`;
}

function parseManifest(
  value: unknown,
):
  | { readonly ok: true; readonly manifest: ParsedManifest }
  | { readonly ok: false; readonly reason: string } {
  if (!isRecord(value)) {
    return failure("The wake bundle manifest must be an object.");
  }
  if (value.version !== sherpaVoiceWakeManifestVersion) {
    return failure("The wake bundle manifest version is unsupported.");
  }
  if (value.runtime !== "sherpa-onnx") {
    return failure("The wake bundle runtime is unsupported.");
  }
  if (value.sherpaOnnxVersion !== supportedSherpaVoiceWakeVersion) {
    return failure("The Sherpa runtime version is unsupported.");
  }
  if (value.protocolVersion !== voiceWakeProtocolVersion) {
    return failure("The wake helper protocol version is unsupported.");
  }
  if (
    !isIdentifier(value.bundleId) ||
    !isIdentifier(value.bundleVersion) ||
    !isIdentifier(value.modelId)
  ) {
    return failure("The wake bundle identity fields are invalid.");
  }
  if (typeof value.buildInputSha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(value.buildInputSha256)) {
    return failure("The wake bundle build-input digest is invalid.");
  }

  if (!isRecord(value.platforms)) {
    return failure("The wake bundle platform map is invalid.");
  }
  const platforms: Record<string, PlatformEntry> = {};
  for (const [platformId, entry] of Object.entries(value.platforms)) {
    if (!isPlatformId(platformId) || !isRecord(entry) || !isSafeBundlePath(entry.helper)) {
      return failure("The wake bundle platform map contains an invalid entry.");
    }
    if (
      !Array.isArray(entry.runtimeLibraries) ||
      entry.runtimeLibraries.length < 1 ||
      entry.runtimeLibraries.length > 16 ||
      !entry.runtimeLibraries.every(isSafeBundlePath) ||
      new Set(entry.runtimeLibraries).size !== entry.runtimeLibraries.length
    ) {
      return failure("The wake bundle platform runtime-library map is invalid.");
    }
    platforms[platformId] = {
      helper: entry.helper,
      runtimeLibraries: [...entry.runtimeLibraries],
    };
  }
  if (Object.keys(platforms).length < 1) {
    return failure("The wake bundle contains no supported platform.");
  }

  if (
    !isRecord(value.keyword) ||
    !isSafeBundlePath(value.keyword.encoder) ||
    !isSafeBundlePath(value.keyword.decoder) ||
    !isSafeBundlePath(value.keyword.joiner) ||
    !isSafeBundlePath(value.keyword.bpeModel) ||
    !isSafeBundlePath(value.keyword.tokens)
  ) {
    return failure("The wake bundle keyword model map is invalid.");
  }
  if (!isRecord(value.vad) || !isSafeBundlePath(value.vad.model)) {
    return failure("The wake bundle VAD model map is invalid.");
  }

  if (
    !Array.isArray(value.sources) ||
    value.sources.length < 1 ||
    value.sources.length > 32
  ) {
    return failure("The wake bundle source list is invalid.");
  }
  const sourceIds = new Set<string>();
  const sources: ManifestSource[] = [];
  for (const source of value.sources) {
    if (
      !isRecord(source) ||
      !isIdentifier(source.id) ||
      !isIdentifier(source.version) ||
      !isHttpsUrl(source.url) ||
      typeof source.sha256 !== "string" ||
      !/^[a-fA-F0-9]{64}$/.test(source.sha256) ||
      !isIdentifier(source.license) ||
      sourceIds.has(source.id)
    ) {
      return failure("The wake bundle contains invalid source provenance.");
    }
    sourceIds.add(source.id);
    sources.push({
      id: source.id,
      version: source.version,
      url: source.url,
      sha256: source.sha256.toLowerCase(),
      license: source.license,
    });
  }

  if (
    !Array.isArray(value.files) ||
    value.files.length < 1 ||
    value.files.length > maxBundleFiles
  ) {
    return failure("The wake bundle file list is invalid.");
  }
  const files: ManifestFile[] = [];
  let declaredBundleBytes = 0;
  const roleCounts = new Map<SherpaVoiceWakeBundleFileRole, number>();
  for (const entry of value.files) {
    if (
      !isRecord(entry) ||
      !fileRoles.has(entry.role as SherpaVoiceWakeBundleFileRole)
    ) {
      return failure("The wake bundle contains an invalid file role.");
    }
    if (!isSafeBundlePath(entry.path)) {
      return failure("The wake bundle contains an invalid file path.");
    }
    if (
      typeof entry.sha256 !== "string" ||
      !/^[a-fA-F0-9]{64}$/.test(entry.sha256)
    ) {
      return failure("The wake bundle contains an invalid checksum.");
    }
    if (
      !Number.isSafeInteger(entry.bytes) ||
      (entry.bytes as number) < 1 ||
      (entry.bytes as number) > maxDeclaredFileBytes
    ) {
      return failure("The wake bundle contains an invalid file size.");
    }
    if (!isIdentifier(entry.sourceId) || !sourceIds.has(entry.sourceId)) {
      return failure("The wake bundle contains an invalid file source.");
    }
    declaredBundleBytes += entry.bytes as number;
    if (declaredBundleBytes > maxDeclaredBundleBytes) {
      return failure("The wake bundle declared total size is too large.");
    }
    const role = entry.role as SherpaVoiceWakeBundleFileRole;
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
    files.push({
      role,
      path: entry.path,
      sha256: entry.sha256,
      bytes: entry.bytes as number,
      sourceId: entry.sourceId,
    });
  }

  for (const role of exactRoleCounts) {
    if (roleCounts.get(role) !== 1) {
      return failure("The wake bundle has an invalid required-file count.");
    }
  }
  if (
    (roleCounts.get("helper") ?? 0) < 1 ||
    (roleCounts.get("runtime-library") ?? 0) < 1 ||
    (roleCounts.get("license") ?? 0) < 1 ||
    (roleCounts.get("notice") ?? 0) < 1
  ) {
    return failure("The wake bundle is missing a required file role.");
  }

  return {
    ok: true,
    manifest: {
      bundleId: value.bundleId,
      bundleVersion: value.bundleVersion,
      modelId: value.modelId,
      sherpaOnnxVersion: value.sherpaOnnxVersion,
      buildInputSha256: value.buildInputSha256.toLowerCase(),
      platforms,
      keyword: {
        encoder: value.keyword.encoder,
        decoder: value.keyword.decoder,
        joiner: value.keyword.joiner,
        bpeModel: value.keyword.bpeModel,
        tokens: value.keyword.tokens,
      },
      vad: { model: value.vad.model },
      sources,
      files,
    },
  };
}

function isSafeBundlePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 240) {
    return false;
  }
  if (value.includes("\\") || /[\0-\x1f\x7f]/.test(value)) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value) || isAbsolute(value)) {
    return false;
  }
  if (posix.normalize(value) !== value) return false;
  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value)
  );
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function isPlatformId(value: string): value is SherpaVoiceWakePlatformId {
  return /^(darwin|win32|linux)-(x64|arm64)$/.test(value);
}

function auditBundleTree(rootDir: string, declaredPaths: ReadonlySet<string>): string | null {
  const pending = [rootDir];
  let entries = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) break;
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      return "The wake bundle contains an unreadable directory.";
    }
    for (const name of names) {
      entries += 1;
      if (entries > 256) return "The wake bundle contains too many filesystem entries.";
      const absolutePath = join(directory, name);
      let stat;
      try {
        stat = lstatSync(absolutePath);
      } catch {
        return "The wake bundle contains an unreadable filesystem entry.";
      }
      if (stat.isSymbolicLink()) {
        return "The wake bundle contains a symbolic link.";
      }
      if (stat.isDirectory()) {
        pending.push(absolutePath);
        continue;
      }
      if (!stat.isFile()) {
        return "The wake bundle contains an unsupported filesystem entry.";
      }
      const bundlePath = relative(rootDir, absolutePath).split(sep).join("/");
      if (!declaredPaths.has(bundlePath)) {
        return "The wake bundle contains an undeclared file.";
      }
    }
  }
  return null;
}

function isInside(rootDir: string, filePath: string): boolean {
  const child = relative(rootDir, filePath);
  return (
    child.length > 0 &&
    child !== ".." &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
}

function hashFile(path: string): string {
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function failure(reason: string): { readonly ok: false; readonly reason: string } {
  return { ok: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
