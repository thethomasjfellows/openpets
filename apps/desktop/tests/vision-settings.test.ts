import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getVisionSettings,
  initializeVisionSettings,
  isVisionPaused,
  pauseVisionFor,
  resumeVision,
  setVisionEnabled,
  visionSettingsFileName,
} from "../src/vision-settings.js";

const root = mkdtempSync(join(tmpdir(), "openpets-vision-settings-"));
const now = 1_800_000_000_000;

try {
  const defaults = initializeVisionSettings(root, now);
  assert.deepEqual(defaults, { version: 1, enabled: false }, "Vision must require a fresh explicit opt-in");

  const enabled = setVisionEnabled(true, now);
  assert.equal(enabled.enabled, true);
  const paused = pauseVisionFor(30, now);
  assert.equal(paused.pausedUntil, now + 30 * 60 * 1_000);
  assert.equal(isVisionPaused(paused, now), true);

  const resumed = resumeVision(now);
  assert.equal(resumed.enabled, true);
  assert.equal(resumed.pausedUntil, undefined);

  pauseVisionFor(90, now);
  const disabled = setVisionEnabled(false, now);
  assert.deepEqual(disabled, { version: 1, enabled: false }, "disabling clears pause state");

  const persisted = JSON.parse(readFileSync(join(root, visionSettingsFileName), "utf8"));
  assert.deepEqual(persisted, { version: 1, enabled: false });

  writeFileSync(join(root, visionSettingsFileName), JSON.stringify({
    version: 1,
    enabled: true,
    pausedUntil: now - 1,
    context: { screenEnabled: true },
  }));
  assert.deepEqual(initializeVisionSettings(root, now), { version: 1, enabled: true }, "expired pauses are dropped");

  writeFileSync(join(root, visionSettingsFileName), JSON.stringify({
    version: 1,
    enabled: false,
    pausedUntil: now + 60_000,
    screenEnabled: true,
  }));
  assert.deepEqual(initializeVisionSettings(root, now), { version: 1, enabled: false }, "stale screen fields never grant consent");
  assert.deepEqual(getVisionSettings(now), { version: 1, enabled: false });

  console.log("Vision settings behavior verified");
} finally {
  rmSync(root, { recursive: true, force: true });
}
