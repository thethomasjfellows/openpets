import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSherpaOnnxVoiceWakeRuntime,
  spawnVoiceWakeHelper,
  type VoiceWakeHelperProcess,
  type VoiceWakeHelperSpawnConfig,
  type VoiceWakeRuntimeLog,
} from "../src/voice-wake-sherpa-runtime.js";
import type { VoiceWakeHelperEvent } from "../src/voice-wake-helper-protocol.js";
import type { VoiceWakeRuntime, VoiceWakeRuntimeSession } from "../src/voice-wake-runtime.js";
import type { VoicePcmFrame } from "../src/voice-wake-types.js";

const bundleRoot = mkdtempSync(join(tmpdir(), "openpets-wake-runtime-"));
const testPlatform: "darwin" | "win32" | "linux" = process.platform === "win32" || process.platform === "linux"
  ? process.platform
  : "darwin";
const testArch: "x64" | "arm64" = process.arch === "x64" ? "x64" : "arm64";
const testPlatformId = `${testPlatform}-${testArch}`;
const helperRelativePath = testPlatform === "win32"
  ? "bin/openpets-wake-helper.exe"
  : "bin/openpets-wake-helper";
writeValidBundle(bundleRoot);

async function main(): Promise<void> {
  try {
    await verifySpawnBridgeRoutesStdinErrors();
    await verifyReadyEventsPcmAndStop();
    await verifyUnsupportedPhraseCanRetry();
    await verifyPreReadyEngineFailurePoisonsRuntime();
    await verifyAbortBeforeReady();
    await verifyDisposeDuringStartup();
    await verifyExitBeforeReady();
    await verifyUnexpectedExitAfterReady();
    await verifyMalformedOutput();
    await verifyBackpressureDropsFrames();

    console.log("Sherpa helper process runtime lifecycle verified");
  } finally {
    rmSync(bundleRoot, { recursive: true, force: true });
  }
}

async function verifySpawnBridgeRoutesStdinErrors(): Promise<void> {
  const helper = spawnVoiceWakeHelper({
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    cwd: bundleRoot,
    env: {},
  });
  const errors: Error[] = [];
  const unsubscribeError = helper.onError((error) => { errors.push(error); });
  const exited = new Promise<void>((resolve) => {
    helper.onExit(() => { resolve(); });
  });
  helper.write("x".repeat(1024 * 1024));
  await exited;
  await waitFor(() => errors.length > 0);
  assert.match(errors[0]?.message ?? "", /pipe|stream|write|closed|destroyed/i, "a helper pipe failure is routed through the process error boundary");
  unsubscribeError();
}

async function verifyReadyEventsPcmAndStop(): Promise<void> {
  const helper = new FakeHelperProcess();
  const logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
  const spawnConfigs: VoiceWakeHelperSpawnConfig[] = [];
  const runtime = createRuntime(helper, (level, message, fields) => {
    logs.push({ level, message, ...(fields ? { fields } : {}) });
  }, (config) => { spawnConfigs.push(config); });

  const controller = new AbortController();
  let settled = false;
  const starting = runtime.start({ engine: "custom-sherpa", phrase: "  Hey OpenPet  ", signal: controller.signal });
  void starting.then(() => { settled = true; });
  await tick();
  assert.equal(settled, false, "start waits for the helper ready event");
  const spawnConfig = spawnConfigs[0];
  assert.ok(spawnConfig);
  assert.ok(spawnConfig.command.endsWith(helperRelativePath.replaceAll("/", process.platform === "win32" ? "\\" : "/")));
  assert.deepEqual(spawnConfig.args.slice(0, 2), ["--protocol", "2"]);
  for (const flag of [
    "--kws-encoder",
    "--kws-decoder",
    "--kws-joiner",
    "--kws-bpe-model",
    "--kws-tokens",
    "--vad-model",
  ]) {
    assert.ok(spawnConfig.args.includes(flag), `helper receives ${flag}`);
  }
  assert.equal(spawnConfig.env.LANG, "C");
  assert.equal(spawnConfig.env.LC_ALL, "C");
  assert.equal(spawnConfig.env.OPENAI_API_KEY, undefined, "the helper environment must not inherit provider secrets");
  assert.equal(spawnConfig.env.PATH, undefined, "the reviewed helper must not depend on the user shell PATH");

  const configure = parseWrite(helper.writes[0]);
  assert.deepEqual(configure, { version: 2, type: "configure", phrase: "Hey OpenPet", variants: [] });
  helper.emitStdout({ version: 2, type: "ready" });
  const session = await starting;
  assert.equal(runtime.health().ready, true);
  assert.equal(runtime.health().method, "sherpa-onnx");
  assert.equal(runtime.health().version, "1.2.3");
  assert.equal(runtime.health().modelId, "openpets-default-en");

  const events: VoiceWakeHelperEvent[] = [];
  session.onEvent((event) => { events.push(event); });
  session.onEvent(() => { throw new Error("listener isolation"); });
  helper.emitStdout({ version: 2, type: "keyword", score: 0.91 });
  helper.emitStdout({ version: 2, type: "vad", state: "speech-start", score: 0.75 });
  assert.deepEqual(events.slice(0, 2), [
    { version: 2, type: "keyword", score: 0.91 },
    { version: 2, type: "vad", state: "speech-start", score: 0.75 },
  ]);

  const frame = pcmFrame(320);
  session.sendFrame(frame);
  const pcm = parseWrite(helper.writes.at(-1));
  assert.equal(pcm.type, "pcm");
  assert.equal(pcm.format, "f32le");
  assert.equal(pcm.sampleRate, 16_000);
  assert.equal(pcm.channels, 1);
  const pcmBytes = Buffer.from(String(pcm.samplesBase64), "base64");
  assert.equal(pcmBytes.byteLength, 320 * 4);
  assert.ok(Math.abs(pcmBytes.readFloatLE(0) - 0.25) < 0.0001);

  session.reset();
  assert.equal(parseWrite(helper.writes.at(-1)).type, "reset");

  helper.emitStderr("/Users/example/private-model.onnx\n");
  assert.equal(logs.some((entry) => JSON.stringify(entry).includes("/Users/example")), false);

  const stopping = session.stop();
  assert.equal(parseWrite(helper.writes.at(-1)).type, "stop");
  assert.equal(helper.ends, 1);
  helper.emitExit(0, null);
  await stopping;
  await session.stop();
  assert.equal(helper.kills, 0);
  await runtime.dispose();
}

