import { copyFile, lstat, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";

import { defaultCodexCommandRunner, sanitizeCommandSummary } from "./codex-cli.js";
import { resolveCodexPaths } from "./ownership.js";
import type { CodexIntegrationOptions } from "./types.js";

const maxConfigBytes = 2 * 1024 * 1024;

export interface LegacyCodexInspection {
  readonly detected: boolean;
  readonly removable: boolean;
  readonly details: readonly string[];
}

export async function inspectLegacyCodexIntegration(
  options: CodexIntegrationOptions,
): Promise<LegacyCodexInspection> {
  const paths = resolveCodexPaths(options.codexHome);
  const config = await readOptionalRegularFile(paths.config);
  const details: string[] = [];
  if (config?.includes('[plugins."openpets@personal"]')) details.push("openpets@personal plugin registration");
  if (config?.includes('hooks.state."openpets@personal:')) details.push("legacy OpenPets hook trust records");
  if (await isRegularDirectory(paths.legacyCache)) details.push("legacy OpenPets plugin cache");
  if (await isRegularDirectory(paths.legacyData)) details.push("legacy OpenPets plugin runtime state");
  const marketplaceShared = config ? hasOtherPersonalPlugins(config) : false;
  if (config?.includes("[marketplaces.personal]")) {
    details.push(marketplaceShared ? "shared personal marketplace (preserved)" : "OpenPets personal marketplace");
  }
  return {
    detected: details.length > 0,
    removable: details.some((detail) => !detail.includes("(preserved)")),
    details,
  };
}

export async function migrateLegacyCodexIntegration(
  options: CodexIntegrationOptions,
): Promise<{ readonly changed: boolean; readonly details: readonly string[] }> {
  const paths = resolveCodexPaths(options.codexHome);
  const before = await inspectLegacyCodexIntegration(options);
  if (!before.detected) return { changed: false, details: [] };
  const run = options.runCommand ?? defaultCodexCommandRunner;
  const codex = options.codexCommand?.trim() || (process.platform === "win32" ? "codex.cmd" : "codex");
  let changed = false;
  const notes: string[] = [];

  const configBefore = await readOptionalRegularFile(paths.config);
  if (configBefore?.includes('[plugins."openpets@personal"]') || (await isRegularDirectory(paths.legacyCache))) {
    const removed = await run(codex, ["plugin", "remove", "openpets@personal", "--json"]);
    if (!removed.ok && !/not installed|not found|unknown plugin/i.test(sanitizeCommandSummary(removed))) {
      throw new Error(`Could not remove legacy openpets@personal: ${sanitizeCommandSummary(removed)}`);
    }
    changed = changed || removed.ok;
    notes.push("Removed legacy openpets@personal registration and cache.");
  }

  const config = await readOptionalRegularFile(paths.config);
  if (config) {
    const cleaned = removeLegacyTomlSections(config);
    if (cleaned !== config) {
      await atomicConfigWrite(paths.config, config, cleaned);
      changed = true;
      notes.push("Removed legacy OpenPets hook trust records.");
    }
  }

  if (await isRegularDirectory(paths.legacyData)) {
    await rm(paths.legacyData, { recursive: true });
    changed = true;
    notes.push("Removed legacy OpenPets hook runtime state.");
  }
  if (await isRegularDirectory(paths.legacyCache)) {
    await rm(paths.legacyCache, { recursive: true });
    changed = true;
    notes.push("Removed residual legacy OpenPets plugin cache.");
  }

  const latestConfig = await readOptionalRegularFile(paths.config);
  if (
    latestConfig?.includes("[marketplaces.personal]") &&
    !hasOtherPersonalPlugins(latestConfig) &&
    !(await hasOtherPersonalCacheEntries(paths.home))
  ) {
    const removed = await run(codex, ["plugin", "marketplace", "remove", "personal", "--json"]);
    if (removed.ok) {
      changed = true;
      notes.push("Removed the now-unused personal marketplace.");
    }
  }

  return { changed, details: notes };
}

export function removeLegacyTomlSections(source: string): string {
  const lines = source.split(/\r?\n/);
  const kept: string[] = [];
  let skip = false;
  for (const line of lines) {
    const section = /^\[([^\]]+)\]\s*$/.exec(line.trim());
    if (section) {
      const name = section[1];
      skip =
        name === 'plugins."openpets@personal"' ||
        name.startsWith('hooks.state."openpets@personal:');
    }
    if (!skip) kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

function hasOtherPersonalPlugins(config: string): boolean {
  return [...config.matchAll(/^\[plugins\."([^"]+@personal)"\]/gm)].some(
    (match) => match[1] !== "openpets@personal",
  );
}

async function hasOtherPersonalCacheEntries(codexHome: string): Promise<boolean> {
  try {
    const entries = await readdir(`${codexHome}/plugins/cache/personal`);
    return entries.some((entry) => entry !== "openpets");
  } catch {
    return false;
  }
}

async function readOptionalRegularFile(path: string): Promise<string | undefined> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("Codex config.toml must be a regular file.");
    if (stats.size > maxConfigBytes) throw new Error("Codex config.toml is too large for OpenPets to migrate safely.");
    return readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function isRegularDirectory(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) return false;
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function atomicConfigWrite(path: string, before: string, after: string): Promise<void> {
  const backup = `${path}.openpets-legacy-backup`;
  const temp = `${path}.${process.pid}.openpets.tmp`;
  await copyFile(path, backup);
  await writeFile(temp, after, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    await writeFile(path, before, { encoding: "utf8", mode: 0o600 });
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
