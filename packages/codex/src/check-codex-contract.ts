import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { classifyCodexHookPayload } from "./hooks.js";
import { inspectCodexHooks, installCodexHooks, uninstallCodexHooks } from "./hook-settings.js";
import { disconnectCodexIntegration, doctorCodexIntegration } from "./integration.js";
import { inspectCodexMcp, uninstallCodexMcp } from "./mcp-settings.js";
import { removeLegacyTomlSections } from "./legacy-migration.js";
import { sanitizeCommandSummary } from "./codex-cli.js";
import { createCodexChildEnvironment } from "./codex-child-environment.js";
import { buildManagedChanges, isSupportedCodexVersion, resolveCodexPaths } from "./ownership.js";
import { discoverCodexModels, parseCodexModelListResponse } from "./model-discovery.js";
import type { CodexIntegrationOptions } from "./types.js";

assert.equal(isSupportedCodexVersion("codex-cli 0.144.4"), true);
assert.equal(isSupportedCodexVersion("codex-cli 0.145.0"), true);
assert.equal(isSupportedCodexVersion("codex-cli 0.143.9"), false);
assert.equal(isSupportedCodexVersion("codex-cli 1.0.0"), false);
const modelCatalogResponse = {
  id: 2,
  result: {
    data: [
      {
        id: "gpt-default",
        model: "gpt-default",
        displayName: "GPT Default",
        description: "Default multimodal model",
        isDefault: true,
        hidden: false,
        inputModalities: ["text", "image"],
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Fast" },
          { reasoningEffort: "high", description: "Thorough" },
        ],
      },
      {
        id: "gpt-text",
        model: "gpt-text",
        displayName: "GPT Text",
        inputModalities: ["text"],
        supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
      },
    ],
  },
};
const parsedModels = parseCodexModelListResponse(modelCatalogResponse, 123);
assert.equal(parsedModels.status, "ready");
assert.equal(parsedModels.defaultModelId, "gpt-default");
assert.deepEqual(parsedModels.models[0]?.inputModalities, ["text", "image"]);
assert.deepEqual(parsedModels.models[0]?.supportedReasoningEfforts.map((effort) => effort.value), ["low", "high"]);
const discoveredModels = await discoverCodexModels({ now: () => 456, runAppServer: async (command) => {
  assert.equal(command, "/usr/local/bin/codex-test");
  return modelCatalogResponse;
}, codexCommand: "/usr/local/bin/codex-test" });
assert.equal(discoveredModels.status, "ready");
assert.equal(discoveredModels.checkedAt, 456);
const absoluteCodexCommand = process.platform === "win32" ? "C:\\Codex\\codex.exe" : "/opt/homebrew/bin/codex";
const absoluteCodexDirectory = process.platform === "win32" ? "C:\\Codex" : "/opt/homebrew/bin";
const duplicateCodexDirectory = `${absoluteCodexDirectory}${process.platform === "win32" ? "\\" : "/"}`;
const packagedCodexEnvironment = createCodexChildEnvironment({
  HOME: "/Users/example",
  USERPROFILE: "C:\\Users\\example",
  PATH: ["/usr/bin", duplicateCodexDirectory, "/bin"].join(delimiter),
  OPENAI_API_KEY: "must-not-leak",
}, absoluteCodexCommand);
assert.equal(packagedCodexEnvironment.PATH?.split(delimiter)[0], absoluteCodexDirectory);
assert.equal(packagedCodexEnvironment.PATH?.split(delimiter).filter((entry) => entry.startsWith(absoluteCodexDirectory)).length, 1);
assert.equal(process.platform === "win32" ? packagedCodexEnvironment.USERPROFILE : packagedCodexEnvironment.HOME, process.platform === "win32" ? "C:\\Users\\example" : "/Users/example");
assert.equal(packagedCodexEnvironment.OPENAI_API_KEY, undefined);
assert.deepEqual(classifyCodexHookPayload({ hook_event_name: "UserPromptSubmit", prompt: "secret" }), {
  lifecycle: "thinking",
  reaction: "thinking",
});
assert.deepEqual(
  classifyCodexHookPayload({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "pnpm test", secret: "do not emit" },
  }),
  { lifecycle: "testing", reaction: "testing" },
);
assert.equal(classifyCodexHookPayload({ hook_event_name: "Unknown", prompt: "secret" }), undefined);
assert.equal((await inspectCodexMcp({
  hookCliPath: "/tmp/openpets-hook.js",
  mcpEntryPath: "/tmp/openpets-mcp.js",
  runCommand: async () => ({ ok: false, status: 1, stdout: "", stderr: "Error: No MCP server named 'openpets' found." }),
})).state, "missing");
const foreignMcpCalls: string[][] = [];
const foreignMcpOptions: CodexIntegrationOptions = {
  hookCliPath: "/tmp/openpets-hook.js",
  mcpEntryPath: "/tmp/openpets-mcp.js",
  runCommand: async (_command, args) => {
    foreignMcpCalls.push([...args]);
    return { ok: true, status: 0, stdout: JSON.stringify({ transport: { command: "/usr/bin/foreign", args: [] } }), stderr: "" };
  },
};
await assert.rejects(() => uninstallCodexMcp(foreignMcpOptions), /not owned/);
assert.deepEqual(foreignMcpCalls, [["mcp", "get", "openpets", "--json"]]);

