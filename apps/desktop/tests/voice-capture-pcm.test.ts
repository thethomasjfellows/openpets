import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import {
  getVoiceCaptureAudioConstraints,
  VoiceCaptureServiceCore,
  type VoiceCapturePcmMessage,
  type VoiceCaptureRuntime,
  type VoiceCaptureWakeStart,
  type VoiceCaptureWindowHandle,
  type VoiceCaptureWindowMode,
} from "../src/voice-capture-core.js";
import type { VoicePcmFrame } from "../src/voice-wake-types.js";

assert.deepEqual(
  getVoiceCaptureAudioConstraints("wake-pcm"),
  { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true },
  "ambient wake capture must preserve a distant wake phrase instead of filtering it as background sound",
);
assert.equal(getVoiceCaptureAudioConstraints("finite-wav").noiseSuppression, true, "bounded command capture keeps speech cleanup enabled");

class FakeIndicator {
  starts = 0;
  stops = 0;

  trackStarted(): void {
    this.starts += 1;
  }

  trackStopped(): void {
    this.stops += 1;
  }
}

class FakeWindow implements VoiceCaptureWindowHandle {
  readonly senderId: number;
  readonly mode: VoiceCaptureWindowMode;
  destroyed = false;
  loaded = false;
  readonly #endedListeners = new Set<(reason: string) => void>();

  constructor(senderId: number, mode: VoiceCaptureWindowMode) {
    this.senderId = senderId;
    this.mode = mode;
  }

  async load(): Promise<void> {
    this.loaded = true;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    this.destroyed = true;
  }

