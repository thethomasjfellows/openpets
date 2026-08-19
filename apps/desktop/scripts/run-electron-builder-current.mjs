#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptsDir, "..");
const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const allowedArgs = new Set(["--dir", "--validate-output"]);
const unknownArgs = rawArgs.filter((arg) => !allowedArgs.has(arg));
if (unknownArgs.length > 0) {
  throw new Error(`Unknown packaging option(s): ${unknownArgs.join(", ")}. Cross-target packaging must use the release workflow with a matching smoke-tested wake bundle.`);
}

const platformFlag = process.platform === "darwin"
  ? "--mac"
  : process.platform === "win32"
    ? "--win"
    : process.platform === "linux"
      ? "--linux"
      : null;
const archFlag = process.arch === "arm64"
  ? "--arm64"
  : process.arch === "x64"
    ? "--x64"
    : null;
if (!platformFlag || !archFlag) {
  throw new Error(`Unsupported desktop packaging host: ${process.platform}-${process.arch}`);
}

const builderArgs = [
  "exec",
  "electron-builder",
  platformFlag,
  archFlag,
  ...(rawArgs.includes("--dir") ? ["--dir"] : []),
];
run("pnpm", builderArgs);
if (process.platform === "darwin") {
  run("node", ["scripts/stabilize-macos-local-signature.mjs"]);
}
if (rawArgs.includes("--validate-output")) {
  run("node", ["dist/check-packaging-contract.js", "--output"]);
}

function commandForPlatform(command, args) {
  if (process.platform === "win32" && command === "pnpm") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", "pnpm.cmd", ...args] };
  }
  return { command, args };
}

function run(command, args) {
  const platformCommand = commandForPlatform(command, args);
  const result = spawnSync(platformCommand.command, platformCommand.args, {
    cwd: desktopDir,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`);
  }
}
