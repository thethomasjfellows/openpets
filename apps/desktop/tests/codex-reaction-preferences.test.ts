import assert from "node:assert/strict";

import {
  defaultCodexReactionPreferences,
  isCodexLifecycleReactionEnabled,
  normalizeCodexReactionPreferences,
} from "../src/codex-reaction-preferences.js";

// Regression contract: a fresh install stays quiet until a Codex task finishes.
assert.deepEqual(normalizeCodexReactionPreferences(undefined), defaultCodexReactionPreferences);
assert.equal(isCodexLifecycleReactionEnabled(defaultCodexReactionPreferences, "thinking"), false);
assert.equal(isCodexLifecycleReactionEnabled(defaultCodexReactionPreferences, "working"), false);
assert.equal(isCodexLifecycleReactionEnabled(defaultCodexReactionPreferences, "editing"), false);
assert.equal(isCodexLifecycleReactionEnabled(defaultCodexReactionPreferences, "testing"), false);
assert.equal(isCodexLifecycleReactionEnabled(defaultCodexReactionPreferences, "waiting"), false);
assert.equal(isCodexLifecycleReactionEnabled(defaultCodexReactionPreferences, "success"), true);
assert.equal(isCodexLifecycleReactionEnabled(defaultCodexReactionPreferences, "error"), true);

const allEnabled = normalizeCodexReactionPreferences({ taskStarted: true, taskWorking: true, taskCompleted: true });
assert.equal(isCodexLifecycleReactionEnabled(allEnabled, "thinking"), true);
assert.equal(isCodexLifecycleReactionEnabled(allEnabled, "editing"), true);

console.log("Codex reaction preference tests passed.");
