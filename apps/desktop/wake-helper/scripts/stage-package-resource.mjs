#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { computeWakeBuildInputDigest } from "./build-input-digest.mjs";

const wakeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = dirname(wakeRoot);
const target = valueAfter("--target") ?? hostPlatformId();
const [platform, arch] = target.split("-");
if (!["darwin", "win32", "linux"].includes(platform) || !["x64", "arm64"].includes(arch)) {
  throw new Error(`Unsupported wake target: ${target}`);
}

const validatorUrl = pathToFileURL(
  join(appDir, "dist", "voice-wake-sherpa-manifest.js"),
).href;
const smokeValidatorUrl = pathToFileURL(
  join(appDir, "dist", "voice-wake-smoke-attestation.js"),
).href;
const { validateSherpaVoiceWakeBundle } = await import(validatorUrl);
const { validateVoiceWakeSmokeAttestation } = await import(smokeValidatorUrl);
const sourceRoot = join(wakeRoot, "bundle", target);
const validation = validateSherpaVoiceWakeBundle({
  rootDir: sourceRoot,
  platform,
  arch,
});
if (!validation.ok) {
  throw new Error(`Cannot stage wake bundle for ${target}: ${validation.reason}`);
}
const buildInputSha256 = await computeWakeBuildInputDigest();
if (validation.bundle.buildInputSha256 !== buildInputSha256) {
  throw new Error(`Cannot stage wake bundle for ${target}: bundle build inputs do not match the current checkout.`);
}
await assertSmokeAttestation(
  join(wakeRoot, "bundle", `${target}.smoke.json`),
  validation.bundle,
);

const stagedRoot = join(wakeRoot, "package-resource");
await safeReset(stagedRoot);
await mkdir(stagedRoot, { recursive: true });
await copyRegularFile(validation.bundle.manifestPath, join(
  stagedRoot,
  "openpets-voice-wake.manifest.json",
));
for (const file of validation.bundle.files) {
  const destination = join(stagedRoot, ...file.path.split("/"));
  await copyRegularFile(file.absolutePath, destination);
}
if (!target.startsWith("win32-")) {
  await chmod(join(stagedRoot, "bin", "openpets-wake-helper"), 0o755);
}

const stagedValidation = validateSherpaVoiceWakeBundle({
  rootDir: stagedRoot,
  platform,
  arch,
});
if (!stagedValidation.ok) {
  throw new Error(`Staged wake bundle failed validation: ${stagedValidation.reason}`);
}
console.log(`Staged validated wake bundle for packaging: ${target}`);

async function assertSmokeAttestation(path, bundle) {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new Error(`Cannot stage wake bundle for ${target}: native smoke attestation is missing.`);
  }
  let attestation;
  try {
    attestation = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`Cannot stage wake bundle for ${target}: native smoke attestation is invalid.`);
  }
  const result = validateVoiceWakeSmokeAttestation(attestation, {
    target,
    targetPlatform: platform,
    targetArch: arch,
    manifestSha256: await sha256(bundle.manifestPath),
    helperSha256: await sha256(bundle.helperPath),
    buildInputSha256,
  });
  if (!result.ok) {
    throw new Error(`Cannot stage wake bundle for ${target}: ${result.reason}`);
  }
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function copyRegularFile(source, destination) {
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("Wake bundle staging only accepts regular files.");
  }
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function safeReset(path) {
  const absolute = resolve(path);
  const root = resolve(wakeRoot);
  const child = relative(root, absolute);
  if (
    child.length < 1 ||
    child === ".." ||
    child.startsWith(".." + sep) ||
    absolute !== resolve(wakeRoot, "package-resource")
  ) {
    throw new Error(`Refusing to reset unsafe staging path: ${absolute}`);
  }
  await rm(absolute, { recursive: true, force: true });
}

function hostPlatformId() {
  const hostArch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : "";
  if (!["darwin", "win32", "linux"].includes(process.platform) || !hostArch) {
    throw new Error("This host has no supported wake target.");
  }
  return `${process.platform}-${hostArch}`;
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}