const ownedMcpPath = "/Applications/OpenPets.app/Contents/Resources/app.asar.unpacked/node_modules/@open-pets/mcp/dist/index.js";
assert.equal((await inspectCodexMcp({
  hookCliPath: "/tmp/openpets-hook.js",
  mcpEntryPath: ownedMcpPath,
  nodeCommand: "/Applications/OpenPets.app/Contents/Frameworks/OpenPets Helper.app/Contents/MacOS/OpenPets Helper",
  runCommand: async () => ({
    ok: true,
    status: 0,
    stdout: JSON.stringify({
      transport: {
        command: "/Applications/OpenPets.app/Contents/Frameworks/OpenPets Helper.app/Contents/MacOS/OpenPets Helper",
        args: [ownedMcpPath],
      },
    }),
    stderr: "",
  }),
})).state, "current", "machine-readable Codex output must retain exact paths for ownership verification");

const safeSummary = sanitizeCommandSummary({
  ok: false,
  status: 1,
  stdout: "",
  stderr: `failed at ${join(process.env.HOME || "/Users/example", "private", "runtime.js")} token=secret-value`,
});
assert.doesNotMatch(safeSummary, /runtime\.js|secret-value/);
assert.match(safeSummary, /<path>|~/);

const configWithLegacy = `[plugins."openpets@personal"]
enabled = true

[plugins."other@personal"]
enabled = true

[hooks.state."openpets@personal:hooks/hooks.json:stop:0:0"]
trusted_hash = "sha256:legacy"

[hooks.state."other@market:hooks.json:stop:0:0"]
trusted_hash = "sha256:keep"
`;
const cleaned = removeLegacyTomlSections(configWithLegacy);
assert.doesNotMatch(cleaned, /openpets@personal/);
assert.match(cleaned, /other@personal/);
assert.match(cleaned, /other@market/);

