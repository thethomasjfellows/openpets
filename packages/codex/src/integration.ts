import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

import { defaultCodexCommandRunner, sanitizeCommandSummary } from "./codex-cli.js";
import {
  inspectCodexHooks,
  installCodexHooks,
  readHooksFileForRollback,
  restoreHooksFile,
  uninstallCodexHooks,
} from "./hook-settings.js";
import {
  inspectLegacyCodexIntegration,
  migrateLegacyCodexIntegration,
} from "./legacy-migration.js";
import {
  inspectCodexMcp,
  installCodexMcp,
  restoreCodexMcp,
  uninstallCodexMcp,
} from "./mcp-settings.js";
import {
  buildManagedChanges,
  isSupportedCodexVersion,
  normalizeCodexVersion,
  resolveCodexPaths,
} from "./ownership.js";
import type {
  CodexActionResult,
  CodexIntegrationOptions,
  CodexIntegrationSnapshot,
} from "./types.js";

export async function doctorCodexIntegration(
  options: CodexIntegrationOptions,
): Promise<CodexIntegrationSnapshot> {
  const run = options.runCommand ?? defaultCodexCommandRunner;
  const command = preferredCodexCommand(options);
  const versionResult = await run(command, ["--version"], { timeoutMs: 5_000 });
  if (!versionResult.ok) {
    const paths = resolveCodexPaths(options.codexHome);
    const legacy = await inspectLegacyCodexIntegration(options);
    return createSnapshot({
      state: "not_detected",
      message: "Codex CLI was not detected.",
      command,
      detected: false,
      supported: false,
      hooks: { state: "missing", trust: "missing", path: paths.hooks, installedEvents: [] },
      mcp: { state: "missing", serverName: "openpets" },
      legacy,
      options,
    });
  }
  const version = normalizeCodexVersion(versionResult.stdout || versionResult.stderr);
  const location = await resolveExecutable(command);
  const [hooks, mcp, legacy] = await Promise.all([
    inspectCodexHooks(options),
    inspectCodexMcp(options),
    inspectLegacyCodexIntegration(options),
  ]);
  if (!isSupportedCodexVersion(version)) {
    return createSnapshot({
      state: "unsupported",
      message: version
        ? `Codex CLI ${version} is not supported by this OpenPets integration.`
        : "OpenPets could not determine the Codex CLI version.",
      command,
      detected: true,
      supported: false,
      version,
      location,
      hooks: { ...hooks, trust: "unsupported" },
      mcp,
      legacy,
      options,
    });
  }

  let state: CodexIntegrationSnapshot["state"];
  let message: string;
  if (mcp.state === "conflict") {
    state = "conflict";
    message = mcp.message || "A foreign openpets MCP server conflicts with OpenPets.";
  } else if (hooks.state === "missing" && mcp.state === "missing") {
    state = "installable";
    message = "Codex is ready to connect to OpenPets.";
  } else if (hooks.state !== "current" || mcp.state !== "current") {
    state = "needs_repair";
    message = mcp.message || "The OpenPets Codex integration needs repair.";
  } else if (hooks.trust !== "trusted") {
    state = hooks.trust === "modified" ? "needs_repair" : "waiting_for_trust";
    message =
      hooks.trust === "modified"
        ? "The OpenPets Codex hooks changed after approval."
        : "Waiting for approval in the Codex CLI.";
  } else {
    state = "connected";
    message = "Codex activity reactions and pet controls are connected.";
  }
  return createSnapshot({
    state,
    message,
    command,
    detected: true,
    supported: true,
    version,
    location,
    hooks,
    mcp,
    legacy,
    options,
  });
}

export async function installCodexIntegration(
  options: CodexIntegrationOptions,
): Promise<CodexActionResult> {
  return reconcileCodexIntegration(options, false);
}

export async function repairCodexIntegration(
  options: CodexIntegrationOptions,
): Promise<CodexActionResult> {
  return reconcileCodexIntegration(options, true);
}

