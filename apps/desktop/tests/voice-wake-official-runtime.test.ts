import assert from "node:assert/strict";

import type { VoiceWakeHelperEvent } from "../src/voice-wake-helper-protocol.js";
import { OfficialVoiceWakeRuntime } from "../src/voice-wake-official-runtime.js";
import type { VoiceWakeRuntime, VoiceWakeRuntimeSession, VoiceWakeRuntimeStartConfig } from "../src/voice-wake-runtime.js";
import type { VoicePcmFrame, VoiceWakeMethod } from "../src/voice-wake-types.js";

class FakeSession implements VoiceWakeRuntimeSession {
  frames = 0;
  resets = 0;
  stopped = false;
  listeners = new Set<(event: VoiceWakeHelperEvent) => void>();
  sendFrame(): void { this.frames += 1; }
  reset(): void { this.resets += 1; }
  async stop(): Promise<void> { this.stopped = true; }
  onEvent(listener: (event: VoiceWakeHelperEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event: VoiceWakeHelperEvent): void { for (const listener of [...this.listeners]) listener(event); }
}

class FakeRuntime implements VoiceWakeRuntime {
  readonly session = new FakeSession();
  starts: VoiceWakeRuntimeStartConfig[] = [];
  constructor(readonly method: VoiceWakeMethod) {}
  health() { return { ready: true, method: this.method }; }
  async start(config: VoiceWakeRuntimeStartConfig): Promise<VoiceWakeRuntimeSession> { this.starts.push(config); return this.session; }
  dispose(): void {}
}

const livekit = new FakeRuntime("livekit-wakeword");
const vad = new FakeRuntime("sherpa-onnx");
const custom = new FakeRuntime("sherpa-onnx");
const runtime = new OfficialVoiceWakeRuntime({ livekit, vad, custom });
const signal = new AbortController().signal;
const selection = { engine: "official-livekit", phraseId: "openpets.hey-pedra.v1", phrase: "Hey Pedra", sensitivity: "easy", signal } as const;
const session = await runtime.start(selection);
const events: VoiceWakeHelperEvent[] = [];
session.onEvent((event) => events.push(event));

livekit.session.emit({ version: 2, type: "keyword", score: 0.9 });
livekit.session.emit({ version: 2, type: "vad", state: "speech-start", score: 1 });
vad.session.emit({ version: 2, type: "keyword", score: 1 });
vad.session.emit({ version: 2, type: "vad", state: "speech-start", score: 1 });
assert.deepEqual(events.map((event) => event.type), ["keyword", "vad"], "only LiveKit can wake and only Sherpa can endpoint official turns");

session.sendFrame({ sampleRate: 16_000, channels: 1, format: "f32", samples: new Float32Array(320), capturedAt: 1 } satisfies VoicePcmFrame);
assert.equal(livekit.session.frames, 1);
assert.equal(vad.session.frames, 1);
session.reset();
assert.equal(livekit.session.resets, 1);
assert.equal(vad.session.resets, 1);
await session.stop();
assert.equal(livekit.session.stopped, true);
assert.equal(vad.session.stopped, true);

const customSession = await runtime.start({ engine: "custom-sherpa", phrase: "Hey Pedro", variants: [], signal });
assert.equal(custom.starts.length, 1, "custom phrases use the explicit Sherpa path");
await customSession.stop();

console.log("official LiveKit wake composition verified");
