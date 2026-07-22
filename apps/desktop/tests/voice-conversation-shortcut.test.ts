import assert from "node:assert/strict";

import {
  registerVoiceConversationShortcut,
  voiceConversationCancelAccelerator,
} from "../src/voice-conversation-shortcut-core.js";

// Contract: false wakes have a fast global chord that does not consume Escape,
// preserving dictation and other apps' ordinary cancel behavior.
let registered = "";
let unregistered = "";
let callback: (() => void) | null = null;
let cancelled = 0;
const registrar = {
  register(accelerator: string, next: () => void) {
    registered = accelerator;
    callback = next;
    return true;
  },
  unregister(accelerator: string) {
    unregistered = accelerator;
  },
};
assert.equal(registerVoiceConversationShortcut(registrar, () => { cancelled += 1; }), true);
assert.equal(registered, "Control+`");
assert.equal(voiceConversationCancelAccelerator, registered);
const invoke = callback as (() => void) | null;
assert.ok(invoke);
invoke();
assert.equal(cancelled, 1);
registrar.unregister(voiceConversationCancelAccelerator);
assert.equal(unregistered, registered);

console.log("voice conversation cancel shortcut verified");
