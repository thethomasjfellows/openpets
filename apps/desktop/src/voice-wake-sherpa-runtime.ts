import { spawn } from "node:child_process";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import {
  normalizeVoiceWakePhrase,
  sanitizeVoiceWakeMessage,
  voiceWakeProtocolVersion,
  type VoiceWakeHelperEvent,
} from "./voice-wake-helper-protocol.js";
import {
  maxVoiceWakeHelperEventLineBytes,
  parseVoiceWakeHelperEventLine,
  serializeVoiceWakeHelperCommand,
} from "./voice-wake-helper-wire.js";
import {
  UnavailableVoiceWakeRuntime,
  type VoiceWakeRuntime,
  type VoiceWakeRuntimeHealth,
  type VoiceWakeRuntimeStartConfig,
  type VoiceWakeRuntimeSession,
} from "./voice-wake-runtime.js";
import {
  validateSherpaVoiceWakeBundle,
  type ValidatedSherpaVoiceWakeBundle,
} from "./voice-wake-sherpa-manifest.js";
import type { VoicePcmFrame } from "./voice-wake-types.js";

export type VoiceWakeHelperProcess = {
  write(data: string): boolean;
  end(): void;
  kill(): void;
  onDrain(listener: () => void): () => void;
  onStdoutData(listener: (chunk: Uint8Array | string) => void): () => void;
  onStderrData(listener: (chunk: Uint8Array | string) => void): () => void;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
};

export type VoiceWakeHelperSpawnConfig = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
};

export type VoiceWakeHelperSpawner = (config: VoiceWakeHelperSpawnConfig) => VoiceWakeHelperProcess;
export type VoiceWakeRuntimeLog = (
  level: "debug" | "info" | "warn",
  message: string,
  fields?: Record<string, unknown>,
) => void;

export type SherpaOnnxVoiceWakeRuntimeOptions = {
  readonly bundleRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
  readonly spawnHelper?: VoiceWakeHelperSpawner;
  readonly log?: VoiceWakeRuntimeLog;
  readonly readyTimeoutMs?: number;
  readonly backpressureTimeoutMs?: number;
  readonly stopGraceMs?: number;
  readonly configureMode?: "kws-vad" | "vad-only";
};

type SessionOptions = {
  readonly bundle: ValidatedSherpaVoiceWakeBundle;
  readonly process: VoiceWakeHelperProcess;
  readonly log: VoiceWakeRuntimeLog;
  readonly readyTimeoutMs: number;
  readonly backpressureTimeoutMs: number;
  readonly stopGraceMs: number;
  readonly onFailure: (reason: string) => void;
  readonly onStopped: () => void;
};

const defaultReadyTimeoutMs = 10_000;
const defaultBackpressureTimeoutMs = 5_000;
const defaultStopGraceMs = 500;
const maxStdoutChunkBytes = 64 * 1024;

export function createSherpaOnnxVoiceWakeRuntime(
  options: SherpaOnnxVoiceWakeRuntimeOptions,
): VoiceWakeRuntime {
  const validation = validateSherpaVoiceWakeBundle({
    rootDir: options.bundleRoot,
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.arch ? { arch: options.arch } : {}),
  });
  if (!validation.ok) {
    return new UnavailableVoiceWakeRuntime("Wake word is not available: " + validation.reason);
  }
  return new SherpaOnnxVoiceWakeRuntime(validation.bundle, {
    spawnHelper: options.spawnHelper ?? spawnVoiceWakeHelper,
    log: options.log ?? (() => undefined),
    readyTimeoutMs: boundedDuration(options.readyTimeoutMs, defaultReadyTimeoutMs),
    backpressureTimeoutMs: boundedDuration(options.backpressureTimeoutMs, defaultBackpressureTimeoutMs),
    stopGraceMs: boundedDuration(options.stopGraceMs, defaultStopGraceMs),
    configureMode: options.configureMode ?? "kws-vad",
  });
}

