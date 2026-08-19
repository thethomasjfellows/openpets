#!/usr/bin/env node

import { copyFile, lstat, mkdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = dirname(root);
const target = `${process.platform}-${process.arch}`;
const sourceRoot = join(root, "bundle", target);
const { validateLiveKitWakeBundle } = await import(pathToFileURL(join(appDir, "dist", "voice-wake-livekit-manifest.js")).href);
const validation = validateLiveKitWakeBundle({ rootDir: sourceRoot });
if (!validation.ok) throw new Error(`Cannot stage LiveKit wake bundle: ${validation.reason}`);

const stagedRoot = join(root, "package-resource");
await safeReset(stagedRoot);
await copy("openpets-livekit-wake.manifest.json");
const helper = process.platform === "win32" ? "bin/openpets-livekit-wake-helper.exe" : "bin/openpets-livekit-wake-helper";
for (const relativePath of [helper, "models/hey_pedra.onnx", "THIRD_PARTY_NOTICES.md", "classifier-provenance.json"]) await copy(relativePath);
const staged = validateLiveKitWakeBundle({ rootDir: stagedRoot });
if (!staged.ok) throw new Error(`Staged LiveKit wake bundle is invalid: ${staged.reason}`);
console.log(`Staged validated LiveKit wake bundle: ${target}`);

async function copy(relativePath) {
  const source = join(sourceRoot, ...relativePath.split("/"));
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("LiveKit staging accepts regular files only.");
  const destination = join(stagedRoot, ...relativePath.split("/"));
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function safeReset(path) {
  const child = relative(root, resolve(path));
  if (child !== "package-resource" || child.startsWith(`..${sep}`)) throw new Error("Refusing to reset unsafe LiveKit staging path.");
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
}