  onUnexpectedEnd(listener: (reason: string) => void): () => void {
    this.#endedListeners.add(listener);
    return () => { this.#endedListeners.delete(listener); };
  }

  crash(reason = "renderer-crashed"): void {
    this.destroyed = true;
    for (const listener of [...this.#endedListeners]) listener(reason);
  }
}

class FakeRuntime implements VoiceCaptureRuntime {
  nowValue = 1_000;
  failWakeStart = false;
  failFiniteWavStart = false;
  deferWakeStart = false;
  deferSavedWakeStart = false;
  resolveWakeStart: (() => void) | null = null;
  prepared: string[] = [];
  cleared: string[] = [];
  windows: FakeWindow[] = [];
  wakeStarts: VoiceCaptureWakeStart[] = [];
  wakeStops = 0;
  finiteWavStarts = 0;
  finiteWavFinishes = 0;
  ipcUnsubscribes = 0;
  #nextSenderId = 10;
  #nextToken = 1;
  #pcmListener: ((message: VoiceCapturePcmMessage) => void) | null = null;

  now(): number {
    return this.nowValue;
  }

  newSessionToken(): string {
    return "wake-token-" + this.#nextToken++;
  }

  preparePartition(partition: string): void {
    this.prepared.push(partition);
  }

  async clearPartition(partition: string): Promise<void> {
    this.cleared.push(partition);
  }

  createWindow(options: { readonly partition: string; readonly mode: VoiceCaptureWindowMode }): VoiceCaptureWindowHandle {
    const window = new FakeWindow(this.#nextSenderId++, options.mode);
    this.windows.push(window);
    return window;
  }

  async startFiniteWav(): Promise<void> {
    this.finiteWavStarts += 1;
    if (this.failFiniteWavStart) throw new Error("WAV acquisition failed");
  }

  async finishFiniteWav(_window: VoiceCaptureWindowHandle, cancelled: boolean): Promise<string> {
    this.finiteWavFinishes += 1;
    return cancelled ? "" : Buffer.alloc(256, 7).toString("base64");
  }

  async startWakePcm(_window: VoiceCaptureWindowHandle, config: VoiceCaptureWakeStart): Promise<{ requestedDevice: boolean; usedDefault: boolean }> {
    this.wakeStarts.push(config);
    if (this.deferSavedWakeStart && config.microphone) await new Promise<void>((resolve) => setTimeout(resolve, 50));
    if (this.deferWakeStart) {
      await new Promise<void>((resolve) => { this.resolveWakeStart = resolve; });
      this.resolveWakeStart = null;
    }
    if (this.failWakeStart) throw new Error("wake acquisition failed");
    return { requestedDevice: Boolean(config.microphone), usedDefault: !config.microphone };
  }

  async stopWakePcm(): Promise<void> {
    this.wakeStops += 1;
  }

  onPcmFrame(listener: (message: VoiceCapturePcmMessage) => void): () => void {
    this.#pcmListener = listener;
    return () => {
      if (this.#pcmListener === listener) this.#pcmListener = null;
      this.ipcUnsubscribes += 1;
    };
  }

  emit(message: VoiceCapturePcmMessage): void {
    this.#pcmListener?.(message);
  }

  get latestWindow(): FakeWindow {
    const window = this.windows.at(-1);
    assert.ok(window);
    return window;
  }

  get latestWakeStart(): VoiceCaptureWakeStart {
    const start = this.wakeStarts.at(-1);
    assert.ok(start);
    return start;
  }
}

await verifyPcmRoutingAndPrivacy();
await verifyThirtyMillisecondFrames();
await verifySingleOwnerAndFiniteWavCapture();
await verifyAcquisitionFailureRecovery();
await verifySavedMicrophoneTimeoutFallback();
await verifyPendingAcquisitionAbort();
await verifyRendererCrashNotification();
await verifyActiveShutdown();

console.log("single-owner wake PCM capture bridge verified");

async function verifyPcmRoutingAndPrivacy(): Promise<void> {
  const runtime = new FakeRuntime();
  const indicator = new FakeIndicator();
  const service = new VoiceCaptureServiceCore(indicator, runtime);
  const session = await service.startWakePcmStream({ frameMs: 20, microphone: { deviceId: "desk-mic" } });
  assert.equal(indicator.starts, 0, "ambient local wake PCM must not show the bounded-request overlay");
  assert.equal(runtime.latestWindow.loaded, true);
  assert.equal(runtime.latestWindow.mode, "wake-pcm");
  assert.equal(runtime.latestWakeStart.microphone?.deviceId, "desk-mic", "the selected microphone reaches the capture runtime");
  assert.deepEqual(session.microphone, { requestedDevice: true, usedDefault: false }, "the resolved microphone is observable without exposing audio");

  const received: VoicePcmFrame[] = [];
  session.onFrame(() => { throw new Error("listener failure"); });
  session.onFrame((frame) => { received.push(frame); });
  const payload = validPayload(runtime, 20);
  payload.samples[0] = Number.NaN;
  payload.samples[1] = 2;
  runtime.emit({ senderId: runtime.latestWindow.senderId, payload });
  assert.equal(received.length, 1, "one failing observer does not block other observers");
  assert.equal(received[0]?.sampleRate, 16_000);
  assert.equal(received[0]?.channels, 1);
  assert.equal(received[0]?.format, "f32");
  assert.equal(received[0]?.samples.length, 320);
  assert.equal(received[0]?.samples[0], 0);
  assert.equal(received[0]?.samples[1], 1);

  const validCount = received.length;
  runtime.emit({ senderId: runtime.latestWindow.senderId + 1, payload });
  runtime.emit({ senderId: runtime.latestWindow.senderId, payload: { ...payload, generation: payload.generation + 1 } });
  runtime.emit({ senderId: runtime.latestWindow.senderId, payload: { ...payload, sessionToken: "wrong-token" } });
  runtime.emit({ senderId: runtime.latestWindow.senderId, payload: { ...payload, frameMs: 30 } });
  runtime.emit({ senderId: runtime.latestWindow.senderId, payload: { ...payload, samples: new Float32Array(319) } });
  assert.equal(received.length, validCount, "wrong sender, token, generation, duration, and size are ignored");

  await session.stop("test-stop");
  await session.stop("test-stop-again");
  assert.equal(runtime.wakeStops, 1, "wake stop is idempotent");
  assert.equal(indicator.stops, 0);
  runtime.emit({ senderId: runtime.latestWindow.senderId, payload });
  assert.equal(received.length, validCount, "late frames are ignored after stop");
  await service.shutdown();
  assert.equal(runtime.ipcUnsubscribes, 1);
}

async function verifySavedMicrophoneTimeoutFallback(): Promise<void> {
  const runtime = new FakeRuntime();
  runtime.deferSavedWakeStart = true;
  const service = new VoiceCaptureServiceCore(new FakeIndicator(), runtime, () => undefined, {
    savedMicrophoneAcquisitionTimeoutMs: 10,
    microphoneAcquisitionTimeoutMs: 100,
  });
  const session = await service.startWakePcmStream({ frameMs: 20, microphone: { deviceId: "stalled-mic" } });
  assert.equal(runtime.wakeStarts.length, 2, "a stalled saved device is retried once with System Default");
  assert.equal(runtime.wakeStarts[0]?.microphone?.deviceId, "stalled-mic");
  assert.equal(runtime.wakeStarts[1]?.microphone, undefined);
  assert.deepEqual(session.microphone, {
    requestedDevice: true,
    usedDefault: true,
    fallbackReason: "saved-device-unavailable",
  });
  await session.stop();
  await service.shutdown();
}

async function verifyThirtyMillisecondFrames(): Promise<void> {
  const runtime = new FakeRuntime();
  const indicator = new FakeIndicator();
  const service = new VoiceCaptureServiceCore(indicator, runtime);
  const session = await service.startWakePcmStream({ frameMs: 30 });
  const received: VoicePcmFrame[] = [];
  session.onFrame((frame) => { received.push(frame); });
  runtime.emit({
    senderId: runtime.latestWindow.senderId,
    payload: validPayload(runtime, 30),
  });
  assert.equal(received[0]?.samples.length, 480);
  await session.stop();
  await service.shutdown();
}

async function verifySingleOwnerAndFiniteWavCapture(): Promise<void> {
  const runtime = new FakeRuntime();
  const indicator = new FakeIndicator();
  const service = new VoiceCaptureServiceCore(indicator, runtime);

  const wake = await service.startWakePcmStream({ frameMs: 20 });
  await assert.rejects(() => service.start("plugin-listen", 1_000), /already in progress/i);
  await wake.stop();

  const finiteCapture = await service.start("plugin-listen", 1_000);
  await assert.rejects(() => service.startWakePcmStream({ frameMs: 20 }), /already in progress/i);
  runtime.nowValue = 1_750;
  const capture = await finiteCapture.stop();
  assert.equal(capture.mimeType, "audio/wav");
  assert.equal(capture.bytes.byteLength, 256);
  assert.equal(capture.durationMs, 750);
  assert.equal(await finiteCapture.result, capture);
  assert.equal(runtime.finiteWavStarts, 1);
  assert.equal(runtime.finiteWavFinishes, 1);
  assert.equal(indicator.starts, 1, "only the bounded user-command capture uses the custom privacy overlay");
  assert.equal(indicator.stops, 1);

  const cancelled = await service.start("plugin-listen", 1_000);
  const rejection = assert.rejects(cancelled.result, /cancelled/i);
  await cancelled.cancel("test-cancel");
  await rejection;
  await service.shutdown();
}

async function verifyAcquisitionFailureRecovery(): Promise<void> {
  const runtime = new FakeRuntime();
  runtime.failWakeStart = true;
  const indicator = new FakeIndicator();
  const service = new VoiceCaptureServiceCore(indicator, runtime);
  await assert.rejects(() => service.startWakePcmStream({ frameMs: 20 }), /wake acquisition failed/i);
  assert.equal(indicator.starts, 0);
  assert.equal(indicator.stops, 0);
  assert.equal(runtime.latestWindow.destroyed, true);
  assert.equal(runtime.cleared.length, 1);

  runtime.failWakeStart = false;
  const recovered = await service.startWakePcmStream({ frameMs: 20 });
  await recovered.stop();
  assert.equal(indicator.starts, 0);
  assert.equal(indicator.stops, 0);
  await service.shutdown();
}

async function verifyPendingAcquisitionAbort(): Promise<void> {
  const runtime = new FakeRuntime();
  runtime.deferWakeStart = true;
  const indicator = new FakeIndicator();
  const service = new VoiceCaptureServiceCore(indicator, runtime);
  const controller = new AbortController();
  const pending = service.startWakePcmStream({ frameMs: 20, signal: controller.signal });
  await waitFor(() => runtime.resolveWakeStart !== null);
  const releaseWakeStart = runtime.resolveWakeStart as (() => void) | null;
  assert.ok(releaseWakeStart);

  controller.abort();
  await waitFor(() => runtime.latestWindow.destroyed && runtime.cleared.length === 1);
  assert.equal(runtime.wakeStops, 1, "abort immediately stops pending renderer acquisition");
  assert.equal(indicator.starts, 0);
  assert.equal(indicator.stops, 0);

  releaseWakeStart();
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
  await service.shutdown();
}

async function verifyRendererCrashNotification(): Promise<void> {
  const runtime = new FakeRuntime();
  const indicator = new FakeIndicator();
  const service = new VoiceCaptureServiceCore(indicator, runtime);
  const session = await service.startWakePcmStream({ frameMs: 20 });
  const reasons: string[] = [];
  session.onEnded?.((reason) => { reasons.push(reason); });
  const payload = validPayload(runtime, 20);
  runtime.latestWindow.crash("renderer-crashed");
  await waitFor(() => reasons.length === 1);
  assert.deepEqual(reasons, ["renderer-crashed"]);
  assert.equal(indicator.stops, 0);
  runtime.emit({ senderId: runtime.latestWindow.senderId, payload });
  assert.equal(runtime.cleared.length, 1);
  await service.shutdown();
}

async function verifyActiveShutdown(): Promise<void> {
  const runtime = new FakeRuntime();
  const indicator = new FakeIndicator();
  const service = new VoiceCaptureServiceCore(indicator, runtime);
  await service.startWakePcmStream({ frameMs: 20 });
  await service.shutdown();
  await service.shutdown();
  assert.equal(runtime.wakeStops, 1);
  assert.equal(indicator.starts, 0);
  assert.equal(indicator.stops, 0);
  assert.equal(runtime.ipcUnsubscribes, 1);
  await assert.rejects(() => service.startWakePcmStream({ frameMs: 20 }), /shut down/i);
}

function validPayload(runtime: FakeRuntime, frameMs: 20 | 30): {
  generation: number;
  sessionToken: string;
  frameMs: 20 | 30;
  capturedAt: number;
  samples: Float32Array;
} {
  const start = runtime.latestWakeStart;
  return {
    generation: start.generation,
    sessionToken: start.sessionToken,
    frameMs,
    capturedAt: runtime.nowValue,
    samples: new Float32Array(frameMs === 20 ? 320 : 480).fill(0.25),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(predicate(), true, "timed out waiting for capture teardown");
}