async function verifyUnsupportedPhraseCanRetry(): Promise<void> {
  const helpers = [new FakeHelperProcess(), new FakeHelperProcess()];
  let spawnIndex = 0;
  const runtime = createSherpaOnnxVoiceWakeRuntime({
    bundleRoot,
    platform: testPlatform,
    arch: testArch,
    spawnHelper: () => helpers[spawnIndex++]!,
    readyTimeoutMs: 100,
    backpressureTimeoutMs: 100,
    stopGraceMs: 20,
  });
  const unsupported = runtime.start({
    engine: "custom-sherpa",
    phrase: "Unsupported phrase",
    signal: new AbortController().signal,
  });
  helpers[0].emitStdout({
    version: 2,
    type: "error",
    code: "phrase-not-supported",
    message: "This wake phrase is not supported by the bundled model.",
  });
  await assert.rejects(unsupported, /not supported/i);
  assert.equal(runtime.health().ready, true, "an unsupported phrase must not poison the reviewed runtime bundle");

  const supported = runtime.start({
    engine: "custom-sherpa",
    phrase: "Hey OpenPet",
    signal: new AbortController().signal,
  });
  helpers[1].emitStdout({ version: 2, type: "ready" });
  const session = await supported;
  assert.equal(spawnIndex, 2, "saving a valid replacement phrase starts a fresh helper");
  const stopping = session.stop();
  helpers[1].emitExit(0, null);
  await stopping;
  await runtime.dispose();
}

async function verifyPreReadyEngineFailurePoisonsRuntime(): Promise<void> {
  const helper = new FakeHelperProcess();
  const runtime = createRuntime(helper);
  const starting = runtime.start({
    engine: "custom-sherpa",
    phrase: "Hey OpenPet",
    signal: new AbortController().signal,
  });
  helper.emitStdout({
    version: 2,
    type: "error",
    message: "Keyword detection could not be loaded.",
  });
  await assert.rejects(starting, /could not be loaded/i);
  assert.equal(runtime.health().ready, false, "a genuine engine failure must poison runtime health");
  assert.match(runtime.health().reason ?? "", /could not be loaded/i);
  await runtime.dispose();
}

