import assert from "node:assert/strict";

import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resolveCodexModelInfo } from "../src/codex-model-selection.js";
import { buildCodexExecArgs, CodexConversationTarget, createCodexConversationEnvironment, createPrivateCodexWorkspace, parseCodexJsonLine } from "../src/voice-conversation-codex.js";
import { CodexCompanionTarget } from "../src/companion-target-codex.js";

assert.deepEqual(parseCodexJsonLine('{"type":"thread.started","thread_id":"thread-1"}'), { type: "session", sessionId: "thread-1" });
assert.deepEqual(parseCodexJsonLine('{"type":"item.completed","item":{"type":"agent_message","text":"Hello"}}'), { type: "text", text: "Hello", final: true });
assert.deepEqual(parseCodexJsonLine('{"type":"item.completed","item":{"type":"error","message":"safe warning"}}'), { type: "error", message: "safe warning" });
assert.equal(parseCodexJsonLine("not-json"), null);

const isolatedArgs = buildCodexExecArgs({ text: "hello", model: "gpt-test", reasoningEffort: "low" });
assert.ok(isolatedArgs.includes("--ignore-user-config"), "pet conversation must not inherit the user's Codex plugins, MCP servers, or instructions");
assert.deepEqual(isolatedArgs.slice(isolatedArgs.indexOf("--disable"), isolatedArgs.indexOf("--disable") + 2), ["--disable", "shell_tool"]);
assert.ok(isolatedArgs.includes("sandbox_mode=\"read-only\""));
const resumedArgs = buildCodexExecArgs({ text: "again", sessionId: "thread-1" });
assert.ok(resumedArgs.includes("--ignore-user-config"), "resumed pet turns keep the same isolation boundary");
assert.ok(resumedArgs.includes("--skip-git-repo-check"), "resumed pet turns can run from their empty private workspace");
const imageArgs = buildCodexExecArgs({ text: "describe this", imagePath: "/tmp/probe.png", ephemeral: true });
assert.deepEqual(
  imageArgs.slice(-2),
  ["--", "describe this"],
  "the variadic Codex --image option must not consume the Vision prompt as another file",
);

const isolatedEnvironment = createCodexConversationEnvironment({
  HOME: "/tmp/home",
  PATH: "/usr/bin",
  CODEX_HOME: "/tmp/codex",
  OPENAI_API_KEY: "must-not-leak",
  SCREENPIPE_TOKEN: "must-not-leak",
  MCP_SERVER_SECRET: "must-not-leak",
});
assert.equal(isolatedEnvironment.HOME, "/tmp/home");
assert.equal(isolatedEnvironment.CODEX_HOME, "/tmp/codex");
assert.equal(isolatedEnvironment.OPENAI_API_KEY, undefined, "Companion Codex must not inherit API-key environment variables");
assert.equal(isolatedEnvironment.SCREENPIPE_TOKEN, undefined, "Companion Codex must not inherit plugin environment variables");
assert.equal(isolatedEnvironment.MCP_SERVER_SECRET, undefined, "Companion Codex must not inherit MCP environment variables");
if (process.platform !== "win32") {
  const packagedGuiEnvironment = createCodexConversationEnvironment(
    { HOME: "/tmp/home", PATH: "/usr/bin:/bin" },
    "/opt/homebrew/bin/codex",
  );
  assert.equal(
    packagedGuiEnvironment.PATH,
    "/opt/homebrew/bin:/usr/bin:/bin",
    "an absolute Codex install makes its Node interpreter available to a packaged GUI app",
  );
}

const privateWorkspace = createPrivateCodexWorkspace();
assert.equal(readdirSync(privateWorkspace).length, 0, "pet conversations start in an empty workspace");
if (process.platform !== "win32") assert.equal(statSync(privateWorkspace).mode & 0o777, 0o700, "pet conversation workspace is private to the current user");
rmSync(privateWorkspace, { recursive: true, force: true });
assert.equal(existsSync(privateWorkspace), false);

const discoveredModel = { id: "catalog-id", model: "executable-model", displayName: "Test", description: "", hidden: false, isDefault: true, inputModalities: ["text"], defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ value: "medium", description: "" }] };
assert.equal(resolveCodexModelInfo({ checkedAt: 1, status: "ready", models: [discoveredModel], defaultModelId: "catalog-id" }, "catalog-id")?.model, "executable-model", "a saved discovery ID resolves to the executable Codex model name");

