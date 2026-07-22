import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  readFileSync,
  statSync,
} from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { validateSherpaVoiceWakeBundle } from "./voice-wake-sherpa-manifest.js";

export const localTranscriptionModelId = "sherpa-onnx-whisper-tiny.en-int8" as const;

export type LocalTranscriptionStatus = "not-installed" | "downloading" | "ready" | "error";
export type LocalTranscriptionSnapshot = {
  readonly status: LocalTranscriptionStatus;
  readonly modelId: typeof localTranscriptionModelId;
  readonly modelLabel: "Built-in English (Whisper Tiny)";
  readonly downloadBytes: number;
  readonly downloadedBytes: number;
  readonly storageLocation: string;
  readonly offlineAfterInstall: true;
  readonly progress?: string;
  readonly error?: string;
};
export type LocalTranscriptionLog = (
  level: "info" | "warn",
  message: string,
  fields?: Record<string, unknown>,
) => void;

type ModelFile = {
  readonly name: "encoder" | "decoder" | "tokens" | "notice";
  readonly fileName: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
};

const modelRevision = "2ffb4044a6556d7c2b4b335845ed4135fd5913ac";
const modelBaseUrl = `https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny.en/resolve/${modelRevision}`;
const modelFiles: readonly ModelFile[] = [
  {
    name: "encoder",
    fileName: "tiny.en-encoder.int8.onnx",
    url: `${modelBaseUrl}/tiny.en-encoder.int8.onnx`,
    bytes: 12_936_024,
    sha256: "e567882ec0a73cbd40e24487905481efbffdfc9999c4ef93eff7c994f687850c",
  },
  {
    name: "decoder",
    fileName: "tiny.en-decoder.int8.onnx",
    url: `${modelBaseUrl}/tiny.en-decoder.int8.onnx`,
    bytes: 89_851_889,
    sha256: "28ecd4064009306dc0e7ed60a91610663213b3a127d0fb2ef0e637df3b260d00",
  },
  {
    name: "tokens",
    fileName: "tiny.en-tokens.txt",
    url: `${modelBaseUrl}/tiny.en-tokens.txt`,
    bytes: 835_554,
    sha256: "306cd27f03c1a714eca7108e03d66b7dc042abe8c258b44c199a7ed9838dd930",
  },
  {
    name: "notice",
    fileName: "MODEL_NOTICE.md",
    url: `${modelBaseUrl}/README.md`,
    bytes: 259,
    sha256: "8478789b94b58b82603d3702b5cb9ed637053ad7a49b65aff8de06957ee9ddf4",
  },
];
const totalDownloadBytes = modelFiles.reduce((sum, file) => sum + file.bytes, 0);
const installMarkerName = "openpets-local-stt.json";
const maxAudioBytes = 16 * 1024 * 1024;
const maxHelperOutputBytes = 1024 * 1024;
const transcriptionTimeoutMs = 3 * 60_000;

export class LocalTranscriptionService {
  readonly #modelRoot: string;
  readonly #bundleRoot: string;
  readonly #log: LocalTranscriptionLog;
  #status: LocalTranscriptionStatus;
  #downloadedBytes = 0;
  #progress: string | undefined;
  #error: string | undefined;
  #installOperation: Promise<LocalTranscriptionSnapshot> | null = null;
  #verificationOperation: Promise<boolean> | null = null;
  #verifiedSignature: string | null = null;

  constructor(input: {
    readonly userDataPath: string;
    readonly resourcesPath?: string;
    readonly log?: LocalTranscriptionLog;
  }) {
    const parent = join(input.userDataPath, "local-stt");
    this.#modelRoot = join(parent, localTranscriptionModelId);
    this.#bundleRoot = join(input.resourcesPath ?? "", "voice-wake", "sherpa-onnx");
    this.#log = input.log ?? (() => undefined);
    this.#status = this.#hasInstalledStructure() ? "ready" : "not-installed";
    this.#downloadedBytes = this.#status === "ready" ? totalDownloadBytes : 0;
  }

