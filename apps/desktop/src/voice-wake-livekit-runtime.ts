import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { sanitizeVoiceWakeMessage, type VoiceWakeHelperEvent } from "./voice-wake-helper-protocol.js";
import { maxVoiceWakeHelperEventLineBytes, parseVoiceWakeHelperEventLine, serializeVoiceWakeHelperCommand } from "./voice-wake-helper-wire.js";
import { validateLiveKitWakeBundle, type ValidatedLiveKitWakeBundle } from "./voice-wake-livekit-manifest.js";
import { spawnVoiceWakeHelper, type VoiceWakeHelperProcess, type VoiceWakeHelperSpawner, type VoiceWakeRuntimeLog } from "./voice-wake-sherpa-runtime.js";
import { UnavailableVoiceWakeRuntime, type VoiceWakeRuntime, type VoiceWakeRuntimeHealth, type VoiceWakeRuntimeSession, type VoiceWakeRuntimeStartConfig } from "./voice-wake-runtime.js";
import type { VoicePcmFrame, VoiceWakeSensitivity } from "./voice-wake-types.js";

export type LiveKitVoiceWakeRuntimeOptions = {
  readonly bundleRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
  readonly spawnHelper?: VoiceWakeHelperSpawner;
  readonly log?: VoiceWakeRuntimeLog;
  readonly readyTimeoutMs?: number;
};

export function createLiveKitVoiceWakeRuntime(options: LiveKitVoiceWakeRuntimeOptions): VoiceWakeRuntime {
  const validation = validateLiveKitWakeBundle({
    rootDir: options.bundleRoot,
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.arch ? { arch: options.arch } : {}),
  });
  if (!validation.ok) return new UnavailableVoiceWakeRuntime(`LiveKit wake word is not available: ${validation.reason}`);
  return new LiveKitVoiceWakeRuntime(
    validation.bundle,
    options.spawnHelper ?? spawnVoiceWakeHelper,
    options.log ?? (() => undefined),
    boundedDuration(options.readyTimeoutMs, 15_000),
  );
}

export function createProductionLiveKitVoiceWakeRuntime(options: Omit<LiveKitVoiceWakeRuntimeOptions, "bundleRoot"> & { readonly resourcesPath?: string } = {}): VoiceWakeRuntime {
  const resourcesPath = options.resourcesPath ?? (process as NodeJS.Process & { readonly resourcesPath?: string }).resourcesPath;
  if (!resourcesPath) return new UnavailableVoiceWakeRuntime("LiveKit wake word is not available: the packaged resource directory is missing.");
  return createLiveKitVoiceWakeRuntime({ ...options, bundleRoot: join(resourcesPath, "voice-wake", "livekit") });
}

class LiveKitVoiceWakeRuntime implements VoiceWakeRuntime {
  readonly #bundle: ValidatedLiveKitWakeBundle;
  readonly #spawnHelper: VoiceWakeHelperSpawner;
  readonly #log: VoiceWakeRuntimeLog;
  readonly #readyTimeoutMs: number;
  #active: LiveKitVoiceWakeSession | null = null;
  #failure: string | undefined;
  #disposed = false;

  constructor(bundle: ValidatedLiveKitWakeBundle, spawnHelper: VoiceWakeHelperSpawner, log: VoiceWakeRuntimeLog, readyTimeoutMs: number) {
    this.#bundle = bundle;
    this.#spawnHelper = spawnHelper;
    this.#log = log;
    this.#readyTimeoutMs = readyTimeoutMs;
  }

