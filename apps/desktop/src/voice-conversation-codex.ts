import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCodexChildEnvironment } from "@open-pets/codex";

import type { VoiceConversationEvent, VoiceConversationHealth, VoiceConversationRequest, VoiceConversationResult, VoiceConversationTarget } from "./voice-conversation-targets.js";

type CodexRun = (request: VoiceConversationRequest) => Promise<VoiceConversationResult>;
type CodexProbe = () => Promise<{ version: string; execHelp: string; resumeHelp: string }>;

const maxStdoutBytes = 2 * 1024 * 1024;
const maxStderrBytes = 64 * 1024;
const codexConversationIsolationArgs = [
  "--ignore-user-config",
  "--ignore-rules",
  "--disable", "shell_tool",
  "--disable", "shell_snapshot",
  "--disable", "tool_suggest",
  "--disable", "plugins",
  "--disable", "plugin_sharing",
  "--disable", "remote_plugin",
  "--config", "sandbox_mode=\"read-only\"",
] as const;

export class CodexConversationTarget implements VoiceConversationTarget {
  readonly id = "codex" as const;
  readonly #command: string;
  readonly #commandPrefixArgs: readonly string[];
  readonly #cwd: string;
  readonly #runOverride?: CodexRun;
  readonly #probeOverride?: CodexProbe;
  readonly #getModel: () => string | Promise<string>;
  readonly #getReasoningEffort: () => string | Promise<string>;
  readonly #ownsCwd: boolean;
  readonly #children = new Set<ChildProcessWithoutNullStreams>();
  #health: VoiceConversationHealth | null = null;

  constructor(options: { command?: string; commandPrefixArgs?: readonly string[]; cwd?: string; run?: CodexRun; probe?: CodexProbe; getModel?: () => string | Promise<string>; getReasoningEffort?: () => string | Promise<string> } = {}) {
    this.#command = options.command ?? "codex";
    this.#commandPrefixArgs = options.commandPrefixArgs ?? [];
    this.#cwd = options.cwd ?? createPrivateCodexWorkspace();
    this.#ownsCwd = options.cwd === undefined;
    this.#runOverride = options.run;
    this.#probeOverride = options.probe;
    this.#getModel = options.getModel ?? (() => "");
    this.#getReasoningEffort = options.getReasoningEffort ?? (() => "");
  }

  async health(force = false): Promise<VoiceConversationHealth> {
    if (!force && this.#health && Date.now() - this.#health.checkedAt < 30_000) return this.#health;
    try {
      const probe = this.#probeOverride ? await this.#probeOverride() : await this.#probe();
      const ready = /--json\b/.test(probe.execHelp)
        && /\bresume\b/.test(probe.execHelp)
        && /--ignore-user-config\b/.test(probe.execHelp)
        && /--disable\b/.test(probe.execHelp)
        && /\[SESSION_ID\]/.test(probe.resumeHelp)
        && /--json\b/.test(probe.resumeHelp)
        && /--ignore-user-config\b/.test(probe.resumeHelp)
        && /--disable\b/.test(probe.resumeHelp);
      this.#health = {
        targetId: "codex",
        checkedAt: Date.now(),
        ready,
        method: "codex --version and machine-readable exec/resume capability probe",
        version: probe.version.trim().slice(0, 120),
        reason: ready ? undefined : "This Codex CLI does not expose the required isolated JSON exec/resume contract. Update Codex and try again.",
      };
    } catch (error) {
      this.#health = { targetId: "codex", checkedAt: Date.now(), ready: false, method: "Codex CLI capability probe", reason: cleanError(error) };
    }
    return this.#health;
  }

  async sendText(request: VoiceConversationRequest): Promise<VoiceConversationResult> {
    const text = request.text.trim();
    if (!text || text.length > 8_000) throw new Error("Conversation text must contain 1–8000 characters.");
    if (request.signal.aborted) throw abortError();
    const health = await this.health();
    if (!health.ready) throw new Error(health.reason ?? "Codex CLI conversation is unavailable.");
    return this.#runOverride ? this.#runOverride({ ...request, text }) : this.#runCli({ ...request, text });
  }