const root = await mkdtemp(join(tmpdir(), "openpets-codex-"));
const codexHome = join(root, ".codex");
await mkdir(codexHome, { recursive: true });
await writeFile(
  join(codexHome, "hooks.json"),
  JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "echo unrelated" }] }],
    },
  }),
);
const options: CodexIntegrationOptions = {
  codexHome,
  hookCliPath: join(root, "codex-cli.js"),
  mcpEntryPath: join(root, "mcp.js"),
  nodeCommand: "/usr/bin/node",
};
for (const change of buildManagedChanges(options, { hooks: false, trust: false, mcp: false, legacy: false })) {
  assert.doesNotMatch(change.detail, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "casual transparency copy must not expose runtime paths");
}
assert.equal((await inspectCodexHooks(options)).state, "missing");
assert.equal((await installCodexHooks(options)).changed, true);
const installed = await inspectCodexHooks(options);
assert.equal(installed.state, "current");
assert.equal(installed.trust, "waiting");
const installedSource = await readFile(resolveCodexPaths(codexHome).hooks, "utf8");
assert.match(installedSource, /echo unrelated/);
assert.match(installedSource, /--openpets-managed/);
const userPromptGroup = installed.managedGroupIndexes.UserPromptSubmit;
assert.equal(typeof userPromptGroup, "number");
await writeFile(join(codexHome, "config.toml"), `[hooks.state."${resolveCodexPaths(codexHome).hooks}:user_prompt_submit:${userPromptGroup}:0"]\ntrusted_hash = "sha256:stale-approval"\n`);
const approvalSnapshot = await doctorCodexIntegration({
  ...options,
  codexCommand: "/usr/bin/codex-test",
  runCommand: async (_command, args) => {
    if (args[0] === "--version") return { ok: true, status: 0, stdout: "codex-cli 0.144.4", stderr: "" };
    if (args[0] === "mcp" && args[1] === "get") return {
      ok: true,
      status: 0,
      stdout: JSON.stringify({ transport: { command: "/usr/bin/node", args: [options.mcpEntryPath] } }),
      stderr: "",
    };
    throw new Error(`Unexpected Codex command: ${args.join(" ")}`);
  },
});
assert.equal(approvalSnapshot.state, "waiting_for_trust", "stale approval needs review, not an endless repair loop");
assert.equal(approvalSnapshot.canRepair, false);
assert.equal(approvalSnapshot.checks.find((check) => check.id === "hook-trust")?.state, "waiting");
assert.equal((await uninstallCodexHooks(options)).changed, true);
const uninstalledSource = await readFile(resolveCodexPaths(codexHome).hooks, "utf8");
assert.match(uninstalledSource, /echo unrelated/);
assert.doesNotMatch(uninstalledSource, /--openpets-managed/);

const disconnectRoot = await mkdtemp(join(tmpdir(), "openpets-codex-disconnect-"));
const disconnectHome = join(disconnectRoot, ".codex");
await mkdir(disconnectHome, { recursive: true });
let ownedMcpPresent = true;
let simulateRemoveTimeout = true;
const disconnectOptions: CodexIntegrationOptions = {
  codexCommand: "/usr/bin/codex-test",
  codexHome: disconnectHome,
  hookCliPath: join(disconnectRoot, "codex-cli.js"),
  mcpEntryPath: join(disconnectRoot, "mcp.js"),
  nodeCommand: "/usr/bin/node",
  runCommand: async (_command, args) => {
    if (args[0] === "--version") {
      return { ok: true, status: 0, stdout: "codex-cli 0.144.4", stderr: "" };
    }
    if (args[0] === "mcp" && args[1] === "get") {
      return ownedMcpPresent
        ? {
            ok: true,
            status: 0,
            stdout: JSON.stringify({
              transport: {
                command: "/usr/bin/node",
                args: [join(disconnectRoot, "mcp.js")],
              },
            }),
            stderr: "",
          }
        : {
            ok: false,
            status: 1,
            stdout: "",
            stderr: "No MCP server named 'openpets' found.",
          };
    }
    if (args[0] === "mcp" && args[1] === "remove") {
      ownedMcpPresent = false;
      if (simulateRemoveTimeout) {
        simulateRemoveTimeout = false;
        return {
          ok: false,
          status: null,
          stdout: "",
          stderr: "",
          error: "Command timed out.",
        };
      }
      return { ok: true, status: 0, stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected Codex command: ${args.join(" ")}`);
  },
};
await installCodexHooks(disconnectOptions);
const disconnected = await disconnectCodexIntegration(disconnectOptions);
assert.equal(disconnected.ok, true, "a completed removal must not be reported as broken after a late timeout");
assert.equal(disconnected.snapshot.state, "installable");
assert.equal(disconnected.snapshot.canInstall, true);
assert.equal(disconnected.snapshot.canRepair, false);
assert.equal(disconnected.snapshot.canDisconnect, false);
assert.equal(disconnected.snapshot.hooks.state, "missing");
assert.equal(disconnected.snapshot.mcp.state, "missing");

const alreadyDisconnected = await disconnectCodexIntegration(disconnectOptions);
assert.equal(alreadyDisconnected.ok, true, "disconnect must be idempotent when OpenPets is already absent");
assert.equal(alreadyDisconnected.changed, false);
assert.equal(alreadyDisconnected.snapshot.state, "installable");
assert.equal(alreadyDisconnected.snapshot.canDisconnect, false);

process.stdout.write("Codex integration contract checks passed.\n");
