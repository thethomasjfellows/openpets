import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeCompanionSettings, updateCompanionSettings } from "../src/companion-settings.js";
import { initializeHostAiSettings, setActiveHostAiProvider } from "../src/host-ai-settings.js";
import type { HostAiImageOptions } from "../src/host-ai-gateway.js";
import { VisionAiRouter } from "../src/vision-ai-router.js";
import type { VisionAiGateway } from "../src/vision-service.js";
import { initializeVisionSettings, setVisionModelPreference } from "../src/vision-settings.js";

const root = mkdtempSync(join(tmpdir(), "openpets-vision-router-"));
const calls: Array<{ gateway: "codex" | "host-ai"; options?: HostAiImageOptions }> = [];

function fakeGateway(gateway: "codex" | "host-ai"): VisionAiGateway {
  return {
    async summarizeImage(_request, options) {
      calls.push({ gateway, options });
      return { text: "summary", provider: gateway === "codex" ? "codex" : "openai", model: options?.model ?? "default" };
    },
    async getImageSummaryHealthSnapshot(options) {
      calls.push({ gateway, options });
      return { status: "ready", configured: true, ready: true, provider: gateway === "codex" ? "codex" : "openai", model: options?.model ?? "default", stale: false };
    },
    async probeImageSummary(options) {
      calls.push({ gateway, options });
      return { status: "ready", configured: true, ready: true, provider: gateway === "codex" ? "codex" : "openai", model: options?.model ?? "default", stale: false };
    },
    invalidateImageSummaryHealth() {},
  };
}

try {
  initializeCompanionSettings(root);
  initializeHostAiSettings(root);
  initializeVisionSettings(root);
  const router = new VisionAiRouter(fakeGateway("codex"), fakeGateway("host-ai"));

  setVisionModelPreference({ owner: "host-ai", provider: "openai", model: "host-vision" });
  await router.probeImageSummary({ force: true });
  assert.deepEqual(
    calls.pop(),
    { gateway: "host-ai", options: { force: true, provider: "openai", model: "host-vision" } },
    "a Vision override may use a configured provider independently from the conversation brain",
  );

  setVisionModelPreference({ owner: "codex", model: "codex-vision" });
  await router.probeImageSummary({ force: true });
  assert.deepEqual(calls.pop(), { gateway: "codex", options: { force: true, model: "codex-vision" } }, "a Codex Vision override stays inside Codex");

  updateCompanionSettings({ target: "host-ai" });
  setActiveHostAiProvider("openai");
  setVisionModelPreference({ owner: "host-ai", provider: "openai", model: "host-vision" });
  await router.probeImageSummary({ force: true });
  assert.deepEqual(calls.pop(), { gateway: "host-ai", options: { force: true, provider: "openai", model: "host-vision" } });

  setActiveHostAiProvider("anthropic");
  await router.probeImageSummary({ force: true });
  assert.deepEqual(
    calls.pop(),
    { gateway: "host-ai", options: { force: true, provider: "openai", model: "host-vision" } },
    "the explicit Vision override remains stable when the conversation provider changes",
  );

  setVisionModelPreference(undefined);
  await router.probeImageSummary({ force: true });
  assert.deepEqual(
    calls.pop(),
    { gateway: "host-ai", options: { force: true, provider: "anthropic" } },
    "without an override, Vision follows the active AI Brain",
  );

  console.log("Vision AI routing boundaries verified");
} finally {
  rmSync(root, { recursive: true, force: true });
}