  snapshot(): LocalTranscriptionSnapshot {
    return {
      status: this.#status,
      modelId: localTranscriptionModelId,
      modelLabel: "Built-in English (Whisper Tiny)",
      downloadBytes: totalDownloadBytes,
      downloadedBytes: this.#downloadedBytes,
      storageLocation: this.#modelRoot,
      offlineAfterInstall: true,
      ...(this.#progress ? { progress: this.#progress } : {}),
      ...(this.#error ? { error: this.#error } : {}),
    };
  }

  async health(): Promise<{ readonly ready: boolean; readonly reason?: string }> {
    if (!(await this.#verifyInstalled())) {
      return { ready: false, reason: "Download the built-in speech recognition model." };
    }
    const bundle = validateSherpaVoiceWakeBundle({ rootDir: this.#bundleRoot });
    return bundle.ok
      ? { ready: true }
      : { ready: false, reason: `Built-in speech recognition is unavailable: ${bundle.reason}` };
  }

  install(): Promise<LocalTranscriptionSnapshot> {
    if (this.#installOperation) return this.#installOperation;
    const operation = this.#installOnce();
    this.#installOperation = operation;
    void operation.finally(() => {
      if (this.#installOperation === operation) this.#installOperation = null;
    }).catch(() => undefined);
    return operation;
  }

  async transcribe(audio: Uint8Array, mimeType: string, signal?: AbortSignal): Promise<string> {
    const health = await this.health();
    if (!health.ready) throw new Error(health.reason ?? "Built-in speech recognition is not ready.");
    if (mimeType !== "audio/wav") throw new Error("Built-in speech recognition needs WAV audio.");
    if (audio.byteLength < 44 || audio.byteLength > maxAudioBytes) throw new Error("The captured speech audio is invalid.");
    if (signal?.aborted) throw abortError();

    const validation = validateSherpaVoiceWakeBundle({ rootDir: this.#bundleRoot });
    if (!validation.ok) throw new Error(`Built-in speech recognition is unavailable: ${validation.reason}`);
    const model = Object.fromEntries(modelFiles.map((file) => [file.name, join(this.#modelRoot, file.fileName)]));
    const args = [
      "--protocol", "2",
      "--stt-encoder", model.encoder,
      "--stt-decoder", model.decoder,
      "--stt-tokens", model.tokens,
      "--stt-input", "stdin",
    ];
    const text = await runHelper(validation.bundle.helperPath, args, validation.bundle.rootDir, audio, signal);
    return text.trim().slice(0, 8_000);
  }

  async #installOnce(): Promise<LocalTranscriptionSnapshot> {
    if (await this.#verifyInstalled()) {
      this.#status = "ready";
      this.#downloadedBytes = totalDownloadBytes;
      this.#progress = "Built-in speech recognition is ready.";
      this.#error = undefined;
      return this.snapshot();
    }
    this.#status = "downloading";
    this.#downloadedBytes = 0;
    this.#progress = "Downloading the built-in speech recognition model.";
    this.#error = undefined;
    const staging = `${this.#modelRoot}.installing-${process.pid}`;
    try {
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true, mode: 0o700 });
      for (const file of modelFiles) {
        this.#progress = `Downloading ${friendlyFileName(file.name)}.`;
        await this.#downloadVerified(file, join(staging, file.fileName));
      }
      await writeFile(join(staging, installMarkerName), `${JSON.stringify({
        version: 1,
        modelId: localTranscriptionModelId,
        revision: modelRevision,
        installedAt: Date.now(),
        files: modelFiles.map(({ fileName, bytes, sha256 }) => ({ fileName, bytes, sha256 })),
      }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rm(this.#modelRoot, { recursive: true, force: true });
      await mkdir(dirname(this.#modelRoot), { recursive: true });
      await rename(staging, this.#modelRoot);
      this.#verifiedSignature = this.#installedSignature();
      this.#status = "ready";
      this.#downloadedBytes = totalDownloadBytes;
      this.#progress = "Built-in speech recognition is ready and works offline.";
      this.#log("info", "local transcription model installed", { modelId: localTranscriptionModelId, bytes: totalDownloadBytes });
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      this.#status = "error";
      this.#verifiedSignature = null;
      this.#error = cleanError(error);
      this.#progress = undefined;
      this.#log("warn", "local transcription model install failed", { modelId: localTranscriptionModelId, reason: this.#error });
    }
    return this.snapshot();
  }

  async #downloadVerified(file: ModelFile, destination: string): Promise<void> {
    const partial = `${destination}.partial`;
    await rm(partial, { force: true });
    const response = await fetch(file.url, { redirect: "follow", headers: { "User-Agent": "OpenPets-local-transcription" } });
    if (!response.ok || !response.body) throw new Error(`The model download failed (HTTP ${response.status}).`);
    const hash = createHash("sha256");
    let fileBytes = 0;
    const meter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        fileBytes += chunk.byteLength;
        if (fileBytes > file.bytes) {
          callback(new Error("The model download was larger than expected."));
          return;
        }
        hash.update(chunk);
        this.#downloadedBytes = Math.min(totalDownloadBytes, this.#downloadedBytes + chunk.byteLength);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(partial, { flags: "wx", mode: 0o600 }));
      if (fileBytes !== file.bytes || hash.digest("hex") !== file.sha256) throw new Error("The model download failed its integrity check.");
      await rename(partial, destination);
    } catch (error) {
      await rm(partial, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  #hasInstalledStructure(): boolean {
    try {
      const marker = JSON.parse(readFileSync(join(this.#modelRoot, installMarkerName), "utf8")) as { modelId?: unknown; revision?: unknown };
      return marker.modelId === localTranscriptionModelId
        && marker.revision === modelRevision
        && modelFiles.every((file) => statSync(join(this.#modelRoot, file.fileName)).size === file.bytes);
    } catch {
      return false;
    }
  }

  #installedSignature(): string | null {
    try {
      return modelFiles.map((file) => {
        const stat = statSync(join(this.#modelRoot, file.fileName));
        return `${file.fileName}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      }).join("|");
    } catch {
      return null;
    }
  }

  #verifyInstalled(): Promise<boolean> {
    if (!this.#hasInstalledStructure()) {
      this.#verifiedSignature = null;
      return Promise.resolve(false);
    }
    const signature = this.#installedSignature();
    if (!signature) return Promise.resolve(false);
    if (signature === this.#verifiedSignature) return Promise.resolve(true);
    if (this.#verificationOperation) return this.#verificationOperation;
    const operation = (async () => {
      for (const file of modelFiles) {
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(join(this.#modelRoot, file.fileName))) hash.update(chunk as Buffer);
        if (hash.digest("hex") !== file.sha256) {
          this.#status = "error";
          this.#error = "The installed speech recognition model failed its integrity check. Download it again.";
          this.#verifiedSignature = null;
          return false;
        }
      }
      this.#verifiedSignature = signature;
      this.#status = "ready";
      this.#error = undefined;
      return true;
    })().catch(() => {
      this.#verifiedSignature = null;
      return false;
    });
    this.#verificationOperation = operation;
    void operation.finally(() => {
      if (this.#verificationOperation === operation) this.#verificationOperation = null;
    }).catch(() => undefined);
    return operation;
  }
}

async function runHelper(command: string, args: readonly string[], cwd: string, audio: Uint8Array, signal?: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, env: helperEnvironment(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error, text?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve(text ?? "");
    };
    const onAbort = () => {
      if (!child.killed) child.kill("SIGKILL");
      finish(abortError());
    };
    const timer = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
      finish(new Error("Built-in speech recognition timed out."));
    }, transcriptionTimeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxHelperOutputBytes) onAbort();
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.reduce((sum, value) => sum + value.byteLength, 0) < 8 * 1024) stderr.push(chunk);
    });
    child.once("error", (error) => finish(new Error(`Built-in speech recognition could not start: ${cleanError(error)}`)));
    child.stdin.once("error", () => {
      if (settled) return;
      if (!child.killed) child.kill("SIGKILL");
      finish(new Error("Built-in speech recognition input failed."));
    });
    child.once("exit", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error(cleanError(Buffer.concat(stderr).toString("utf8")) || "Built-in speech recognition failed."));
        return;
      }
      try {
        const lines = Buffer.concat(stdout).toString("utf8").split(/\r?\n/).filter(Boolean);
        const result = lines.map((line) => JSON.parse(line) as unknown).find((value) => isRecord(value) && value.type === "transcript");
        if (!isRecord(result) || typeof result.text !== "string") throw new Error("Built-in speech recognition returned an invalid result.");
        finish(undefined, result.text);
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Built-in speech recognition returned an invalid result."));
      }
    });
    if (signal?.aborted) onAbort();
    else child.stdin.end(audio);
  });
}

function helperEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { LANG: "C", LC_ALL: "C" };
  for (const key of process.platform === "win32" ? ["SystemRoot", "WINDIR", "TEMP", "TMP"] : ["TMPDIR"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function friendlyFileName(name: ModelFile["name"]): string {
  if (name === "tokens") return "speech vocabulary";
  if (name === "notice") return "model license information";
  return `speech ${name}`;
}

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/\S+/gi, "model source")
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s/\\]+[\/\\])+[^\s]+/g, "local file")
    .trim()
    .slice(0, 300) || "Built-in speech recognition failed.";
}

function abortError(): Error {
  const error = new Error("Built-in speech recognition was cancelled.");
  error.name = "AbortError";
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

let singleton: LocalTranscriptionService | null = null;

export function initializeLocalTranscriptionService(
  userDataPath: string,
  resourcesPath?: string,
  log?: LocalTranscriptionLog,
): LocalTranscriptionService {
  singleton ??= new LocalTranscriptionService({ userDataPath, resourcesPath, log });
  return singleton;
}

export function getLocalTranscriptionService(): LocalTranscriptionService | null {
  return singleton;
}
