#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = hostTarget();
const releaseRoot = resolve(process.env.OPENPETS_LIVEKIT_WAKE_RELEASE ?? join(root, "training", "release"));
const classifierSource = join(releaseRoot, "hey_pedra.onnx");
const provenanceSource = join(releaseRoot, "classifier-provenance.json");
await assertRegular(classifierSource, "Hey Pedra classifier");
const provenance = await readJsonRegular(provenanceSource, "classifier provenance");
validateProvenance(provenance, await sha256(classifierSource));

const cargo = findCargo();
run(cargo, ["build", "--release", "--locked"], join(root, "native"), {
  ...process.env,
  PATH: `${dirname(cargo)}${delimiter}${process.env.PATH ?? ""}`,
});

const executable = process.platform === "win32" ? "openpets-livekit-wake-helper.exe" : "openpets-livekit-wake-helper";
const helperSource = join(root, "native", "target", "release", executable);
await assertRegular(helperSource, "compiled LiveKit wake helper");

const bundleRoot = join(root, "bundle", target);
await safeReset(bundleRoot, join(root, "bundle"));
const helperRelative = `bin/${executable}`;
const classifierRelative = "models/hey_pedra.onnx";
const copies = [
  [helperSource, helperRelative],
  [classifierSource, classifierRelative],
  [join(root, "THIRD_PARTY_NOTICES.md"), "THIRD_PARTY_NOTICES.md"],
  [provenanceSource, "classifier-provenance.json"],
];
for (const [source, relativePath] of copies) {
  const destination = join(bundleRoot, ...relativePath.split("/"));
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}
if (process.platform !== "win32") await chmod(join(bundleRoot, helperRelative), 0o755);

const files = [];
for (const [, relativePath] of copies) {
  const absolute = join(bundleRoot, ...relativePath.split("/"));
  const info = await lstat(absolute);
  files.push({ path: relativePath, bytes: info.size, sha256: await sha256(absolute) });
}
const manifest = {
  version: 1,
  runtime: "livekit-wakeword",
  protocolVersion: 2,
  bundleVersion: provenance.bundleVersion,
  phraseId: "openpets.hey-pedra.v1",
  phrase: "Hey Pedra",
  target,
  helper: helperRelative,
  classifier: classifierRelative,
  thresholds: provenance.thresholds,
  files,
};
await writeFile(join(bundleRoot, "openpets-livekit-wake.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Prepared attested LiveKit wake bundle: ${target}`);

function validateProvenance(value, classifierSha256) {
  if (!value || value.phraseId !== "openpets.hey-pedra.v1" || value.phrase !== "Hey Pedra") throw new Error("Classifier provenance has the wrong phrase identity.");
  if (typeof value.bundleVersion !== "string" || !value.bundleVersion) throw new Error("Classifier provenance is missing a bundle version.");
  if (value.livekitWakewordVersion !== "0.1.3" || !/^[a-f0-9]{40}$/.test(value.trainingCommit ?? "") || !/^[a-f0-9]{64}$/.test(value.trainingConfigSha256 ?? "")) throw new Error("Classifier provenance is not reproducibly pinned.");
  if (!/^[a-f0-9]{64}$/.test(value.classifierSha256 ?? "") || value.classifierSha256 !== classifierSha256) throw new Error("Classifier provenance does not match the release model.");
  const { easy, balanced, strict } = value.thresholds ?? {};
  if (![easy, balanced, strict].every((number) => Number.isFinite(number) && number > 0 && number <= 1) || !(easy <= balanced && balanced <= strict)) throw new Error("Classifier thresholds are invalid.");
  if (!Number.isFinite(value.metrics?.falsePositivesPerHour) || value.metrics.falsePositivesPerHour > 0.5 || !Number.isFinite(value.metrics?.recall) || value.metrics.recall < 0.75) throw new Error("Classifier evaluation does not meet the OpenPets release floor.");
}

function findCargo() {
  const result = spawnSync("rustup", ["which", "cargo"], { encoding: "utf8" });
  const path = result.status === 0 ? result.stdout.trim() : "";
  if (!path) throw new Error("Rust stable and Cargo are required to build the LiveKit wake helper.");
  return path;
}

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Command failed: ${command}`);
}

async function readJsonRegular(path, label) {
  await assertRegular(path, label);
  try { return JSON.parse(await readFile(path, "utf8")); } catch { throw new Error(`${label} is invalid JSON.`); }
}

async function assertRegular(path, label) {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`${label} is missing.`);
}

async function sha256(path) { return createHash("sha256").update(await readFile(path)).digest("hex"); }

async function safeReset(path, parent) {
  const child = relative(resolve(parent), resolve(path));
  if (!child || child === ".." || child.startsWith(`..${sep}`)) throw new Error("Refusing to reset an unsafe LiveKit bundle path.");
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
}

function hostTarget() {
  if (!["darwin", "win32", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch)) throw new Error("This host is not a supported LiveKit wake target.");
  return `${process.platform}-${process.arch}`;
}
