import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { createOpenPetsClient, type OpenPetsReaction } from "@open-pets/client";

import type { CodexLifecycleEvent } from "./types.js";

const maxHookInputBytes = 64 * 1024;
const reactionCooldownMs = 2_500;

interface HookDecision {
  readonly lifecycle: CodexLifecycleEvent;
  readonly reaction: OpenPetsReaction;
}

export async function runCodexHookFromStdin(
  input: NodeJS.ReadableStream = process.stdin,
  now: () => number = Date.now,
): Promise<void> {
  const source = await readBoundedStdin(input);
  let payload: unknown;
  try {
    payload = JSON.parse(source);
  } catch {
    return;
  }
  const decision = classifyCodexHookPayload(payload);
  if (!decision) return;
  const occurredAt = now();
  const client = createOpenPetsClient();
  let reactionEnabled = false;
  try {
    const result = await client.recordIntegrationEvent?.({
      integrationId: "codex",
      lifecycle: decision.lifecycle,
      occurredAt,
    });
    reactionEnabled = result?.reactionEnabled === true;
  } catch {
    // Hooks must never block Codex when OpenPets is closed or outdated.
  }
  if (!reactionEnabled) return;
  if (!(await shouldEmitReaction(decision.lifecycle, occurredAt))) return;
  try {
    await client.react(decision.reaction);
  } catch {
    // Hooks must never block Codex when OpenPets is closed.
  }
}

export function classifyCodexHookPayload(value: unknown): HookDecision | undefined {
  if (!isRecord(value) || typeof value.hook_event_name !== "string") return undefined;
  switch (value.hook_event_name) {
    case "UserPromptSubmit":
      return { lifecycle: "thinking", reaction: "thinking" };
    case "PermissionRequest":
      return { lifecycle: "waiting", reaction: "waiting" };
    case "PreToolUse":
      return classifyTool(value.tool_name, value.tool_input);
    case "PostToolUse":
      return { lifecycle: "working", reaction: "working" };
    case "SubagentStop":
    case "Stop":
      return classifyStop(value);
    default:
      return undefined;
  }
}

function classifyTool(toolName: unknown, toolInput: unknown): HookDecision {
  const tool = typeof toolName === "string" ? toolName.toLowerCase() : "";
  if (/(edit|write|apply_patch|multiedit|notebookedit)/.test(tool)) {
    return { lifecycle: "editing", reaction: "editing" };
  }
  const command =
    isRecord(toolInput) && typeof toolInput.command === "string"
      ? toolInput.command.slice(0, 1_000).toLowerCase()
      : "";
  if (/(test|vitest|jest|pytest|cargo test|go test|pnpm check|npm test)/.test(command)) {
    return { lifecycle: "testing", reaction: "testing" };
  }
  return { lifecycle: "working", reaction: "working" };
}

function classifyStop(value: Record<string, unknown>): HookDecision {
  const failed =
    value.failed === true ||
    value.success === false ||
    typeof value.error === "string" ||
    (typeof value.status === "string" && /fail|error/i.test(value.status));
  return failed
    ? { lifecycle: "error", reaction: "error" }
    : { lifecycle: "success", reaction: "success" };
}

async function shouldEmitReaction(lifecycle: CodexLifecycleEvent, now: number): Promise<boolean> {
  const path = getThrottlePath();
  let state: { lifecycle?: string; at?: number } = {};
  try {
    state = JSON.parse(await readFile(path, "utf8")) as { lifecycle?: string; at?: number };
  } catch {
    // Missing or corrupt throttle state is equivalent to no previous event.
  }
  if (
    state.lifecycle === lifecycle &&
    typeof state.at === "number" &&
    now - state.at < reactionCooldownMs
  ) {
    return false;
  }
  const temp = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(temp, JSON.stringify({ lifecycle, at: now }), {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    await rename(temp, path);
  } catch {
    await rm(temp, { force: true });
  }
  return true;
}

function getThrottlePath(): string {
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || homedir(), "OpenPets", "codex-hook-throttle.json");
  }
  return join(
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
    "openpets",
    "codex-hook-throttle.json",
  );
}

async function readBoundedStdin(input: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > maxHookInputBytes) return "";
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
