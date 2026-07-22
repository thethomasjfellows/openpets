import assert from "node:assert/strict";

import {
  acquireDefaultPetConversationPresentation,
  isDefaultPetConversationPresentationActive,
} from "../src/pet-presentation-ownership.js";

assert.equal(isDefaultPetConversationPresentationActive(), false);
const releaseFirst = acquireDefaultPetConversationPresentation();
const releaseSecond = acquireDefaultPetConversationPresentation();
assert.equal(isDefaultPetConversationPresentationActive(), true, "a voice conversation blocks background pet reactions");
releaseFirst();
assert.equal(isDefaultPetConversationPresentationActive(), true, "a stale release cannot clear a newer conversation owner");
releaseFirst();
releaseSecond();
assert.equal(isDefaultPetConversationPresentationActive(), false, "background reactions resume after every conversation lease ends");

console.log("pet conversation presentation ownership verified");
