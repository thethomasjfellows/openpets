import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import { getAppStateSnapshot } from "./app-state.js";

/** Resolve the same Codex CLI for integrations, the companion, and Vision. */
export function getPreferredCodexCommand(): string {
  const configured = getAppStateSnapshot().preferences.codexCommandPath?.trim();
  if (configured) return configured;

  const executable = process.platform === "win32" ? "codex.cmd" : "codex";
  const pathCandidates = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, executable));
  const commonCandidates = process.platform === "darwin"
    ? [join("/opt/homebrew/bin", executable), join("/usr/local/bin", executable), join(homedir(), ".local", "bin", executable)]
    : process.platform === "win32"
      ? []
      : [join(homedir(), ".local", "bin", executable), join("/usr/local/bin", executable)];
  return [...pathCandidates, ...commonCandidates].find((candidate) => existsSync(candidate)) ?? executable;
}
