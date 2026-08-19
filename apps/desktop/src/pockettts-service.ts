import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

import { info, warn } from "./logger.js";
import {
  getPocketTtsSettings,
  managedPocketTtsVersion,
  updatePocketTtsSettings,
} from "./pockettts-settings.js";
import type { VoiceInfo } from "./voice-provider.js";

export type PocketTtsStatus = "not-installed" | "uv-missing" | "installing" | "starting" | "warming" | "ready" | "stopped" | "error";

export type PocketTtsSnapshot = {
  readonly enabled: boolean;
  readonly status: PocketTtsStatus;
  readonly packageVersion: typeof managedPocketTtsVersion;
  readonly baseUrl: "http://127.0.0.1:8000";
  readonly host: "127.0.0.1";
  readonly port: 8000;
  readonly uvCommand?: string;
  readonly pid?: number;
  readonly progress?: string;
  readonly error?: string;
  readonly voices: readonly VoiceInfo[];
};

type ManagedProcess = ChildProcessByStdio<null, Readable, Readable>;
type LocalServiceProbe = "absent" | "pockettts" | "occupied";

const baseUrl = "http://127.0.0.1:8000" as const;
const startupTimeoutMs = 15 * 60_000;
const stopGraceMs = 1_200;
const maxProgressLength = 240;

export const pocketTtsBuiltInVoices: readonly VoiceInfo[] = [
  { id: "alba", label: "Alba", language: "English" },
  { id: "anna", label: "Anna", language: "English" },
  { id: "azelma", label: "Azelma", language: "English" },
  { id: "bill_boerst", label: "Bill Boerst", language: "English" },
  { id: "caro_davy", label: "Caro Davy", language: "English" },
  { id: "charles", label: "Charles", language: "English" },
  { id: "cosette", label: "Cosette", language: "English" },
  { id: "eponine", label: "Eponine", language: "English" },
  { id: "eve", label: "Eve", language: "English" },
  { id: "fantine", label: "Fantine", language: "English" },
  { id: "george", label: "George", language: "English" },
  { id: "jane", label: "Jane", language: "English" },
  { id: "jean", label: "Jean", language: "English" },
  { id: "javert", label: "Javert", language: "English" },
  { id: "marius", label: "Marius", language: "English" },
  { id: "mary", label: "Mary", language: "English" },
  { id: "michael", label: "Michael", language: "English" },
  { id: "paul", label: "Paul", language: "English" },
  { id: "peter_yearsley", label: "Peter Yearsley", language: "English" },
  { id: "stuart_bell", label: "Stuart Bell", language: "English" },
  { id: "vera", label: "Vera", language: "English" },
];

export class PocketTtsService {
  #status: PocketTtsStatus;
  #progress: string | undefined;
  #error: string | undefined;
  #process: ManagedProcess | null = null;
  #operation: Promise<PocketTtsSnapshot> | null = null;
  #uvCommand: string | undefined;
  #stopping = false;

