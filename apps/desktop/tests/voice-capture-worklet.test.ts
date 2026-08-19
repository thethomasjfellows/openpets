import assert from "node:assert/strict";
import vm from "node:vm";

import { createVoiceCaptureWorkletSource, voiceCaptureWorkletProcessorName } from "../src/voice-capture-worklet.js";

type WorkletProcessorInstance = {
  process(inputs: Float32Array[][]): boolean;
};

type WorkletProcessorConstructor = new (options: {
  readonly processorOptions: { readonly frameSamples: number };
}) => WorkletProcessorInstance;

const messages: Float32Array[] = [];
let registeredName = "";
let RegisteredProcessor: WorkletProcessorConstructor | null = null;

class FakeAudioWorkletProcessor {
  readonly port = {
    postMessage(data: unknown): void {
      assert.ok(data instanceof Float32Array);
      messages.push(new Float32Array(data));
    },
  };
}

const context = vm.createContext({
  AudioWorkletProcessor: FakeAudioWorkletProcessor,
  Float32Array,
  Math,
  Number,
  registerProcessor(name: string, processor: WorkletProcessorConstructor) {
    registeredName = name;
    RegisteredProcessor = processor;
  },
  sampleRate: 48_000,
});
new vm.Script(createVoiceCaptureWorkletSource()).runInContext(context);

assert.equal(registeredName, voiceCaptureWorkletProcessorName);
assert.ok(RegisteredProcessor, "worklet processor registers");

const twentyMsProcessor = createProcessor(320);
feedStereo(twentyMsProcessor, 8, 0.75, -0.25);
assert.ok(messages.length >= 1);
assert.equal(messages[0]?.length, 320, "20 ms frames contain exactly 320 samples");
for (const value of messages[0] ?? []) assert.ok(Math.abs(value - 0.25) < 0.0001, "stereo input is mixed to mono before resampling");

messages.length = 0;
const thirtyMsProcessor = createProcessor(480);
feedStereo(thirtyMsProcessor, 12, 2, 2);
assert.ok(messages.length >= 1);
assert.equal(messages[0]?.length, 480, "30 ms frames contain exactly 480 samples");
for (const value of messages[0] ?? []) assert.equal(value, 1, "worklet output is clamped to the PCM contract");

messages.length = 0;
RegisteredProcessor = null;
const fortyFourKhzContext = vm.createContext({
  AudioWorkletProcessor: FakeAudioWorkletProcessor,
  Float32Array,
  Math,
  Number,
  registerProcessor(name: string, processor: WorkletProcessorConstructor) {
    registeredName = name;
    RegisteredProcessor = processor;
  },
  sampleRate: 44_100,
});
new vm.Script(createVoiceCaptureWorkletSource()).runInContext(fortyFourKhzContext);
const fortyFourKhzProcessor = createProcessor(320);
feedStereo(fortyFourKhzProcessor, 9, 0.75, -0.25);
assert.ok(messages.length >= 1);
assert.equal(messages[0]?.length, 320, "44.1 kHz input is resampled into exact 20 ms frames");
for (const value of messages[0] ?? []) assert.ok(Math.abs(value - 0.25) < 0.0001);

console.log("wake PCM AudioWorklet framing verified");

function createProcessor(frameSamples: 320 | 480): WorkletProcessorInstance {
  const Constructor = RegisteredProcessor as WorkletProcessorConstructor | null;
  assert.ok(Constructor);
  return new Constructor({ processorOptions: { frameSamples } });
}

function feedStereo(processor: WorkletProcessorInstance, chunks: number, leftValue: number, rightValue: number): void {
  for (let chunk = 0; chunk < chunks; chunk += 1) {
    const left = new Float32Array(128).fill(leftValue);
    const right = new Float32Array(128).fill(rightValue);
    assert.equal(processor.process([[left, right]]), true);
  }
}