async function verifyAbortBeforeReady(): Promise<void> {
  const helper = new FakeHelperProcess();
  const runtime = createRuntime(helper);
  const controller = new AbortController();
  const starting = runtime.start({ engine: "custom-sherpa", phrase: "Hey OpenPet", signal: controller.signal });
  const rejection = assert.rejects(
    starting,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  controller.abort();
  await rejection;
  assert.equal(helper.kills, 1);
  assert.equal(runtime.health().ready, true, "user cancellation does not poison a valid runtime");
  await runtime.dispose();
}

async function verifyDisposeDuringStartup(): Promise<void> {
  const helper = new FakeHelperProcess();
  const runtime = createRuntime(helper);
  const starting = runtime.start({ engine: "custom-sherpa", phrase: "Hey OpenPet", signal: new AbortController().signal });
  const rejection = assert.rejects(starting, /stopped before it became ready/i);
  const disposing = runtime.dispose();
  helper.emitExit(0, null);
  await rejection;
  await disposing;
  assert.equal(helper.ends, 1);
  assert.equal(runtime.health().ready, false);
  assert.match(runtime.health().reason ?? "", /shut down/i);
}

async function verifyExitBeforeReady(): Promise<void> {
  const helper = new FakeHelperProcess();
  const runtime = createRuntime(helper);
  const starting = runtime.start({ engine: "custom-sherpa", phrase: "Hey OpenPet", signal: new AbortController().signal });
  const rejection = assert.rejects(starting, /before readiness/i);
  helper.emitExit(1, null);
  await rejection;
  assert.equal(runtime.health().ready, false);
  assert.match(runtime.health().reason ?? "", /before readiness/i);
  await runtime.dispose();
}

async function verifyUnexpectedExitAfterReady(): Promise<void> {
  const helper = new FakeHelperProcess();
  const runtime = createRuntime(helper);
  const session = await startReady(runtime, helper);
  const events: VoiceWakeHelperEvent[] = [];
  session.onEvent((event) => { events.push(event); });
  helper.emitExit(2, null);
  await waitFor(() => events.some((event) => event.type === "error"));
  assert.match((events.find((event) => event.type === "error") as { message: string }).message, /exited unexpectedly/i);
  assert.equal(runtime.health().ready, false);
  await runtime.dispose();
}

async function verifyMalformedOutput(): Promise<void> {
  const helper = new FakeHelperProcess();
  const runtime = createRuntime(helper);
  const session = await startReady(runtime, helper);
  const events: VoiceWakeHelperEvent[] = [];
  session.onEvent((event) => { events.push(event); });
  helper.emitRawStdout("{not-json}\n");
  await waitFor(() => events.some((event) => event.type === "error"));
  assert.match((events.find((event) => event.type === "error") as { message: string }).message, /invalid event/i);
  assert.equal(helper.kills, 1);
  await runtime.dispose();
}

async function verifyBackpressureDropsFrames(): Promise<void> {
  const helper = new FakeHelperProcess();
  const runtime = createRuntime(helper);
  const session = await startReady(runtime, helper);
  const events: VoiceWakeHelperEvent[] = [];
  session.onEvent((event) => { events.push(event); });

  helper.nextWriteResult = false;
  session.sendFrame(pcmFrame(320));
  const writesAfterBackpressure = helper.writes.length;
  session.sendFrame(pcmFrame(320));
  assert.equal(helper.writes.length, writesAfterBackpressure, "PCM is dropped instead of queued while backpressured");
  assert.equal(events.some((event) => event.type === "log" && event.level === "warn"), true);

  helper.emitDrain();
  session.sendFrame(pcmFrame(320));
  assert.equal(helper.writes.length, writesAfterBackpressure + 1);

  const stopping = session.stop();
  helper.emitExit(0, null);
  await stopping;
  await runtime.dispose();
}

function createRuntime(
  helper: FakeHelperProcess,
  log: VoiceWakeRuntimeLog = () => undefined,
  onSpawn: (config: VoiceWakeHelperSpawnConfig) => void = () => undefined,
): VoiceWakeRuntime {
  const runtime = createSherpaOnnxVoiceWakeRuntime({
    bundleRoot,
    platform: testPlatform,
    arch: testArch,
    spawnHelper: (config) => {
      onSpawn(config);
      return helper;
    },
    log,
    readyTimeoutMs: 100,
    backpressureTimeoutMs: 100,
    stopGraceMs: 20,
  });
  assert.equal(runtime.health().method, "sherpa-onnx");
  assert.equal(runtime.health().ready, true);
  return runtime;
}

async function startReady(runtime: VoiceWakeRuntime, helper: FakeHelperProcess): Promise<VoiceWakeRuntimeSession> {
  const starting = runtime.start({ engine: "custom-sherpa", phrase: "Hey OpenPet", signal: new AbortController().signal });
  helper.emitStdout({ version: 2, type: "ready" });
  return starting;
}

function pcmFrame(samples: number): VoicePcmFrame {
  return {
    sampleRate: 16_000,
    channels: 1,
    format: "f32",
    samples: new Float32Array(samples).fill(0.25),
    capturedAt: 1_000,
  };
}

function parseWrite(value: string | undefined): Record<string, unknown> {
  assert.ok(value);
  return JSON.parse(value) as Record<string, unknown>;
}

class FakeHelperProcess implements VoiceWakeHelperProcess {
  readonly writes: string[] = [];
  nextWriteResult = true;
  ends = 0;
  kills = 0;
  readonly #drainListeners = new Set<() => void>();
  readonly #stdoutListeners = new Set<(chunk: Uint8Array | string) => void>();
  readonly #stderrListeners = new Set<(chunk: Uint8Array | string) => void>();
  readonly #exitListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();
  readonly #errorListeners = new Set<(error: Error) => void>();

  write(data: string): boolean {
    this.writes.push(data);
    const result = this.nextWriteResult;
    this.nextWriteResult = true;
    return result;
  }

  end(): void {
    this.ends += 1;
  }

  kill(): void {
    this.kills += 1;
  }

  onDrain(listener: () => void): () => void {
    this.#drainListeners.add(listener);
    return () => { this.#drainListeners.delete(listener); };
  }

  onStdoutData(listener: (chunk: Uint8Array | string) => void): () => void {
    this.#stdoutListeners.add(listener);
    return () => { this.#stdoutListeners.delete(listener); };
  }

  onStderrData(listener: (chunk: Uint8Array | string) => void): () => void {
    this.#stderrListeners.add(listener);
    return () => { this.#stderrListeners.delete(listener); };
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void {
    this.#exitListeners.add(listener);
    return () => { this.#exitListeners.delete(listener); };
  }

  onError(listener: (error: Error) => void): () => void {
    this.#errorListeners.add(listener);
    return () => { this.#errorListeners.delete(listener); };
  }

  emitDrain(): void {
    for (const listener of [...this.#drainListeners]) listener();
  }

  emitStdout(event: unknown): void {
    this.emitRawStdout(JSON.stringify(event) + "\n");
  }

  emitRawStdout(chunk: string): void {
    for (const listener of [...this.#stdoutListeners]) listener(chunk);
  }

  emitStderr(chunk: string): void {
    for (const listener of [...this.#stderrListeners]) listener(chunk);
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    for (const listener of [...this.#exitListeners]) listener(code, signal);
  }
}

function writeValidBundle(root: string): void {
  const files = [
    { role: "helper", path: helperRelativePath, content: "test-helper" },
    { role: "runtime-library", path: "lib/sherpa-runtime.bin", content: "runtime" },
    { role: "kws-encoder", path: "models/kws/encoder.onnx", content: "encoder" },
    { role: "kws-decoder", path: "models/kws/decoder.onnx", content: "decoder" },
    { role: "kws-joiner", path: "models/kws/joiner.onnx", content: "joiner" },
    { role: "kws-bpe-model", path: "models/kws/bpe.model", content: "bpe" },
    { role: "kws-tokens", path: "models/kws/tokens.txt", content: "tokens" },
    { role: "vad-model", path: "models/vad/silero_vad.onnx", content: "vad-model" },
    { role: "license", path: "licenses/LICENSE.txt", content: "test license" },
    { role: "notice", path: "THIRD_PARTY_NOTICES.md", content: "test notice" },
    { role: "provenance", path: "provenance.json", content: "{}\n" },
  ];
  for (const file of files) {
    const path = join(root, ...file.path.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, file.content);
  }
  if (testPlatform !== "win32") {
    chmodSync(join(root, ...helperRelativePath.split("/")), 0o755);
  }
  writeFileSync(join(root, "openpets-voice-wake.manifest.json"), JSON.stringify({
    version: 2,
    runtime: "sherpa-onnx",
    sherpaOnnxVersion: "1.13.4",
      protocolVersion: 2,
    bundleId: "openpets-sherpa-test",
    bundleVersion: "1.2.3",
    modelId: "openpets-default-en",
    buildInputSha256: "d".repeat(64),
    platforms: {
      [testPlatformId]: {
        helper: helperRelativePath,
        runtimeLibraries: ["lib/sherpa-runtime.bin"],
      },
    },
    keyword: {
      encoder: "models/kws/encoder.onnx",
      decoder: "models/kws/decoder.onnx",
      joiner: "models/kws/joiner.onnx",
      bpeModel: "models/kws/bpe.model",
      tokens: "models/kws/tokens.txt",
    },
    vad: { model: "models/vad/silero_vad.onnx" },
    sources: [{
      id: "fixture",
      version: "1.0.0",
      url: "https://example.com/fixture.tar.gz",
      sha256: "a".repeat(64),
      license: "MIT",
    }],
    files: files.map((file) => ({
      role: file.role,
      path: file.path,
      sha256: createHash("sha256").update(file.content).digest("hex"),
      bytes: Buffer.byteLength(file.content),
      sourceId: "fixture",
    })),
  }));
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1) await tick();
  assert.equal(predicate(), true, "timed out waiting for wake helper event");
}

await main();
