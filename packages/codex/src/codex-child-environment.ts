import { delimiter, dirname, isAbsolute, normalize } from "node:path";

/**
 * Build the minimal environment used by OpenPets-owned Codex subprocesses.
 * Packaged GUI apps inherit a minimal PATH, so an absolute `#!/usr/bin/env
 * node` Codex script also needs its containing directory on PATH.
 */
export function createCodexChildEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
  command = "codex",
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const allowed = process.platform === "win32"
    ? ["SystemRoot", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATH", "PATHEXT", "TEMP", "TMP", "LANG", "CODEX_HOME"]
    : ["HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "CODEX_HOME"];
  for (const key of allowed) {
    const value = source[key];
    if (value) result[key] = value;
  }
  if (isAbsolute(command)) {
    const commandDirectory = dirname(command);
    const existing = (result.PATH ?? "").split(delimiter).filter(Boolean);
    const commandKey = comparablePath(commandDirectory);
    result.PATH = [commandDirectory, ...existing.filter((entry) => comparablePath(entry) !== commandKey)].join(delimiter);
  }
  return result;
}

function comparablePath(value: string): string {
  const normalized = normalize(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}