  constructor() {
    const settings = getPocketTtsSettings();
    this.#status = settings.installedAt ? "stopped" : "not-installed";
    this.#uvCommand = findUvxCommand();
    if (!this.#uvCommand) this.#status = "uv-missing";
  }

  snapshot(): PocketTtsSnapshot {
    const settings = getPocketTtsSettings();
    return {
      enabled: settings.enabled,
      status: this.#status,
      packageVersion: managedPocketTtsVersion,
      baseUrl,
      host: "127.0.0.1",
      port: 8000,
      ...(this.#uvCommand ? { uvCommand: basename(this.#uvCommand) } : {}),
      ...(this.#process?.pid ? { pid: this.#process.pid } : {}),
      ...(this.#progress ? { progress: this.#progress } : {}),
      ...(this.#error ? { error: this.#error } : {}),
      voices: pocketTtsBuiltInVoices,
    };
  }

  listVoices(): readonly VoiceInfo[] {
    return pocketTtsBuiltInVoices;
  }

  installAndEnable(voiceId = "alba"): Promise<PocketTtsSnapshot> {
    return this.#runOperation(async () => {
      this.#uvCommand = findUvxCommand();
      if (!this.#uvCommand) return this.#fail("PocketTTS needs uv. Install uv, then try again.", "uv-missing");
      this.#status = "installing";
      this.#progress = "Downloading PocketTTS and its local speech model. The first setup can take several minutes.";
      this.#error = undefined;
      const snapshot = await this.#startProcess({ allowNetwork: true, voiceId });
      if (snapshot.status !== "ready") return snapshot;
      updatePocketTtsSettings({ enabled: true, installedAt: Date.now() });
      info("app", "PocketTTS installed and enabled", { version: managedPocketTtsVersion, port: 8000 });
      return this.snapshot();
    });
  }

  start(voiceId = "alba"): Promise<PocketTtsSnapshot> {
    return this.#runOperation(async () => {
      const settings = getPocketTtsSettings();
      if (!settings.installedAt) return this.#fail("Download PocketTTS before starting it.", "not-installed");
      this.#uvCommand = findUvxCommand();
      if (!this.#uvCommand) return this.#fail("PocketTTS needs uv. Install uv, then try again.", "uv-missing");
      const snapshot = await this.#startProcess({ allowNetwork: false, voiceId });
      if (snapshot.status === "ready") updatePocketTtsSettings({ enabled: true });
      return this.snapshot();
    });
  }

  async stop(): Promise<PocketTtsSnapshot> {
    return this.#stopProcess(true);
  }

  async #stopProcess(disable: boolean): Promise<PocketTtsSnapshot> {
    this.#stopping = true;
    const child = this.#process;
    this.#process = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, stopGraceMs)),
      ]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    this.#stopping = false;
    if (disable) updatePocketTtsSettings({ enabled: false });
    this.#status = getPocketTtsSettings().installedAt ? "stopped" : "not-installed";
    this.#progress = "PocketTTS is stopped.";
    this.#error = undefined;
    info("app", "PocketTTS stopped");
    return this.snapshot();
  }

  async autoStart(voiceId = "alba"): Promise<PocketTtsSnapshot> {
    if (!getPocketTtsSettings().enabled) return this.snapshot();
    return this.start(voiceId);
  }

  async shutdown(): Promise<void> {
    await this.#stopProcess(false).catch(() => undefined);
  }

  #runOperation(operation: () => Promise<PocketTtsSnapshot>): Promise<PocketTtsSnapshot> {
    if (this.#operation) return this.#operation;
    const running = operation();
    this.#operation = running;
    void running.finally(() => { if (this.#operation === running) this.#operation = null; }).catch(() => undefined);
    return running;
  }

  async #startProcess(input: { allowNetwork: boolean; voiceId: string }): Promise<PocketTtsSnapshot> {
    if (this.#process && this.#process.exitCode === null && this.#process.signalCode === null) {
      const probe = await probeServer();
      if (probe === "pockettts") {
        this.#status = "ready";
        this.#progress = "PocketTTS is ready.";
        return this.snapshot();
      }
      await this.#stopProcess(false);
    }
    const existingService = await probeServer();
    if (existingService === "pockettts") {
      this.#status = "ready";
      this.#progress = "A PocketTTS service is already running on this computer.";
      this.#error = undefined;
      return this.snapshot();
    }
    if (existingService === "occupied") {
      return this.#fail("PocketTTS cannot start because another app is using local port 8000. Close that app, then try again.");
    }

    const uvx = this.#uvCommand;
    if (!uvx) return this.#fail("PocketTTS needs uv. Install uv, then try again.", "uv-missing");
    const args = [
      ...(input.allowNetwork ? [] : ["--offline"]),
      "--from", `pocket-tts==${managedPocketTtsVersion}`,
      "pocket-tts", "serve", "--host", "127.0.0.1", "--port", "8000",
    ];
    this.#status = input.allowNetwork ? "installing" : "starting";
    this.#progress = input.allowNetwork ? this.#progress : "Starting PocketTTS locally.";
    this.#error = undefined;
    let child: ManagedProcess;
    try {
      child = spawn(uvx, args, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONUNBUFFERED: "1", UV_NO_PROGRESS: "1" },
      });
    } catch (error) {
      return this.#fail(cleanError(error));
    }
    this.#process = child;
    this.#observeOutput(child.stdout, "PocketTTS is preparing the local speech model.");
    this.#observeOutput(child.stderr, "PocketTTS is preparing the local speech model.");
    child.once("exit", (code) => {
      if (this.#process === child) this.#process = null;
      if (this.#stopping) return;
      if (this.#status !== "ready") this.#fail(`PocketTTS stopped before it became ready${code === null ? "." : ` (exit ${code}).`}`);
      else {
        this.#status = "error";
        this.#error = "PocketTTS stopped unexpectedly. Start it again.";
        warn("app", "PocketTTS process exited", { code });
      }
    });

    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
      if (this.#process !== child || child.exitCode !== null || child.signalCode !== null) return this.snapshot();
      const probe = await probeServer();
      if (probe === "occupied") {
        await this.#stopProcess(false);
        return this.#fail("PocketTTS cannot start because another app is using local port 8000. Close that app, then try again.");
      }
      if (probe === "pockettts") {
        this.#status = "warming";
        this.#progress = "Warming the selected PocketTTS voice.";
        try {
          await warmServer(input.voiceId);
          this.#status = "ready";
          this.#progress = "PocketTTS is ready.";
          this.#error = undefined;
          return this.snapshot();
        } catch (error) {
          await this.#stopProcess(false);
          return this.#fail(`PocketTTS started but could not warm the voice: ${cleanError(error)}`);
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    }
    await this.#stopProcess(false);
    return this.#fail("PocketTTS setup timed out. Check your connection and try again.");
  }

  #observeOutput(stream: NodeJS.ReadableStream, fallback: string): void {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    stream.on("data", (chunk: Buffer | string) => {
      pending += decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const safe = sanitizeProgress(line);
        if (safe) this.#progress = safe || fallback;
      }
    });
  }

  #fail(message: string, status: PocketTtsStatus = "error"): PocketTtsSnapshot {
    this.#status = status;
    this.#error = message.slice(0, maxProgressLength);
    this.#progress = undefined;
    warn("app", "PocketTTS unavailable", { status, reason: this.#error });
    return this.snapshot();
  }
}

async function probeServer(): Promise<LocalServiceProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/openapi.json`, { signal: controller.signal, redirect: "error" });
  } catch {
    return "absent";
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) return "occupied";
  try {
    const document = await response.json() as {
      readonly info?: { readonly title?: unknown };
      readonly paths?: Record<string, unknown>;
    };
    return document.info?.title === "Kyutai Pocket TTS API" && document.paths?.["/tts"]
      ? "pockettts"
      : "occupied";
  } catch {
    return "occupied";
  }
}

async function warmServer(voiceId: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3 * 60_000);
  try {
    const form = new FormData();
    form.set("text", "Hello from OpenPets.");
    form.set("voice_url", pocketTtsBuiltInVoices.some((voice) => voice.id === voiceId) ? voiceId : "alba");
    const response = await fetch(`${baseUrl}/tts`, { method: "POST", body: form, signal: controller.signal, redirect: "error" });
    if (!response.ok) throw new Error(`server returned HTTP ${response.status}`);
    await response.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }
}

function findUvxCommand(): string | undefined {
  const executable = process.platform === "win32" ? "uvx.exe" : "uvx";
  const candidates = [
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, executable)),
    join(homedir(), ".local", "bin", executable),
    join(homedir(), ".cargo", "bin", executable),
    ...(process.platform === "darwin" ? [join("/opt/homebrew/bin", executable), join("/usr/local/bin", executable)] : []),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function sanitizeProgress(value: string): string {
  const clean = value
    .replace(/https?:\/\/\S+/gi, "PocketTTS service")
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s/\\]+[\/\\])+[^\s]+/g, "local cache")
    .replace(/[A-Za-z0-9+/=_-]{40,}/g, "[redacted]")
    .trim();
  return clean.slice(0, maxProgressLength);
}

function cleanError(error: unknown): string {
  return sanitizeProgress(error instanceof Error ? error.message : String(error)) || "PocketTTS could not start.";
}

let singleton: PocketTtsService | null = null;

export function initializePocketTtsService(): PocketTtsService {
  if (singleton) return singleton;
  singleton = new PocketTtsService();
  return singleton;
}

export function getPocketTtsService(): PocketTtsService | null {
  return singleton;
}

export async function shutdownPocketTtsService(): Promise<void> {
  const service = singleton;
  singleton = null;
  await service?.shutdown();
}
