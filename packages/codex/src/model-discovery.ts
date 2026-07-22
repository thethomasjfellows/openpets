import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { createCodexChildEnvironment } from "./codex-child-environment.js";
import type {
  CodexModelDiscoveryOptions,
  CodexModelDiscoverySnapshot,
  CodexModelInfo,
  CodexReasoningEffortOption,
} from "./types.js";

const initializeRequestId = 1;
const modelListRequestId = 2;
const maxStdoutBytes = 512 * 1024;
const maxStderrBytes = 64 * 1024;

export async function discoverCodexModels(
  options: CodexModelDiscoveryOptions = {},
): Promise<CodexModelDiscoverySnapshot> {
  const checkedAt = (options.now ?? Date.now)();
  const command = options.codexCommand?.trim() || "codex";
  const timeoutMs = Math.min(30_000, Math.max(1_000, options.timeoutMs ?? 10_000));
  try {
    const raw = options.runAppServer
      ? await options.runAppServer(command, timeoutMs)
      : await runModelList(command, timeoutMs);
    return parseCodexModelListResponse(raw, checkedAt);
  } catch (error) {
    const message = cleanDiscoveryError(error);
    const notDetected = /unable to start|enoent|not found|cannot find/i.test(message);
    const unsupported = /method not found|model\/list|unsupported/i.test(message);
    return {
      checkedAt,
      status: notDetected ? "not_detected" : unsupported ? "unsupported" : "error",
      models: [],
      reason: message || "Codex model discovery failed.",
    };
  }
}

export function parseCodexModelListResponse(value: unknown, checkedAt = Date.now()): CodexModelDiscoverySnapshot {
  const root = asRecord(value);
  const result = asRecord(root?.result ?? value);
  if (!result || !Array.isArray(result.data)) {
    throw new Error("Codex model/list returned an invalid response.");
  }
  const models = result.data.flatMap((entry) => {
    const model = parseModel(entry);
    return model ? [model] : [];
  });
  if (models.length === 0) throw new Error("Codex model/list returned no selectable models.");
  const defaultModelId = models.find((model) => model.isDefault)?.id;
  return {
    checkedAt,
    status: "ready",
    models,
    ...(defaultModelId ? { defaultModelId } : {}),
  };
}

function parseModel(value: unknown): CodexModelInfo | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const id = boundedString(raw.id, 160);
  const model = boundedString(raw.model, 160) || id;
  if (!id || !model) return null;
  const efforts = Array.isArray(raw.supportedReasoningEfforts)
    ? raw.supportedReasoningEfforts.flatMap((entry) => {
      const effort = parseEffort(entry);
      return effort ? [effort] : [];
    })
    : [];
  const modalities = Array.isArray(raw.inputModalities)
    ? raw.inputModalities.map((entry) => boundedString(entry, 40)).filter(Boolean)
    : [];
  return {
    id,
    model,
    displayName: boundedString(raw.displayName, 160) || model,
    description: boundedString(raw.description, 500),
    hidden: raw.hidden === true,
    isDefault: raw.isDefault === true,
    inputModalities: modalities,
    defaultReasoningEffort: boundedString(raw.defaultReasoningEffort, 40),
    supportedReasoningEfforts: efforts,
  };
}

function parseEffort(value: unknown): CodexReasoningEffortOption | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const effort = boundedString(raw.reasoningEffort, 40);
  if (!effort) return null;
  return { value: effort, description: boundedString(raw.description, 240) };
}

function runModelList(command: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, ["app-server", "--stdio"], {
        env: createCodexChildEnvironment(process.env, command),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(new Error(`Unable to start Codex: ${cleanDiscoveryError(error)}`));
      return;
    }
    let stdoutBytes = 0;
    let stderr = "";
    let lineBuffer = "";
    let settled = false;
    let listRequested = false;
    const timer = setTimeout(() => finish(new Error("Codex model discovery timed out.")), timeoutMs);
    timer.unref?.();

    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && !child.killed) {
        try { child.kill("SIGTERM"); } catch { /* already stopped */ }
      }
      if (error) reject(error); else resolve(value);
    };
    const send = (message: unknown) => {
      try { child.stdin.write(`${JSON.stringify(message)}\n`); }
      catch (error) { finish(new Error(`Codex app-server input failed: ${cleanDiscoveryError(error)}`)); }
    };
    const handleMessage = (message: unknown) => {
      const raw = asRecord(message);
      if (!raw) return;
      if (raw.id === initializeRequestId) {
        if (raw.error) {
          finish(new Error(`Codex app-server initialization failed: ${protocolError(raw.error)}`));
          return;
        }
        if (!listRequested) {
          listRequested = true;
          send({ method: "model/list", id: modelListRequestId, params: { limit: 100, includeHidden: false } });
        }
        return;
      }
      if (raw.id !== modelListRequestId) return;
      if (raw.error) finish(new Error(`Codex model/list failed: ${protocolError(raw.error)}`));
      else finish(undefined, raw);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > maxStdoutBytes) {
        finish(new Error("Codex model discovery output exceeded the allowed size."));
        return;
      }
      lineBuffer += chunk;
      for (;;) {
        const newline = lineBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = lineBuffer.slice(0, newline).trim();
        lineBuffer = lineBuffer.slice(newline + 1);
        if (!line) continue;
        try { handleMessage(JSON.parse(line)); } catch { /* ignore unrelated diagnostics */ }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (Buffer.byteLength(stderr) < maxStderrBytes) stderr += chunk;
    });
    child.once("error", (error) => finish(new Error(`Unable to start Codex: ${cleanDiscoveryError(error)}`)));
    child.once("close", (status) => {
      if (settled) return;
      finish(new Error(cleanDiscoveryError(stderr) || `Codex app-server exited with status ${status}.`));
    });
    send({
      method: "initialize",
      id: initializeRequestId,
      params: {
        clientInfo: { name: "openpets", title: "OpenPets", version: "3.3.0" },
        capabilities: null,
      },
    });
  });
}

function protocolError(value: unknown): string {
  const raw = asRecord(value);
  return cleanDiscoveryError(raw?.message ?? "Unsupported Codex app-server response.");
}

function boundedString(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\0/g, "").trim().slice(0, max) : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanDiscoveryError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(?:[A-Za-z]:)?[\\/][^\s"']{2,}/g, "<path>")
    .replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/\b(api[_-]?key|secret|password|token)\s*[:=]\s*\S+/gi, "$1=<redacted>")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}
