import assert from "node:assert/strict";

import { buildCompanionCharacterGenerationPrompt, parseCompanionCharacterDraft } from "../src/companion-character-generation.js";
import type { CompanionCharacterProfile } from "../src/companion-settings.js";

const draft: CompanionCharacterProfile = {
  visibleName: "Pedra",
  species: "",
  origin: "A sunlit reef",
  appearance: "",
  personality: "Warm and direct",
  quirks: "",
  lifeStory: "",
};

// Contract: Complete Character preserves every user-authored field and fills
// only blanks, while Reimagine requires a complete structured identity.
const generated = JSON.stringify({
  visibleName: "Replacement",
  species: "Solar sprite",
  origin: "Somewhere else",
  appearance: "Flame hair and a star shirt",
  personality: "Different",
  quirks: "Counts clouds",
  lifeStory: "Once guarded a tiny lighthouse.",
});
const completed = parseCompanionCharacterDraft(generated, { mode: "complete", draft });
assert.equal(completed.visibleName, "Pedra");
assert.equal(completed.origin, "A sunlit reef");
assert.equal(completed.personality, "Warm and direct");
assert.equal(completed.species, "Solar sprite");

const reimagined = parseCompanionCharacterDraft(generated, { mode: "reimagine", draft });
assert.equal(reimagined.visibleName, "Replacement");
assert.throws(() => parseCompanionCharacterDraft('{"visibleName":"Only a name"}', { mode: "reimagine", draft }), /invalid species|incomplete/);

const prompt = buildCompanionCharacterGenerationPrompt({
  mode: "complete",
  pet: { id: "pedra", displayName: "Pedra", description: "An orange original pet" },
  draft,
  sourceText: "A playful guardian from a warm place",
});
assert.match(prompt, /text|JSON object only/i);
assert.match(prompt, /Original pet name: "Pedra"/);
assert.match(prompt, /Preserve every non-blank draft field exactly/);
assert.doesNotMatch(prompt, /image|screenshot/i, "character generation remains text-only");

console.log("Companion character generation validation passed.");
