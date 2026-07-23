import assert from "node:assert/strict";

import { isScreenDependentCompanionTurn } from "../src/companion-screen-intent.js";

for (const text of [
  "What is on my screen?",
  "Look at this error",
  "Can you check the other monitor?",
  "What am I working on?",
  "Tell me about this chart",
]) {
  assert.equal(isScreenDependentCompanionTurn(text), true, text);
}

for (const text of [
  "How are you today?",
  "What time is it?",
  "Tell me a short joke",
  "Do you remember our lunch chat?",
  "Can you check my reminders?",
  "Could you read me a joke?",
  "Can you look into that later?",
  "How do I build a desktop app?",
  "Can you monitor my progress?",
  "Did you get the email?",
  "Explain the code style",
  "How much screen time is healthy?",
  "How do screen readers work?",
  "What is screen printing?",
  "How do I take a screenshot on Mac?",
  "What is open source software?",
  "What's open telemetry?",
  "What is open enrollment?",
]) {
  assert.equal(isScreenDependentCompanionTurn(text), false, text);
}

console.log("Companion screen-intent routing verified");
