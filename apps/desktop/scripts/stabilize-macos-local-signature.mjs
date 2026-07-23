#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") process.exit(0);

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(desktopDir, "dist-electron");
const candidates = readdirSync(outputDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^mac(?:-|$)/.test(entry.name))
  .map((entry) => join(outputDir, entry.name, "openpets.app"))
  .filter(existsSync);

if (candidates.length !== 1) {
  throw new Error(`Expected exactly one packaged macOS OpenPets app, found ${candidates.length}.`);
}

const appPath = candidates[0];
const signature = capture("codesign", ["-dv", "--verbose=4", appPath]);
if (!signature.includes("Signature=adhoc")) {
  console.log("Preserving the packaged macOS signing identity.");
  process.exit(0);
}

// A default ad-hoc signature uses the changing binary CDHash as its designated
// requirement. macOS privacy controls then treat every local rebuild as a new
// application. Keep real Developer ID signatures untouched, but give local
// ad-hoc builds one stable identifier requirement so permissions survive the
// next replacement at the same canonical Applications path.
run("codesign", [
  "--force",
  "--sign",
  "-",
  "--requirements",
  '=designated => identifier "dev.openpets.app"',
  appPath,
]);
run("codesign", ["--verify", "--deep", "--strict", appPath]);
const requirement = capture("codesign", ["-dr", "-", appPath]);
if (!requirement.includes('designated => identifier "dev.openpets.app"')) {
  throw new Error("The packaged app did not retain the stable local designated requirement.");
}
console.log("Applied stable macOS identity for local OpenPets permission continuity.");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: desktopDir, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? "unknown"}.`);
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: desktopDir, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? "unknown"}.`);
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}