export async function disconnectCodexIntegration(
  options: CodexIntegrationOptions,
): Promise<CodexActionResult> {
  let changed = false;
  const errors: string[] = [];
  try {
    changed = (await uninstallCodexHooks(options)).changed || changed;
  } catch (error) {
    errors.push(errorMessage(error));
  }
  try {
    changed = (await uninstallCodexMcp(options)).changed || changed;
  } catch (error) {
    errors.push(errorMessage(error));
  }

  let snapshot = await doctorCodexIntegration(options);
  if (snapshot.hooks.state === "missing" && snapshot.mcp.state === "current") {
    try {
      changed = (await uninstallCodexMcp(options)).changed || changed;
      snapshot = await doctorCodexIntegration(options);
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }

  if (isCleanlyDisconnected(snapshot)) {
    return {
      ok: true,
      changed,
      message: changed
        ? "Disconnected Codex from OpenPets."
        : "Codex is already disconnected from OpenPets.",
      snapshot,
    };
  }

  return {
    ok: false,
    changed,
    message: errors[0] || snapshot.message,
    snapshot,
  };
}

function isCleanlyDisconnected(snapshot: CodexIntegrationSnapshot): boolean {
  return (
    snapshot.state === "installable" &&
    snapshot.hooks.state === "missing" &&
    snapshot.mcp.state === "missing"
  );
}

async function reconcileCodexIntegration(
  options: CodexIntegrationOptions,
  replaceExisting: boolean,
): Promise<CodexActionResult> {
  const before = await doctorCodexIntegration(options);
  if (!before.detected || !before.supported) {
    return { ok: false, changed: false, message: before.message, snapshot: before };
  }
  if (before.state === "conflict" && !replaceExisting) {
    return { ok: false, changed: false, message: before.message, snapshot: before };
  }
  const paths = resolveCodexPaths(options.codexHome);
  const hooksBefore = await readHooksFileForRollback(paths.hooks);
  const mcpBefore = await inspectCodexMcp(options);
  let changed = false;
  try {
    changed = (await installCodexHooks(options)).changed || changed;
    changed = (await installCodexMcp(options, replaceExisting)).changed || changed;
    const verified = await doctorCodexIntegration(options);
    if (verified.hooks.state !== "current" || verified.mcp.state !== "current") {
      throw new Error("OpenPets could not verify the replacement Codex integration.");
    }
    const migrated = await migrateLegacyCodexIntegration(options);
    changed = migrated.changed || changed;
    const snapshot = await doctorCodexIntegration(options);
    return {
      ok: true,
      changed,
      message:
        snapshot.state === "waiting_for_trust"
          ? "Installed OpenPets for Codex. Approve the managed hooks in the Codex CLI to finish connecting."
          : "Connected Codex to OpenPets.",
      snapshot,
    };
  } catch (error) {
    const rollbackErrors: string[] = [];
    try {
      await restoreHooksFile(paths.hooks, hooksBefore);
    } catch (rollbackError) {
      rollbackErrors.push(errorMessage(rollbackError));
    }
    try {
      await restoreCodexMcp(options, mcpBefore);
    } catch (rollbackError) {
      rollbackErrors.push(errorMessage(rollbackError));
    }
    const snapshot = await doctorCodexIntegration(options);
    const suffix = rollbackErrors.length
      ? ` Rollback also reported: ${rollbackErrors.join("; ")}`
      : "";
    return { ok: false, changed, message: `${errorMessage(error)}${suffix}`, snapshot };
  }
}

function createSnapshot(
  input: Omit<CodexIntegrationSnapshot, "managedChanges" | "canInstall" | "canRepair" | "canDisconnect" | "canRefresh"> & {
    readonly options: CodexIntegrationOptions;
  },
): CodexIntegrationSnapshot {
  const { options, ...snapshot } = input;
  const hooksPresent = snapshot.hooks.state !== "missing";
  const mcpPresent = snapshot.mcp.state !== "missing";
  return {
    ...snapshot,
    managedChanges: buildManagedChanges(options, {
      hooks: hooksPresent,
      trust: snapshot.hooks.trust === "trusted",
      mcp: mcpPresent,
      legacy: snapshot.legacy.detected,
    }),
    canInstall: snapshot.state === "installable",
    canRepair: snapshot.state === "needs_repair" || snapshot.state === "conflict",
    canDisconnect: hooksPresent || mcpPresent,
    canRefresh: true,
  };
}

function preferredCodexCommand(options: CodexIntegrationOptions): string {
  return options.codexCommand?.trim() || (process.platform === "win32" ? "codex.cmd" : "codex");
}

async function resolveExecutable(command: string): Promise<string | undefined> {
  if (isAbsolute(command)) return command;
  const suffixes = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    for (const suffix of suffixes) {
      const candidate = join(directory, `${command}${suffix}`);
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Keep searching PATH.
      }
    }
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return sanitizeCommandSummary({ ok: false, status: null, stdout: "", stderr: "", error: String(error) });
}
