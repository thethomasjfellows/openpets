import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname } from "node:path";

import {
  createManagedHookCommand,
  managedCodexHookEvents,
  openPetsCodexMarker,
  resolveCodexPaths,
  type ManagedCodexHookEvent,
} from "./ownership.js";
import type {
  CodexComponentState,
  CodexHookTrustState,
  CodexIntegrationOptions,
} from "./types.js";

const maxHooksBytes = 512 * 1024;
const maxConfigBytes = 2 * 1024 * 1024;
const hookTimeoutSeconds = 10;

interface HookHandler {
  readonly type?: unknown;
  readonly command?: unknown;
  readonly timeout?: unknown;
  readonly async?: unknown;
  readonly [key: string]: unknown;
}

interface HookGroup {
  readonly matcher?: unknown;
  readonly hooks?: unknown;
  readonly [key: string]: unknown;
}

interface HooksDocument {
  readonly hooks?: unknown;
  readonly [key: string]: unknown;
}

export interface CodexHookInspection {
  readonly state: CodexComponentState;
  readonly trust: CodexHookTrustState;
  readonly path: string;
  readonly installedEvents: readonly string[];
  readonly changedEvents: readonly string[];
  readonly managedGroupIndexes: Readonly<Record<string, number>>;
}

export async function inspectCodexHooks(
  options: CodexIntegrationOptions,
): Promise<CodexHookInspection> {
  const paths = resolveCodexPaths(options.codexHome);
  const desiredCommand = createManagedHookCommand(options);
  const document = await readHooksDocument(paths.hooks);
  const installedEvents: string[] = [];
  const changedEvents: string[] = [];
  const managedGroupIndexes: Record<string, number> = {};

  for (const event of managedCodexHookEvents) {
    const groups = getEventGroups(document, event);
    const index = groups.findIndex(isManagedGroup);
    if (index === -1) continue;
    installedEvents.push(event);
    managedGroupIndexes[event] = index;
    if (!isCurrentManagedGroup(groups[index], desiredCommand)) changedEvents.push(event);
  }

  const hooksCurrent =
    installedEvents.length === managedCodexHookEvents.length && changedEvents.length === 0;
  const trust = hooksCurrent
    ? await inspectTrust(options, managedGroupIndexes, desiredCommand)
    : installedEvents.length === 0
      ? "missing"
      : "modified";
  return {
    state:
      installedEvents.length === 0
        ? "missing"
        : hooksCurrent
          ? "current"
          : "modified",
    trust,
    path: paths.hooks,
    installedEvents,
    changedEvents,
    managedGroupIndexes,
  };
}

export async function installCodexHooks(
  options: CodexIntegrationOptions,
): Promise<{ readonly changed: boolean }> {
  const paths = resolveCodexPaths(options.codexHome);
  const current = await readHooksDocument(paths.hooks);
  const next = cloneRecord(current);
  const hooks = isRecord(next.hooks) ? cloneRecord(next.hooks) : {};
  const desiredCommand = createManagedHookCommand(options);

  for (const event of managedCodexHookEvents) {
    const groups = getEventGroups({ hooks }, event).filter((group) => !isManagedGroup(group));
    groups.push(createManagedGroup(desiredCommand));
    hooks[event] = groups;
  }
  next.hooks = hooks;
  return writeHooksDocument(paths.hooks, current, next);
}

export async function uninstallCodexHooks(
  options: CodexIntegrationOptions,
): Promise<{ readonly changed: boolean }> {
  const paths = resolveCodexPaths(options.codexHome);
  const current = await readHooksDocument(paths.hooks);
  const next = cloneRecord(current);
  const hooks = isRecord(next.hooks) ? cloneRecord(next.hooks) : {};
  let removedManagedHook = false;

  for (const event of managedCodexHookEvents) {
    const currentGroups = getEventGroups({ hooks }, event);
    const groups = currentGroups.filter((group) => !isManagedGroup(group));
    if (groups.length !== currentGroups.length) removedManagedHook = true;
    if (groups.length > 0) hooks[event] = groups;
    else delete hooks[event];
  }
  if (!removedManagedHook) return { changed: false };
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;
  return writeHooksDocument(paths.hooks, current, next);
}

export async function restoreHooksFile(
  path: string,
  previous: string | undefined,
): Promise<void> {
  if (previous === undefined) {
    await rm(path, { force: true });
    return;
  }
  await atomicWrite(path, previous);
}