const requests: Array<{ sessionId?: string; text: string }> = [];
const target = new CodexConversationTarget({
  probe: async () => ({ version: "codex-cli 1.2.3", execHelp: "resume --json --ignore-user-config --disable", resumeHelp: "Usage [SESSION_ID] --json --ignore-user-config --disable" }),
  run: async (request) => {
    requests.push({ sessionId: request.sessionId, text: request.text });
    return { sessionId: request.sessionId ?? "thread-1", text: request.sessionId ? "Second" : "First" };
  },
});

const health = await target.health();
assert.equal(health.ready, true);
assert.equal(health.version, "codex-cli 1.2.3");
const first = await target.sendText({ text: "hello", signal: new AbortController().signal });
const second = await target.sendText({ text: "again", sessionId: first.sessionId, signal: new AbortController().signal });
assert.equal(second.text, "Second");
assert.deepEqual(requests, [{ sessionId: undefined, text: "hello" }, { sessionId: "thread-1", text: "again" }]);

const cliOnlyCompanion = new CodexCompanionTarget(target, async () => ({ state: "installable", detected: true, supported: true }));
assert.equal((await cliOnlyCompanion.health()).ready, true, "AI Brain uses the installed Codex CLI without requiring reaction hooks or MCP setup");
const missingCompanion = new CodexCompanionTarget(target, async () => ({ state: "not_detected", detected: false }));
const missingHealth = await missingCompanion.health();
assert.equal(missingHealth.ready, false);
assert.match(missingHealth.reason ?? "", /Install or connect Codex/);
const connectedCompanion = new CodexCompanionTarget(target, async () => ({ state: "connected" }));
assert.equal((await connectedCompanion.health()).ready, true);

const cancelled = new AbortController();
cancelled.abort();
await assert.rejects(() => target.sendText({ text: "cancelled", signal: cancelled.signal }), /cancelled/i);

let releaseModel!: (value: string) => void;
const cancelledBeforeSpawn = new CodexConversationTarget({
  command: "/definitely/not/a/codex/executable",
  probe: async () => ({ version: "fixture", execHelp: "resume --json --ignore-user-config --disable", resumeHelp: "Usage [SESSION_ID] --json --ignore-user-config --disable" }),
  getModel: () => new Promise<string>((resolve) => { releaseModel = resolve; }),
});
const midResolutionController = new AbortController();
const midResolutionTurn = cancelledBeforeSpawn.sendText({ text: "cancel during model lookup", signal: midResolutionController.signal });
await new Promise((resolve) => setTimeout(resolve, 0));
midResolutionController.abort();
releaseModel("");
await assert.rejects(midResolutionTurn, (error: unknown) => error instanceof Error && error.name === "AbortError", "a cancelled turn must not spawn Codex after async model resolution");
cancelledBeforeSpawn.dispose();

const eofFixtureRoot = createPrivateCodexWorkspace();
const eofFixture = join(eofFixtureRoot, "codex-eof-fixture.cjs");
writeFileSync(eofFixture, `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "eof-thread" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: input ? "unexpected input" : "stdin closed" } }) + "\\n");
});
`);
const eofTarget = new CodexConversationTarget({
  command: process.execPath,
  commandPrefixArgs: [eofFixture],
  probe: async () => ({ version: "fixture", execHelp: "resume --json --ignore-user-config --disable", resumeHelp: "Usage [SESSION_ID] --json --ignore-user-config --disable" }),
});
const eofResult = await eofTarget.sendText({ text: "hello", signal: new AbortController().signal });
assert.equal(eofResult.text, "stdin closed", "Codex receives EOF instead of waiting for additional prompt input");
eofTarget.dispose();
rmSync(eofFixtureRoot, { recursive: true, force: true });

const incompatible = new CodexConversationTarget({ probe: async () => ({ version: "old", execHelp: "exec", resumeHelp: "resume" }) });
assert.equal((await incompatible.health()).ready, false);

target.dispose();
incompatible.dispose();
console.log("Codex conversation target contract verified");