  health(): VoiceWakeRuntimeHealth {
    return {
      ready: !this.#disposed && !this.#failure,
      method: "livekit-wakeword",
      version: this.#bundle.bundleVersion,
      modelId: this.#bundle.phraseId,
      ...(this.#disposed ? { reason: "The LiveKit wake runtime is shut down." } : this.#failure ? { reason: this.#failure } : {}),
    };
  }

  async start(config: VoiceWakeRuntimeStartConfig): Promise<VoiceWakeRuntimeSession> {
    if (config.engine !== "official-livekit" || config.phraseId !== this.#bundle.phraseId) throw new Error("The official LiveKit wake classifier selection is invalid.");
    if (this.#disposed) throw new Error("The LiveKit wake runtime is shut down.");
    if (this.#failure) throw new Error(this.#failure);
    if (this.#active) throw new Error("A LiveKit wake helper session is already active.");
    if (config.signal.aborted) throw abortError();
    const threshold = this.#bundle.thresholds[config.sensitivity];
    const process = this.#spawnHelper({
      command: this.#bundle.helperPath,
      args: ["--classifier", this.#bundle.classifierPath, "--threshold", String(threshold)],
      cwd: this.#bundle.rootDir,
      env: helperEnvironment(),
    });
    let session!: LiveKitVoiceWakeSession;
    session = new LiveKitVoiceWakeSession(process, this.#log, this.#readyTimeoutMs, (reason) => { this.#failure = reason; }, () => {
      if (this.#active === session) this.#active = null;
    });
    this.#active = session;
    try {
      await session.waitUntilReady(config.phrase, config.signal);
      return session;
    } catch (error) {
      if (this.#active === session) this.#active = null;
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#active?.stop();
    this.#active = null;
  }
}

class LiveKitVoiceWakeSession implements VoiceWakeRuntimeSession {
  readonly #process: VoiceWakeHelperProcess;
  readonly #log: VoiceWakeRuntimeLog;
  readonly #readyTimeoutMs: number;
  readonly #onFailure: (reason: string) => void;
  readonly #onStopped: () => void;
  readonly #listeners = new Set<(event: VoiceWakeHelperEvent) => void>();
  readonly #unsubscribers: Array<() => void> = [];
  readonly #decoder = new StringDecoder("utf8");
  #buffer = "";
  #ready = false;
  #stopped = false;
  #backpressured = false;
  #readyResolve: (() => void) | null = null;
  #readyReject: ((error: Error) => void) | null = null;
  #readyTimer: NodeJS.Timeout | null = null;
  #stopPromise: Promise<void> | null = null;

  constructor(process: VoiceWakeHelperProcess, log: VoiceWakeRuntimeLog, readyTimeoutMs: number, onFailure: (reason: string) => void, onStopped: () => void) {
    this.#process = process;
    this.#log = log;
    this.#readyTimeoutMs = readyTimeoutMs;
    this.#onFailure = onFailure;
    this.#onStopped = onStopped;
    this.#unsubscribers.push(
      process.onStdoutData((chunk) => this.#stdout(chunk)),
      process.onStderrData((chunk) => {
        const message = sanitizeVoiceWakeMessage(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        if (message) this.#log("warn", "LiveKit wake helper diagnostic", { message });
      }),
      process.onDrain(() => { this.#backpressured = false; }),
      process.onExit(() => { if (!this.#stopped) this.#fail(this.#ready ? "The LiveKit wake helper exited unexpectedly." : "The LiveKit wake helper exited before readiness."); }),
      process.onError((error) => this.#fail("The LiveKit wake helper process failed.", error)),
    );
  }

  waitUntilReady(phrase: string, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
      const abort = () => this.#failWithAbort();
      signal.addEventListener("abort", abort, { once: true });
      this.#unsubscribers.push(() => signal.removeEventListener("abort", abort));
      this.#readyTimer = setTimeout(() => this.#fail("The LiveKit wake helper did not become ready in time."), this.#readyTimeoutMs);
      this.#readyTimer.unref?.();
      if (signal.aborted) return this.#failWithAbort();
      try {
        this.#process.write(serializeVoiceWakeHelperCommand({ version: 2, type: "configure", phrase, variants: [] }));
      } catch (error) {
        this.#fail("The LiveKit wake helper could not be configured.", error);
      }
    });
  }

  sendFrame(frame: VoicePcmFrame): void {
    if (!this.#ready || this.#stopped || this.#backpressured) return;
    try {
      this.#backpressured = !this.#process.write(serializeVoiceWakeHelperCommand({ version: 2, type: "pcm", frame }));
    } catch (error) {
      this.#fail("The LiveKit wake helper input failed.", error);
    }
  }

  reset(): void {
    if (!this.#ready || this.#stopped) return;
    try { this.#process.write(serializeVoiceWakeHelperCommand({ version: 2, type: "reset" })); } catch (error) { this.#fail("The LiveKit wake helper reset failed.", error); }
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopPromise = this.#stop();
    return this.#stopPromise;
  }

  onEvent(listener: (event: VoiceWakeHelperEvent) => void): () => void {
    if (!this.#stopped) this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  async #stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#clearTimer();
    try { this.#process.write(serializeVoiceWakeHelperCommand({ version: 2, type: "stop" })); } catch { /* best effort */ }
    try { this.#process.end(); } catch { /* best effort */ }
    await delay(150);
    try { this.#process.kill(); } catch { /* best effort */ }
    this.#finalize();
  }

  #stdout(chunk: Uint8Array | string): void {
    if (this.#stopped) return;
    this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.write(Buffer.from(chunk));
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > maxVoiceWakeHelperEventLineBytes) return this.#fail("The LiveKit wake helper produced an oversized event.");
      const event = parseVoiceWakeHelperEventLine(line);
      if (!event || event.type === "vad") return this.#fail("The LiveKit wake helper produced an invalid event.");
      if (event.type === "ready") {
        if (this.#ready) return this.#fail("The LiveKit wake helper reported readiness twice.");
        this.#ready = true;
        this.#clearTimer();
        this.#readyResolve?.();
        this.#readyResolve = null;
        this.#readyReject = null;
      } else if (event.type === "error") {
        this.#fail(event.message, undefined, event.code !== "phrase-not-supported");
      } else if (event.type === "log") {
        this.#log(event.level, "LiveKit wake helper", { message: event.message });
      } else if (this.#ready) {
        for (const listener of [...this.#listeners]) { try { listener(event); } catch { /* listener isolation */ } }
      } else {
        this.#fail("The LiveKit wake helper emitted an event before readiness.");
      }
    }
    if (Buffer.byteLength(this.#buffer, "utf8") > maxVoiceWakeHelperEventLineBytes) this.#fail("The LiveKit wake helper produced an oversized event.");
  }

  #failWithAbort(): void {
    const error = abortError();
    this.#readyReject?.(error);
    this.#readyReject = null;
    this.#readyResolve = null;
    this.#terminate();
  }

  #fail(message: string, error?: unknown, poison = true): void {
    if (this.#stopped) return;
    const detail = error instanceof Error ? sanitizeVoiceWakeMessage(error.message) : "";
    const reason = `${sanitizeVoiceWakeMessage(message)}${detail ? ` ${detail}` : ""}`.slice(0, 500);
    if (poison) this.#onFailure(reason);
    const event: VoiceWakeHelperEvent = { version: 2, type: "error", message: reason };
    if (this.#ready) for (const listener of [...this.#listeners]) { try { listener(event); } catch { /* listener isolation */ } }
    else this.#readyReject?.(new Error(reason));
    this.#terminate();
  }

  #terminate(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#clearTimer();
    try { this.#process.end(); } catch { /* best effort */ }
    try { this.#process.kill(); } catch { /* best effort */ }
    this.#finalize();
  }

  #clearTimer(): void {
    if (this.#readyTimer) clearTimeout(this.#readyTimer);
    this.#readyTimer = null;
  }

  #finalize(): void {
    for (const unsubscribe of this.#unsubscribers.splice(0)) { try { unsubscribe(); } catch { /* best effort */ } }
    this.#listeners.clear();
    this.#onStopped();
  }
}

function helperEnvironment(): Readonly<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { LANG: "C", LC_ALL: "C" };
  const temp = process.env.TMPDIR;
  if (temp) env.TMPDIR = temp;
  return env;
}

function abortError(): Error {
  const error = new Error("LiveKit wake helper startup was aborted.");
  error.name = "AbortError";
  return error;
}

function boundedDuration(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined ? Math.min(60_000, Math.max(1, Math.round(value))) : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
}