  async analyzeImage(request: { readonly text: string; readonly imagePath: string; readonly signal: AbortSignal }): Promise<VoiceConversationResult> {
    const text = request.text.trim();
    if (!text || text.length > 8_000) throw new Error("Image analysis text must contain 1–8000 characters.");
    if (!request.imagePath) throw new Error("Image analysis requires a local image.");
    if (request.signal.aborted) throw abortError();
    const health = await this.health();
    if (!health.ready) throw new Error(health.reason ?? "Codex CLI image analysis is unavailable.");
    return this.#runCli({ text, signal: request.signal }, { imagePath: request.imagePath, ephemeral: true });
  }

  dispose(): void {
    for (const child of this.#children) terminateChild(child);
    this.#children.clear();
    if (this.#ownsCwd) rmSync(this.#cwd, { recursive: true, force: true });
  }

  async #probe(): Promise<{ version: string; execHelp: string; resumeHelp: string }> {
    const [version, execHelp, resumeHelp] = await Promise.all([
      this.#capture(["--version"], 5_000, 32 * 1024),
      this.#capture(["exec", "--help"], 5_000, 128 * 1024),
      this.#capture(["exec", "resume", "--help"], 5_000, 128 * 1024),
    ]);
    return { version, execHelp, resumeHelp };
  }

  #capture(args: string[], timeoutMs: number, limit: number): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return this.#spawnAndCollect(args, controller.signal, limit).finally(() => clearTimeout(timer));
  }

  async #runCli(request: VoiceConversationRequest, options: { readonly imagePath?: string; readonly ephemeral?: boolean } = {}): Promise<VoiceConversationResult> {
    const [model, reasoningEffort] = await Promise.all([this.#getModel(), this.#getReasoningEffort()]);
    if (request.signal.aborted) throw abortError();
    const args = buildCodexExecArgs({
      text: request.text,
      sessionId: request.sessionId,
      model,
      reasoningEffort,
      imagePath: options.imagePath,
      ephemeral: options.ephemeral,
    });
    const output = await this.#spawnAndCollect(args, request.signal, maxStdoutBytes, request.onEvent);
    let sessionId = request.sessionId ?? "";
    let finalText = "";
    let reportedError = "";
    for (const line of output.split(/\r?\n/)) {
      const event = parseCodexJsonLine(line);
      if (!event) continue;
      if (event.type === "session") sessionId = event.sessionId;
      else if (event.type === "text" && event.final) finalText = event.text;
      else if (event.type === "error") reportedError = event.message;
    }
    if (!sessionId) throw new Error("Codex did not return a conversation session ID.");
    if (!finalText.trim()) throw new Error(reportedError || "Codex did not return an assistant message.");
    return { sessionId, text: finalText.trim() };
  }

  #spawnAndCollect(args: string[], signal: AbortSignal, limit: number, onEvent?: (event: VoiceConversationEvent) => void): Promise<string> {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const child = spawn(this.#command, [...this.#commandPrefixArgs, ...args], {
        cwd: this.#cwd,
        env: createCodexConversationEnvironment(process.env, this.#command),
        shell: false,
        windowsHide: true,
      });
      // Codex accepts additional prompt content from stdin. The request is
      // already an argv item, so EOF must be delivered immediately or the CLI
      // waits indefinitely for more input.
      child.stdin.end();
      this.#children.add(child);
      let stdout = "";
      let stderr = "";
      let eventBuffer = "";
      let settled = false;
      const emitLines = (flush = false) => {
        if (!onEvent) return;
        const lines = eventBuffer.split(/\r?\n/);
        eventBuffer = flush ? "" : lines.pop() ?? "";
        for (const line of lines) {
          const event = parseCodexJsonLine(line);
          if (event) onEvent(event);
        }
        if (flush && eventBuffer.trim()) {
          const event = parseCodexJsonLine(eventBuffer);
          if (event) onEvent(event);
          eventBuffer = "";
        }
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        this.#children.delete(child);
        if (error) reject(error); else resolve(stdout);
      };
      const onAbort = () => { terminateChild(child); finish(abortError()); };
      signal.addEventListener("abort", onAbort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        eventBuffer += chunk;
        emitLines();
        if (Buffer.byteLength(stdout) > limit) { terminateChild(child); finish(new Error("Codex CLI output exceeded the allowed size.")); }
      });
      child.stderr.on("data", (chunk: string) => { if (Buffer.byteLength(stderr) < maxStderrBytes) stderr += chunk; });
      child.on("error", (error) => finish(new Error(`Unable to start Codex CLI: ${cleanError(error)}`)));
      child.on("close", (code) => {
        if (settled) return;
        emitLines(true);
        if (signal.aborted) finish(abortError());
        else if (code !== 0) finish(new Error(cleanError(stderr) || `Codex CLI exited with status ${code}.`));
        else finish();
      });
    });
  }
}