export function createSherpaVadVoiceWakeRuntime(
  options: SherpaOnnxVoiceWakeRuntimeOptions,
): VoiceWakeRuntime {
  return createSherpaOnnxVoiceWakeRuntime({ ...options, configureMode: "vad-only" });
}

export function createProductionVoiceWakeRuntime(options: {
  readonly resourcesPath?: string;
  readonly spawnHelper?: VoiceWakeHelperSpawner;
  readonly log?: VoiceWakeRuntimeLog;
} = {}): VoiceWakeRuntime {
  const resourcesPath = options.resourcesPath
    ?? (process as NodeJS.Process & { readonly resourcesPath?: string }).resourcesPath;
  if (!resourcesPath) {
    return new UnavailableVoiceWakeRuntime("Wake word is not available: the packaged resource directory is missing.");
  }
  return createSherpaOnnxVoiceWakeRuntime({
    bundleRoot: join(resourcesPath, "voice-wake", "sherpa-onnx"),
    ...(options.spawnHelper ? { spawnHelper: options.spawnHelper } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
}

export class SherpaOnnxVoiceWakeRuntime implements VoiceWakeRuntime {
  readonly #bundle: ValidatedSherpaVoiceWakeBundle;
  readonly #spawnHelper: VoiceWakeHelperSpawner;
  readonly #log: VoiceWakeRuntimeLog;
  readonly #readyTimeoutMs: number;
  readonly #backpressureTimeoutMs: number;
  readonly #stopGraceMs: number;
  readonly #configureMode: "kws-vad" | "vad-only";
  #activeSession: SherpaOnnxVoiceWakeRuntimeSession | null = null;
  #lastFailure: string | undefined;
  #disposed = false;

  constructor(
    bundle: ValidatedSherpaVoiceWakeBundle,
    options: {
      readonly spawnHelper: VoiceWakeHelperSpawner;
      readonly log: VoiceWakeRuntimeLog;
      readonly readyTimeoutMs: number;
      readonly backpressureTimeoutMs: number;
      readonly stopGraceMs: number;
      readonly configureMode: "kws-vad" | "vad-only";
    },
  ) {
    this.#bundle = bundle;
    this.#spawnHelper = options.spawnHelper;
    this.#log = options.log;
    this.#readyTimeoutMs = options.readyTimeoutMs;
    this.#backpressureTimeoutMs = options.backpressureTimeoutMs;
    this.#stopGraceMs = options.stopGraceMs;
    this.#configureMode = options.configureMode;
  }

  health(): VoiceWakeRuntimeHealth {
    if (this.#disposed) {
      return {
        ready: false,
        method: "sherpa-onnx",
        reason: "The wake runtime is shut down.",
        version: this.#bundle.bundleVersion,
        modelId: this.#bundle.modelId,
      };
    }
    if (this.#lastFailure) {
      return {
        ready: false,
        method: "sherpa-onnx",
        reason: this.#lastFailure,
        version: this.#bundle.bundleVersion,
        modelId: this.#bundle.modelId,
      };
    }
    return {
      ready: true,
      method: "sherpa-onnx",
      version: this.#bundle.bundleVersion,
      modelId: this.#bundle.modelId,
    };
  }

  async start(config: VoiceWakeRuntimeStartConfig): Promise<VoiceWakeRuntimeSession> {
    if (this.#disposed) throw new Error("The wake runtime is shut down.");
    if (this.#lastFailure) throw new Error(this.#lastFailure);
    if (this.#activeSession) throw new Error("A wake helper session is already active.");
    if (this.#configureMode === "kws-vad" && config.engine !== "custom-sherpa") {
      throw new Error("Sherpa keyword spotting is only available for custom wake phrases.");
    }
    const phrase = normalizeVoiceWakePhrase(config.phrase);
    if (!phrase) throw new Error("A wake phrase is required.");
    if (config.signal.aborted) throw abortError();

    let helperProcess: VoiceWakeHelperProcess;
    try {
      helperProcess = this.#spawnHelper(createSpawnConfig(this.#bundle));
    } catch (error) {
      const reason = runtimeFailure("The wake helper could not start.", error);
      this.#lastFailure = reason;
      throw new Error(reason);
    }

    let session!: SherpaOnnxVoiceWakeRuntimeSession;
    session = new SherpaOnnxVoiceWakeRuntimeSession({
      bundle: this.#bundle,
      process: helperProcess,
      log: this.#log,
      readyTimeoutMs: this.#readyTimeoutMs,
      backpressureTimeoutMs: this.#backpressureTimeoutMs,
      stopGraceMs: this.#stopGraceMs,
      onFailure: (reason) => { this.#lastFailure = reason; },
      onStopped: () => {
        if (this.#activeSession === session) this.#activeSession = null;
      },
    });
    this.#activeSession = session;
    try {
      await session.waitUntilReady(
        phrase,
        config.engine === "custom-sherpa" ? config.variants ?? [] : [],
        config.signal,
        this.#configureMode,
      );
      return session;
    } catch (error) {
      if (this.#activeSession === session) this.#activeSession = null;
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#activeSession?.stop();
    this.#activeSession = null;
  }
}

class SherpaOnnxVoiceWakeRuntimeSession implements VoiceWakeRuntimeSession {
  readonly #bundle: ValidatedSherpaVoiceWakeBundle;
  readonly #process: VoiceWakeHelperProcess;
  readonly #log: VoiceWakeRuntimeLog;
  readonly #readyTimeoutMs: number;
  readonly #backpressureTimeoutMs: number;
  readonly #stopGraceMs: number;
  readonly #onFailure: (reason: string) => void;
  readonly #onStopped: () => void;
  readonly #listeners = new Set<(event: VoiceWakeHelperEvent) => void>();
  readonly #decoder = new StringDecoder("utf8");
  readonly #unsubscribers: Array<() => void> = [];
  readonly #exitWaiters = new Set<() => void>();
  #stdoutBuffer = "";
  #ready = false;
  #readyResolve: (() => void) | null = null;
  #readyReject: ((error: Error) => void) | null = null;
  #readyTimer: NodeJS.Timeout | null = null;
  #abortSignal: AbortSignal | null = null;
  #abortListener: (() => void) | null = null;
  #backpressureTimer: NodeJS.Timeout | null = null;
  #pcmBackpressured = false;
  #terminalError: Extract<VoiceWakeHelperEvent, { readonly type: "error" }> | null = null;
  #stopPromise: Promise<void> | null = null;
  #stopping = false;
  #stopped = false;
  #exited = false;
  #finalized = false;

  constructor(options: SessionOptions) {
    this.#bundle = options.bundle;
    this.#process = options.process;
    this.#log = options.log;
    this.#readyTimeoutMs = options.readyTimeoutMs;
    this.#backpressureTimeoutMs = options.backpressureTimeoutMs;
    this.#stopGraceMs = options.stopGraceMs;
    this.#onFailure = options.onFailure;
    this.#onStopped = options.onStopped;
    this.#unsubscribers.push(
      this.#process.onStdoutData((chunk) => this.#handleStdout(chunk)),
      this.#process.onStderrData((chunk) => this.#handleStderr(chunk)),
      this.#process.onDrain(() => this.#handleDrain()),
      this.#process.onExit(() => this.#handleExit()),
      this.#process.onError((error) => this.#fail("The wake helper process failed.", error)),
    );
  }

  waitUntilReady(phrase: string, variants: readonly string[], signal: AbortSignal, mode: "kws-vad" | "vad-only"): Promise<void> {
    if (this.#ready) return Promise.resolve();
    if (this.#stopped) return Promise.reject(this.#terminalError
      ? new Error(this.#terminalError.message)
      : new Error("The wake helper stopped before it became ready."));
    return new Promise<void>((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
      this.#abortSignal = signal;
      this.#abortListener = () => this.#failWithAbort();
      signal.addEventListener("abort", this.#abortListener, { once: true });
      this.#readyTimer = setTimeout(() => {
        this.#fail("The wake helper did not become ready in time.");
      }, this.#readyTimeoutMs);
      this.#readyTimer.unref?.();
      if (signal.aborted) {
        this.#failWithAbort();
        return;
      }
      try {
        this.#process.write(serializeVoiceWakeHelperCommand({
          version: 2,
          type: "configure",
          mode,
          phrase,
          variants,
        }));
      } catch (error) {
        this.#fail("The wake helper could not be configured.", error);
      }
    });
  }

  sendFrame(frame: VoicePcmFrame): void {
    if (this.#stopped || !this.#ready || this.#pcmBackpressured) return;
    const line = serializeVoiceWakeHelperCommand({ version: 2, type: "pcm", frame });
    try {
      if (!this.#process.write(line)) {
        this.#pcmBackpressured = true;
        this.#emit({
          version: 2,
          type: "log",
          level: "warn",
          message: "Wake helper input is backpressured; PCM frames will be dropped.",
        });
        this.#backpressureTimer = setTimeout(() => {
          this.#fail("Wake helper input remained backpressured.");
        }, this.#backpressureTimeoutMs);
        this.#backpressureTimer.unref?.();
      }
    } catch (error) {
      this.#fail("The wake helper input stream failed.", error);
      throw new Error(runtimeFailure("The wake helper input stream failed.", error));
    }
  }

  reset(): void {
    if (this.#stopped || !this.#ready) return;
    try {
      this.#process.write(serializeVoiceWakeHelperCommand({ version: 2, type: "reset" }));
    } catch (error) {
      this.#fail("The wake helper reset failed.", error);
    }
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopPromise = this.#stopGracefully();
    return this.#stopPromise;
  }

  onEvent(listener: (event: VoiceWakeHelperEvent) => void): () => void {
    if (this.#terminalError) {
      const event = this.#terminalError;
      queueMicrotask(() => {
        try { listener(event); } catch { /* listener isolation */ }
      });
      return () => undefined;
    }
    if (this.#stopped) return () => undefined;
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  async #stopGracefully(): Promise<void> {
    if (this.#stopped) {
      this.#finalize();
      return;
    }
    this.#stopping = true;
    if (!this.#ready && this.#readyReject) {
      const reject = this.#readyReject;
      this.#readyResolve = null;
      this.#readyReject = null;
      reject(new Error("The wake helper stopped before it became ready."));
    }
    this.#clearTransientState();
    try {
      if (!this.#exited) {
        this.#process.write(serializeVoiceWakeHelperCommand({ version: 2, type: "stop" }));
        this.#process.end();
        await Promise.race([
          this.#waitForExit(),
          delay(this.#stopGraceMs),
        ]);
        if (!this.#exited) this.#process.kill();
      }
    } catch {
      try { this.#process.kill(); } catch { /* best-effort teardown */ }
    }
    this.#stopped = true;
    this.#finalize();
  }

  #handleStdout(chunk: Uint8Array | string): void {
    if (this.#stopped) return;
    const chunkBytes = typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.byteLength;
    if (chunkBytes > maxStdoutChunkBytes) {
      this.#fail("The wake helper produced an oversized output chunk.");
      return;
    }
    this.#stdoutBuffer += typeof chunk === "string"
      ? chunk
      : this.#decoder.write(Buffer.from(chunk));
    while (true) {
      const newline = this.#stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.#stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > maxVoiceWakeHelperEventLineBytes) {
        this.#fail("The wake helper produced an oversized event.");
        return;
      }
      const event = parseVoiceWakeHelperEventLine(line);
      if (!event) {
        this.#fail("The wake helper produced an invalid event.");
        return;
      }
      this.#handleEvent(event);
      if (this.#stopped) return;
    }
    if (Buffer.byteLength(this.#stdoutBuffer, "utf8") > maxVoiceWakeHelperEventLineBytes) {
      this.#fail("The wake helper produced an oversized event.");
    }
  }

  #handleStderr(chunk: Uint8Array | string): void {
    if (this.#stopped) return;
    const value = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    const message = sanitizeVoiceWakeMessage(value);
    if (message) this.#log("warn", "wake helper diagnostic", { message });
  }

  #handleEvent(event: VoiceWakeHelperEvent): void {
    if (event.type === "ready") {
      if (this.#ready) {
        this.#fail("The wake helper reported readiness more than once.");
        return;
      }
      this.#ready = true;
      this.#clearReadyState();
      this.#readyResolve?.();
      this.#readyResolve = null;
      this.#readyReject = null;
      this.#log("info", "wake helper ready", {
        bundleId: this.#bundle.bundleId,
        bundleVersion: this.#bundle.bundleVersion,
        modelId: this.#bundle.modelId,
      });
      return;
    }
    if (event.type === "log") {
      this.#log(event.level, "wake helper", { message: event.message });
      if (this.#ready) this.#emit(event);
      return;
    }
    if (!this.#ready) {
      if (event.type === "error") {
        this.#fail(event.message, undefined, event.code !== "phrase-not-supported", event.code);
      } else {
        this.#fail("The wake helper emitted an event before readiness.");
      }
      return;
    }
    if (event.type === "error") {
      this.#fail(event.message, undefined, event.code !== "phrase-not-supported", event.code);
      return;
    }
    this.#emit(event);
  }

  #handleDrain(): void {
    if (!this.#pcmBackpressured) return;
    this.#pcmBackpressured = false;
    if (this.#backpressureTimer) clearTimeout(this.#backpressureTimer);
    this.#backpressureTimer = null;
  }

  #handleExit(): void {
    if (this.#exited) return;
    this.#exited = true;
    for (const resolve of [...this.#exitWaiters]) resolve();
    this.#exitWaiters.clear();
    if (this.#stopping || this.#stopped) return;
    this.#fail(this.#ready
      ? "The wake helper exited unexpectedly."
      : "The wake helper exited before readiness.");
  }

  #failWithAbort(): void {
    if (this.#stopped) return;
    const error = abortError();
    this.#readyReject?.(error);
    this.#readyResolve = null;
    this.#readyReject = null;
    this.#terminateImmediately();
  }

  #fail(
    message: string,
    error?: unknown,
    poisonRuntime = true,
    code?: "phrase-not-supported",
  ): void {
    if (this.#stopped) return;
    const reason = runtimeFailure(message, error);
    if (poisonRuntime) this.#onFailure(reason);
    const event: VoiceWakeHelperEvent = {
        version: 2,
      type: "error",
      ...(code ? { code } : {}),
      message: reason,
    };
    this.#terminalError = event;
    if (this.#ready) {
      this.#emit(event);
    } else {
      this.#readyReject?.(new Error(reason));
      this.#readyResolve = null;
      this.#readyReject = null;
    }
    this.#terminateImmediately();
  }

  #terminateImmediately(): void {
    if (this.#stopped) return;
    this.#stopping = true;
    this.#stopped = true;
    this.#clearTransientState();
    try { this.#process.end(); } catch { /* best effort */ }
    if (!this.#exited) {
      try { this.#process.kill(); } catch { /* best effort */ }
    }
    this.#finalize();
  }

  #emit(event: VoiceWakeHelperEvent): void {
    for (const listener of [...this.#listeners]) {
      try { listener(event); } catch { /* listener isolation */ }
    }
  }

  #waitForExit(): Promise<void> {
    if (this.#exited) return Promise.resolve();
    return new Promise<void>((resolve) => { this.#exitWaiters.add(resolve); });
  }

  #clearTransientState(): void {
    this.#clearReadyState();
    if (this.#backpressureTimer) clearTimeout(this.#backpressureTimer);
    this.#backpressureTimer = null;
    this.#pcmBackpressured = false;
  }

  #clearReadyState(): void {
    if (this.#readyTimer) clearTimeout(this.#readyTimer);
    this.#readyTimer = null;
    if (this.#abortSignal && this.#abortListener) {
      this.#abortSignal.removeEventListener("abort", this.#abortListener);
    }
    this.#abortSignal = null;
    this.#abortListener = null;
  }

  #finalize(): void {
    if (this.#finalized) return;
    this.#finalized = true;
    for (const unsubscribe of this.#unsubscribers.splice(0)) {
      try { unsubscribe(); } catch { /* best effort */ }
    }
    for (const resolve of [...this.#exitWaiters]) resolve();
    this.#exitWaiters.clear();
    this.#listeners.clear();
    this.#onStopped();
  }
}

function createSpawnConfig(bundle: ValidatedSherpaVoiceWakeBundle): VoiceWakeHelperSpawnConfig {
  const args = [
    "--protocol",
    String(voiceWakeProtocolVersion),
    "--kws-encoder",
    bundle.keywordEncoderPath,
    "--kws-decoder",
    bundle.keywordDecoderPath,
    "--kws-joiner",
    bundle.keywordJoinerPath,
    "--kws-bpe-model",
    bundle.keywordBpeModelPath,
    "--kws-tokens",
    bundle.keywordTokensPath,
    "--vad-model",
    bundle.vadModelPath,
  ];
  return {
    command: bundle.helperPath,
    args,
    cwd: bundle.rootDir,
    env: createVoiceWakeHelperEnvironment(),
  };
}

function createVoiceWakeHelperEnvironment(): Readonly<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { LANG: "C", LC_ALL: "C" };
  const allowedKeys = process.platform === "win32"
    ? ["SystemRoot", "WINDIR", "TEMP", "TMP"]
    : ["TMPDIR"];
  for (const key of allowedKeys) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

export function spawnVoiceWakeHelper(config: VoiceWakeHelperSpawnConfig): VoiceWakeHelperProcess {
  const child = spawn(config.command, [...config.args], {
    cwd: config.cwd,
    env: { ...config.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!child.stdin || !child.stdout || !child.stderr) throw new Error("Wake helper stdio is unavailable.");
  const errorListeners = new Set<(error: Error) => void>();
  const forwardError = (error: Error) => {
    for (const listener of [...errorListeners]) listener(error);
  };
  child.on("error", forwardError);
  child.stdin.on("error", forwardError);
  return {
    write: (data) => child.stdin.write(data, "utf8"),
    end: () => { child.stdin.end(); },
    kill: () => { if (!child.killed) child.kill("SIGKILL"); },
    onDrain: (listener) => {
      child.stdin.on("drain", listener);
      return () => { child.stdin.removeListener("drain", listener); };
    },
    onStdoutData: (listener) => {
      const handler = (chunk: Buffer) => { listener(chunk); };
      child.stdout.on("data", handler);
      return () => { child.stdout.removeListener("data", handler); };
    },
    onStderrData: (listener) => {
      const handler = (chunk: Buffer) => { listener(chunk); };
      child.stderr.on("data", handler);
      return () => { child.stderr.removeListener("data", handler); };
    },
    onExit: (listener) => {
      child.on("exit", listener);
      return () => { child.removeListener("exit", listener); };
    },
    onError: (listener) => {
      errorListeners.add(listener);
      return () => { errorListeners.delete(listener); };
    },
  };
}

function runtimeFailure(message: string, error?: unknown): string {
  const detail = error instanceof Error ? sanitizeVoiceWakeMessage(error.message) : "";
  const base = sanitizeVoiceWakeMessage(message) || "The wake helper failed.";
  return detail ? `${base} ${detail}`.slice(0, 500) : base;
}

function abortError(): Error {
  const error = new Error("Wake helper startup was aborted.");
  error.name = "AbortError";
  return error;
}

function boundedDuration(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.min(60_000, Math.max(1, Math.round(value)));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
