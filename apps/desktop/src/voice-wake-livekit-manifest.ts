import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, posix, resolve, sep } from "node:path";

import { officialVoiceWakePhrase, officialVoiceWakePhraseId } from "./voice-wake-types.js";

export const liveKitWakeManifestFileName = "openpets-livekit-wake.manifest.json";

export type ValidatedLiveKitWakeBundle = {
  readonly rootDir: string;
  readonly helperPath: string;
  readonly classifierPath: string;
  readonly bundleVersion: string;
  readonly phraseId: typeof officialVoiceWakePhraseId;
  readonly phrase: typeof officialVoiceWakePhrase;
  readonly thresholds: { readonly strict: number; readonly balanced: number; readonly easy: number };
};

export type LiveKitWakeBundleValidation =
  | { readonly ok: true; readonly bundle: ValidatedLiveKitWakeBundle }
  | { readonly ok: false; readonly reason: string };

type ManifestFile = { readonly path: string; readonly bytes: number; readonly sha256: string };
type Manifest = {
  readonly version: 1;
  readonly runtime: "livekit-wakeword";
  readonly protocolVersion: 2;
  readonly bundleVersion: string;
  readonly phraseId: string;
  readonly phrase: string;
  readonly target: string;
  readonly helper: string;
  readonly classifier: string;
  readonly thresholds: { readonly strict: number; readonly balanced: number; readonly easy: number };
  readonly files: readonly ManifestFile[];
};

export function validateLiveKitWakeBundle(input: {
  readonly rootDir: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
}): LiveKitWakeBundleValidation {
  try {
    const rootDir = resolve(input.rootDir);
    const manifest = JSON.parse(readFileSync(join(rootDir, liveKitWakeManifestFileName), "utf8")) as unknown;
    if (!isManifest(manifest)) return failure("the LiveKit wake manifest is invalid.");
    const target = `${input.platform ?? process.platform}-${input.arch ?? process.arch}`;
    if (manifest.target !== target) return failure("the LiveKit wake bundle does not match this computer.");
    if (manifest.phraseId !== officialVoiceWakePhraseId || manifest.phrase !== officialVoiceWakePhrase) {
      return failure("the official wake classifier identity is invalid.");
    }
    if (!thresholdsAreValid(manifest.thresholds)) return failure("the wake sensitivity thresholds are invalid.");
    const declared = new Map(manifest.files.map((file) => [file.path, file]));
    for (const required of [manifest.helper, manifest.classifier, "THIRD_PARTY_NOTICES.md", "classifier-provenance.json"]) {
      if (!declared.has(required)) return failure("the LiveKit wake bundle is missing a required declared file.");
    }
    for (const file of manifest.files) validateFile(rootDir, file);
    const helperPath = safeBundlePath(rootDir, manifest.helper);
    const classifierPath = safeBundlePath(rootDir, manifest.classifier);
    return {
      ok: true,
      bundle: {
        rootDir,
        helperPath,
        classifierPath,
        bundleVersion: manifest.bundleVersion,
        phraseId: officialVoiceWakePhraseId,
        phrase: officialVoiceWakePhrase,
        thresholds: manifest.thresholds,
      },
    };
  } catch (error) {
    return failure(sanitizeReason(error));
  }
}

function validateFile(rootDir: string, file: ManifestFile): void {
  if (!safeRelativePath(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) {
    throw new Error("the LiveKit wake manifest contains an invalid file declaration.");
  }
  const path = safeBundlePath(rootDir, file.path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("a LiveKit wake resource is not a regular file.");
  if (stat.size !== file.bytes) throw new Error("a LiveKit wake resource has the wrong size.");
  const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (digest !== file.sha256) throw new Error("a LiveKit wake resource failed its integrity check.");
}

function safeBundlePath(rootDir: string, relativePath: string): string {
  if (!safeRelativePath(relativePath)) throw new Error("the LiveKit wake manifest contains an unsafe path.");
  const resolved = resolve(rootDir, ...relativePath.split("/"));
  if (resolved !== rootDir && !resolved.startsWith(rootDir + sep)) throw new Error("the LiveKit wake resource escapes its bundle.");
  return resolved;
}

function safeRelativePath(value: string): boolean {
  return Boolean(value)
    && !isAbsolute(value)
    && !value.includes("\\")
    && posix.normalize(value) === value
    && !value.split("/").includes("..");
}

function isManifest(value: unknown): value is Manifest {
  if (!isRecord(value) || value.version !== 1 || value.runtime !== "livekit-wakeword" || value.protocolVersion !== 2) return false;
  return typeof value.bundleVersion === "string" && value.bundleVersion.length > 0
    && typeof value.phraseId === "string"
    && typeof value.phrase === "string"
    && typeof value.target === "string"
    && typeof value.helper === "string"
    && typeof value.classifier === "string"
    && isRecord(value.thresholds)
    && Array.isArray(value.files)
    && value.files.length >= 4
    && value.files.every((file) => isRecord(file) && typeof file.path === "string" && typeof file.bytes === "number" && typeof file.sha256 === "string");
}

function thresholdsAreValid(value: Manifest["thresholds"]): boolean {
  const { easy, balanced, strict } = value;
  return [easy, balanced, strict].every((threshold) => Number.isFinite(threshold) && threshold > 0 && threshold <= 1)
    && easy <= balanced && balanced <= strict;
}

function sanitizeReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:[A-Za-z]:\\|\/)[^\s]+/g, "local file").trim().slice(0, 300) || "the LiveKit wake bundle is invalid.";
}

function failure(reason: string): LiveKitWakeBundleValidation {
  return { ok: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
