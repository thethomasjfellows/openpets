import assert from "node:assert/strict";

import { getPetVisionStatus } from "../src/renderer/vision-status.js";

assert.equal(getPetVisionStatus({ enabled: false, state: "disabled", captureReady: false, summaryReady: false }), "off");
assert.equal(getPetVisionStatus({ enabled: true, state: "paused", captureReady: true, summaryReady: true }), "paused");
assert.equal(
  getPetVisionStatus({ enabled: true, state: "ready", captureReady: true, summaryReady: true }),
  "working",
  "a fully healthy Pet Vision installation must not retain a setup warning",
);
assert.equal(getPetVisionStatus({ enabled: true, state: "capturing", captureReady: true, summaryReady: true }), "working");
assert.equal(getPetVisionStatus({ enabled: true, state: "ready", captureReady: false, summaryReady: true }), "setup-needed");

console.log("Pet Vision status behavior passed.");
