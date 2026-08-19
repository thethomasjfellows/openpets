import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  companionSettingsFileName,
  disableCompanion,
  enableCompanion,
  getCompanionSettings,
  initializeCompanionSettings,
  companionCharacterFieldLimits,
  maxCompanionAboutYouCharacters,
  normalizeCompanionSettings,
  removeCompanionCharacterSettings,
  updateCompanionCharacterSettings,
  updateCompanionSettings,
} from "../src/companion-settings.js";

// Contract: malformed persisted data cannot bypass the disclosure gate or
// escape the small user-authored profile/personality bounds.
const normalized = normalizeCompanionSettings({
  consentVersion: 0,
  enabled: true,
  target: "arbitrary-provider",
  codex: { model: `  ${"m".repeat(200)}  `, reasoningEffort: `  ${"e".repeat(80)}  ` },
  profile: {
    name: `  ${"n".repeat(200)}  `,
    preferredAddress: 42,
    goals: [" Hydrate ", "hydrate", ...Array.from({ length: 10 }, (_, index) => `Goal ${index}`)],
  },
  pets: {
    pedra: { personality: ` ${"p".repeat(1_000)} ` },
    "../../unsafe": { personality: "ignored" },
  },
  proactivity: { enabled: true, frequency: "constantly" },
  context: { screenEnabled: true },
});
assert.equal(normalized.enabled, false);
assert.equal(normalized.target, "codex");
assert.equal(normalized.codex.model.length, 120);
assert.equal(normalized.codex.reasoningEffort.length, 40);
assert.equal(normalized.profile.name.length, 120);
assert.equal(normalized.profile.preferredAddress, "");
assert.ok(normalized.profile.aboutYou.length <= maxCompanionAboutYouCharacters);
assert.match(normalized.profile.aboutYou, /Hydrate/);
assert.equal(normalized.characters.pedra?.personality.length, companionCharacterFieldLimits.personality);
assert.equal(normalized.characters["../../unsafe"], undefined);
assert.equal(normalized.proactivity.frequency, "sometimes");
assert.equal(normalized.wake.followUpEnabled, true, "follow-up listening is the forward default for older settings files");

const root = mkdtempSync(join(tmpdir(), "openpets-companion-settings-"));
try {
  initializeCompanionSettings(root);
  assert.equal(getCompanionSettings().enabled, false);
  assert.equal(getCompanionSettings().memory.enabled, false);
  assert.equal(getCompanionSettings().proactivity.enabled, false);

  // Contract: generic settings patches cannot grant consent or activate the
  // feature without the disclosure-backed enable operation.
  updateCompanionSettings({ enabled: true, consentVersion: 1, profile: { name: "Thomas" }, target: "host-ai" });
  assert.equal(getCompanionSettings().consentVersion, 0);
  assert.equal(getCompanionSettings().enabled, false);

  updateCompanionCharacterSettings("pedra", { visibleName: "Pedra do Sol", personality: "Curious, warm, and gently opinionated." });
  const firstEnable = enableCompanion();
  assert.equal(firstEnable.consentVersion, 1);
  assert.equal(firstEnable.enabled, true);
  assert.equal(firstEnable.memory.enabled, true);
  assert.deepEqual(firstEnable.proactivity, { enabled: true, frequency: "sometimes" });
  assert.equal(firstEnable.wake.enabled, false);
  assert.equal(firstEnable.wake.followUpEnabled, true);
  assert.equal(firstEnable.profile.name, "Thomas");
  assert.equal(firstEnable.target, "host-ai");
  assert.equal(firstEnable.characters.pedra?.visibleName, "Pedra do Sol");
  assert.equal(firstEnable.characters.pedra?.personality, "Curious, warm, and gently opinionated.");

  // Contract: the first-enable defaults are one complete persisted snapshot.
  const persisted = JSON.parse(readFileSync(join(root, companionSettingsFileName), "utf8")) as typeof firstEnable;
  assert.deepEqual(persisted, firstEnable);

  // Contract: independently reversible choices survive later disable/re-enable
  // cycles and are not reset to first-enable defaults again.
  disableCompanion();
  updateCompanionSettings({
    memory: { enabled: false },
    proactivity: { enabled: true, frequency: "rarely" },
    wake: { enabled: true, followUpEnabled: false },
  });
  const reenabled = enableCompanion();
  assert.equal(reenabled.memory.enabled, false);
  assert.deepEqual(reenabled.proactivity, { enabled: true, frequency: "rarely" });
  assert.equal(reenabled.wake.enabled, true, "explicit wake preference survives temporary runtime unavailability");
  assert.equal(reenabled.wake.followUpEnabled, false, "follow-up preference survives disable and re-enable");

  removeCompanionCharacterSettings("pedra");
  assert.equal(getCompanionSettings().characters.pedra, undefined);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("Companion settings validation passed.");
