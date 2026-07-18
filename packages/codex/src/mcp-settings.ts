import { createManagedMcpCommand, openPetsCodexMcpServerName } from "./ownership.js";
import { defaultCodexCommandRunner, sanitizeCommandSummary } from "./codex-cli.js";
import type {
  CodexCommandRunner,
  CodexComponentState,
  CodexIntegrationOptions,
} from "./types.js";

const codexMcpMutationTimeoutMs = 20_000;

export interface CodexMcpEntry {
  readonly present: boolean;
  readonly state: CodexComponentState;
  readonly serverName: "openpets";
  readonly command?: string;
  readonly args?: readonly string[];
  readonly message?: string;
}

export async function inspectCodexMcp(
  options: CodexIntegrationOptions,
): Promise<CodexMcpEntry> {
  const run = options.runCommand ?? defaultCodexCommandRunner;
  const codex = options.codexCommand?.trim() || (process.platform === "win32" ? "codex.cmd" : "codex");
  const result = await run(codex, ["mcp", "get", openPetsCodexMcpServerName, "--json"]);
  if (!result.ok) {
    const summary = sanitizeCommandSummary(result);
    if (/not found|does not exist|unknown server|no server|no mcp server .* found/i.test(summary)) {
      return { present: false, state: "missing", serverName: "openpets" };
    }
    return { present: false, state: "error", serverName: "openpets", message: summary };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { present: true, state: "conflict", serverName: "openpets", message: "Codex returned an unreadable MCP entry." };
  }
  const actual = parseMcpCommand(parsed);
  if (!actual) {
    return { present: true, state: "conflict", serverName: "openpets", message: "Codex did not expose the openpets MCP command." };
  }
  const expected = createManagedMcpCommand(options);
  const current =
    actual.command === expected.command &&
    sameArgs(actual.args, expected.args);
  return {
    present: true,
    state: current ? "current" : "conflict",
    serverName: "openpets",
    command: actual.command,
    args: actual.args,
    message: current ? undefined : "The existing openpets MCP server is not managed by this OpenPets installation.",
  };
}

export async function installCodexMcp(
  options: CodexIntegrationOptions,
  replaceExisting: boolean,
): Promise<{ readonly changed: boolean }> {
  const run = options.runCommand ?? defaultCodexCommandRunner;
  const codex = preferredCodexCommand(options);
  const before = await inspectCodexMcp(options);
  if (before.state === "current") return { changed: false };
  if (before.present && !replaceExisting) {
    throw new Error(before.message || "A foreign openpets MCP server already exists.");
  }
  if (before.present) {
    const removed = await run(
      codex,
      ["mcp", "remove", openPetsCodexMcpServerName],
      { timeoutMs: codexMcpMutationTimeoutMs },
    );
    if (!removed.ok) throw new Error(`Could not remove the existing openpets MCP server: ${sanitizeCommandSummary(removed)}`);
  }
  const expected = createManagedMcpCommand(options);
  const added = await run(
    codex,
    [
      "mcp",
      "add",
      openPetsCodexMcpServerName,
      "--",
      expected.command,
      ...expected.args,
    ],
    { timeoutMs: codexMcpMutationTimeoutMs },
  );
  if (!added.ok) throw new Error(`Could not register the OpenPets MCP server: ${sanitizeCommandSummary(added)}`);
  return { changed: true };
}

export async function uninstallCodexMcp(
  options: CodexIntegrationOptions,
): Promise<{ readonly changed: boolean }> {
  const before = await inspectCodexMcp(options);
  if (!before.present) return { changed: false };
  if (before.state !== "current") {
    throw new Error("The openpets MCP server is not owned by this OpenPets installation.");
  }
  const run = options.runCommand ?? defaultCodexCommandRunner;
  const removed = await run(
    preferredCodexCommand(options),
    ["mcp", "remove", openPetsCodexMcpServerName],
    { timeoutMs: codexMcpMutationTimeoutMs },
  );
  if (!removed.ok) throw new Error(`Could not remove the OpenPets MCP server: ${sanitizeCommandSummary(removed)}`);
  return { changed: true };
}

export async function restoreCodexMcp(
  options: CodexIntegrationOptions,
  previous: CodexMcpEntry,
): Promise<void> {
  const run = options.runCommand ?? defaultCodexCommandRunner;
  const codex = preferredCodexCommand(options);
  const current = await inspectCodexMcp(options);
  if (current.present) {
    await run(
      codex,
      ["mcp", "remove", openPetsCodexMcpServerName],
      { timeoutMs: codexMcpMutationTimeoutMs },
    );
  }
  if (!previous.present) return;
  if (!previous.command || !previous.args) {
    throw new Error("The previous openpets MCP entry could not be restored automatically.");
  }
  const restored = await run(
    codex,
    [
      "mcp",
      "add",
      openPetsCodexMcpServerName,
      "--",
      previous.command,
      ...previous.args,
    ],
    { timeoutMs: codexMcpMutationTimeoutMs },
  );
  if (!restored.ok) throw new Error(`Could not restore the previous MCP entry: ${sanitizeCommandSummary(restored)}`);
}

function preferredCodexCommand(options: CodexIntegrationOptions): string {
  return options.codexCommand?.trim() || (process.platform === "win32" ? "codex.cmd" : "codex");
}

function parseMcpCommand(value: unknown): { command: string; args: readonly string[] } | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.command === "string") {
    return {
      command: value.command,
      args: Array.isArray(value.args) ? value.args.filter((item): item is string => typeof item === "string") : [],
    };
  }
  for (const key of ["transport", "server", "config", "result"]) {
    const nested = parseMcpCommand(value[key]);
    if (nested) return nested;
  }
  return undefined;
}

function sameArgs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
