import assert from "node:assert/strict";

import { VoiceWakeWordService } from "../src/voice-wake-word-service.js";

const wake = new VoiceWakeWordService();
const health = wake.health();
assert.equal(health.ready, false);
assert.equal(health.enabled, false);
assert.match(health.reason ?? "", /no approved local runtime/i);
const snapshot = wake.snapshot();
assert.equal(snapshot.armed, false);
assert.equal(snapshot.captureState, "blocked");
assert.equal(snapshot.turnState, "idle");
await assert.rejects(() => wake.start(), /not available/i);
assert.equal((await wake.syncFromSettings()).armed, false);
await wake.handlePowerEvent("suspend");
assert.equal(wake.snapshot().captureState, "suspended");
await wake.handlePowerEvent("resume");
assert.equal(wake.snapshot().captureState, "blocked");
await wake.dispose();

const incompletePipeline = new VoiceWakeWordService({
  runtime: {
    health: () => ({ ready: true, method: "sherpa-onnx" }),
    async start() { throw new Error("should not start"); },
    dispose() {},
  },
});
assert.equal(incompletePipeline.health().ready, false);
assert.match(incompletePipeline.health().reason ?? "", /capture is not available/i);
await incompletePipeline.dispose();

console.log("wake-word runtime availability boundary verified");