export function createCodexConversationEnvironment(source: Readonly<NodeJS.ProcessEnv>, command = "codex"): NodeJS.ProcessEnv {
  return createCodexChildEnvironment(source, command);
}

export function createPrivateCodexWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "openpets-codex-workspace-"));
  try { chmodSync(workspace, 0o700); } catch { /* best effort on platforms without POSIX modes */ }
  return workspace;
}

export function buildCodexExecArgs(options: {
  readonly text: string;
  readonly sessionId?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly imagePath?: string;
  readonly ephemeral?: boolean;
}): string[] {
  const model = options.model?.trim().slice(0, 120) ?? "";
  const modelArgs = model ? ["--model", model] : [];
  const effort = options.reasoningEffort?.trim().slice(0, 40) ?? "";
  const effortArgs = effort ? ["--config", `model_reasoning_effort=${JSON.stringify(effort)}`] : [];
  const imageArgs = options.imagePath ? ["--image", options.imagePath] : [];
  const ephemeralArgs = options.ephemeral ? ["--ephemeral"] : [];
  // `--image <FILE>...` is variadic in Codex. Without the option terminator,
  // Clap consumes the trailing prompt as a second image path and Codex falls
  // back to stdin, which this non-interactive target intentionally closes.
  const promptBoundary = options.imagePath ? ["--"] : [];
  return options.sessionId
    ? ["exec", "resume", "--json", "--skip-git-repo-check", ...codexConversationIsolationArgs, ...modelArgs, ...effortArgs, options.sessionId, options.text]
    : ["exec", "--json", "--skip-git-repo-check", ...codexConversationIsolationArgs, ...ephemeralArgs, ...modelArgs, ...effortArgs, ...imageArgs, ...promptBoundary, options.text];
}

export function parseCodexJsonLine(line: string): VoiceConversationEvent | null {
  if (!line.trim()) return null;
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!isRecord(value)) return null;
  if (value.type === "thread.started" && typeof value.thread_id === "string" && value.thread_id) return { type: "session", sessionId: value.thread_id };
  if (value.type !== "item.completed" || !isRecord(value.item)) return null;
  if (value.item.type === "agent_message" && typeof value.item.text === "string") return { type: "text", text: value.item.text, final: true };
  if (value.item.type === "error" && typeof value.item.message === "string") return { type: "error", message: cleanError(value.item.message) };
  return null;
}

function terminateChild(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.killed) return;
  try { child.kill("SIGTERM"); } catch { return; }
  const timer = setTimeout(() => { if (child.exitCode === null) { try { child.kill("SIGKILL"); } catch { /* already stopped */ } } }, 1_500);
  timer.unref?.();
}

function abortError(): Error {
  const error = new Error("Codex conversation was cancelled.");
  error.name = "AbortError";
  return error;
}

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/https?:\/\/[^\s]+/gi, "endpoint").replace(/[A-Za-z0-9+/=_-]{48,}/g, "[redacted]").trim().slice(0, 300);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
