import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { CodexIntegrationOptions, CodexManagedChange } from "./types.js";

export const openPetsCodexMarker = "--openpets-managed";
export const openPetsCodexMcpServerName = "openpets" as const;
export const minimumSupportedCodexVersion = { major: 0, minor: 144 } as const;

export const managedCodexHookEvents = [
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "SubagentStop",
  "Stop",
] as const;

export type ManagedCodexHookEvent = typeof managedCodexHookEvents[number];

export interface CodexPaths {
  readonly home: string;
  readonly config: string;
  readonly hooks: string;
  readonly legacyCache: string;
  readonly legacyData: string;
  readonly localPets: string;
}

export function resolveCodexPaths(codexHome = join(homedir(), ".codex")): CodexPaths {
  const home = resolve(codexHome);
  return {
    home,
    config: join(home, "config.toml"),
    hooks: join(home, "hooks.json"),
    legacyCache: join(home, "plugins", "cache", "personal", "openpets"),
    legacyData: join(home, "plugins", "data", "openpets-personal"),
    localPets: join(home, "pets"),
  };
}

export function quoteCommandArg(value: string): string {
  if (process.platform === "win32") return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function createManagedHookCommand(options: CodexIntegrationOptions): string {
  const nodeCommand = options.nodeCommand?.trim() || process.execPath;
  return `${quoteCommandArg(nodeCommand)} ${quoteCommandArg(resolve(options.hookCliPath))} hook ${openPetsCodexMarker}`;
}

export function createManagedMcpCommand(options: CodexIntegrationOptions): {
  readonly command: string;
  readonly args: readonly string[];
} {
  return {
    command: options.nodeCommand?.trim() || process.execPath,
    args: [resolve(options.mcpEntryPath)],
  };
}

export function buildManagedChanges(
  options: CodexIntegrationOptions,
  presence: {
    readonly hooks: boolean;
    readonly trust: boolean;
    readonly mcp: boolean;
    readonly legacy: boolean;
  },
): readonly CodexManagedChange[] {
  const paths = resolveCodexPaths(options.codexHome);
  return [
    {
      id: "hooks-file",
      path: paths.hooks,
      title: "Codex lifecycle hooks",
      detail: `Adds OpenPets handlers for ${managedCodexHookEvents.join(", ")} using the runtime bundled with the OpenPets desktop app.`,
      ownership: "managed",
      present: presence.hooks,
    },
    {
      id: "mcp-server",
      path: paths.config,
      title: "OpenPets MCP server",
      detail: `Adds the '${openPetsCodexMcpServerName}' MCP server using the runtime bundled with the OpenPets desktop app.`,
      ownership: "managed",
      present: presence.mcp,
    },
    {
      id: "hook-trust",
      path: paths.config,
      title: "Codex hook trust",
      detail: "Read-only hooks.state entries. Approval remains in the interactive Codex CLI.",
      ownership: "read_only",
      present: presence.trust,
    },
    {
      id: "legacy-plugin",
      path: paths.home,
      title: "Legacy OpenPets Codex plugin",
      detail: "openpets@personal registration, exact hook trust keys, cache, and runtime state.",
      ownership: "legacy",
      present: presence.legacy,
    },
  ];
}

export function isSupportedCodexVersion(version: string | undefined): boolean {
  if (!version) return false;
  const match = /(?:codex-cli\s+)?(\d+)\.(\d+)\.(\d+)/i.exec(version);
  return Boolean(
    match &&
      Number(match[1]) === minimumSupportedCodexVersion.major &&
      Number(match[2]) >= minimumSupportedCodexVersion.minor,
  );
}

export function normalizeCodexVersion(output: string): string | undefined {
  return /(?:codex-cli\s+)?(\d+\.\d+\.\d+)/i.exec(output)?.[1];
}