export async function readHooksFileForRollback(path: string): Promise<string | undefined> {
  try {
    return await readBoundedFile(path, maxHooksBytes);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function createManagedGroup(command: string): HookGroup {
  return {
    hooks: [
      {
        type: "command",
        command,
        timeout: hookTimeoutSeconds,
      },
    ],
  };
}

function isManagedGroup(value: HookGroup): boolean {
  if (!Array.isArray(value.hooks)) return false;
  return value.hooks.some(
    (handler) =>
      isRecord(handler) &&
      typeof handler.command === "string" &&
      handler.command.includes(openPetsCodexMarker),
  );
}

function isCurrentManagedGroup(value: HookGroup, command: string): boolean {
  if (!Array.isArray(value.hooks) || value.hooks.length !== 1) return false;
  const handler = value.hooks[0];
  return (
    isRecord(handler) &&
    handler.type === "command" &&
    handler.command === command &&
    handler.timeout === hookTimeoutSeconds &&
    handler.async !== true &&
    (value.matcher === undefined || value.matcher === null)
  );
}

async function inspectTrust(
  options: CodexIntegrationOptions,
  groupIndexes: Readonly<Record<string, number>>,
  command: string,
): Promise<CodexHookTrustState> {
  const paths = resolveCodexPaths(options.codexHome);
  let config: string;
  try {
    config = await readBoundedFile(paths.config, maxConfigBytes);
  } catch (error) {
    if (isMissing(error)) return "waiting";
    return "unsupported";
  }
  const states = parseHookStates(config);
  let waiting = false;
  for (const event of managedCodexHookEvents) {
    const groupIndex = groupIndexes[event];
    if (groupIndex === undefined) return "missing";
    const key = `${paths.hooks}:${eventKey(event)}:${groupIndex}:0`;
    const trustedHash = states.get(key);
    if (!trustedHash) {
      waiting = true;
      continue;
    }
    const currentHash = createHookHash(event, command);
    if (trustedHash !== currentHash) return "modified";
  }
  return waiting ? "waiting" : "trusted";
}

function createHookHash(event: ManagedCodexHookEvent, command: string): string {
  const identity = {
    event_name: eventKey(event),
    hooks: [
      {
        async: false,
        command,
        timeout: hookTimeoutSeconds,
        type: "command",
      },
    ],
  };
  const serialized = JSON.stringify(canonicalize(identity));
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function eventKey(event: ManagedCodexHookEvent): string {
  return event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function parseHookStates(config: string): Map<string, string> {
  const states = new Map<string, string>();
  let currentKey: string | undefined;
  for (const line of config.split(/\r?\n/)) {
    const section = /^\[hooks\.state\."((?:[^"\\]|\\.)+)"\]$/.exec(line.trim());
    if (section) {
      currentKey = section[1].replaceAll('\\"', '"').replaceAll("\\\\", "\\");
      continue;
    }
    if (line.trim().startsWith("[")) currentKey = undefined;
    const trusted = /^trusted_hash\s*=\s*"([^"]+)"\s*$/.exec(line.trim());
    if (currentKey && trusted) states.set(currentKey, trusted[1]);
  }
  return states;
}

async function readHooksDocument(path: string): Promise<Record<string, unknown>> {
  let source: string;
  try {
    source = await readBoundedFile(path, maxHooksBytes);
  } catch (error) {
    if (isMissing(error)) return {};
    throw error;
  }
  const parsed = JSON.parse(source) as unknown;
  if (!isRecord(parsed)) throw new Error("Codex hooks.json must contain a JSON object.");
  return parsed;
}

async function writeHooksDocument(
  path: string,
  current: Record<string, unknown>,
  next: Record<string, unknown>,
): Promise<{ readonly changed: boolean }> {
  const before = `${JSON.stringify(current, null, 2)}\n`;
  const after = `${JSON.stringify(next, null, 2)}\n`;
  if (before === after) return { changed: false };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error("Codex hooks.json must be a regular file.");
    }
    await copyFile(path, `${path}.openpets-backup`);
    await chmod(`${path}.openpets-backup`, 0o600);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await atomicWrite(path, after);
  return { changed: true };
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temp = `${path}.${process.pid}.openpets.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(temp, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await rename(temp, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function readBoundedFile(path: string, maxBytes: number): Promise<string> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`${basename(path)} must be a regular file.`);
  if (stats.size > maxBytes) throw new Error(`${basename(path)} is too large for OpenPets to manage safely.`);
  return readFile(path, "utf8");
}

function getEventGroups(document: HooksDocument, event: ManagedCodexHookEvent): HookGroup[] {
  if (!isRecord(document.hooks)) return [];
  const value = document.hooks[event];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
