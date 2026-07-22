import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultPocketTtsSettings,
  getPocketTtsSettings,
  initializePocketTtsSettings,
  managedPocketTtsVersion,
  pocketTtsSettingsFileName,
  updatePocketTtsSettings,
} from "../src/pockettts-settings.js";

const root = mkdtempSync(join(tmpdir(), "openpets-pockettts-settings-"));

try {
  assert.deepEqual(
    initializePocketTtsSettings(root),
    defaultPocketTtsSettings,
    "PocketTTS must not download or enable itself without an explicit user action",
  );

  assert.equal(
    updatePocketTtsSettings({ enabled: true }).enabled,
    false,
    "enabled cannot become true until a completed install is recorded",
  );

  const installedAt = 1_800_000_000_000;
  const installed = updatePocketTtsSettings({ installedAt, enabled: true });
  assert.deepEqual(installed, {
    version: 1,
    enabled: true,
    packageVersion: managedPocketTtsVersion,
    host: "127.0.0.1",
    port: 8000,
    installedAt,
  });
  assert.deepEqual(JSON.parse(readFileSync(join(root, pocketTtsSettingsFileName), "utf8")), installed);

  writeFileSync(join(root, pocketTtsSettingsFileName), JSON.stringify({
    enabled: true,
    installedAt,
    host: "0.0.0.0",
    port: 9999,
    baseUrl: "https://untrusted.example",
  }));
  assert.deepEqual(
    initializePocketTtsSettings(root),
    installed,
    "managed PocketTTS always stays on its fixed loopback-only address",
  );
  assert.deepEqual(getPocketTtsSettings(), installed);

  console.log("PocketTTS explicit install and loopback settings verified");
} finally {
  rmSync(root, { recursive: true, force: true });
}
