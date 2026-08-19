import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PluginSecretsStore } from "../src/plugin-secrets.js";
import { LocalTranscriptionService } from "../src/voice-local-transcription.js";
import { VoiceOpenAiTranscriptionGateway } from "../src/voice-openai-transcription.js";
import { getVoiceTranscriptionSettings, initializeVoiceTranscriptionSettings, updateVoiceTranscriptionSettings } from "../src/voice-transcription-settings.js";

const root = mkdtempSync(join(tmpdir(), "openpets-transcription-"));
try {
  initializeVoiceTranscriptionSettings(root);
  assert.equal(getVoiceTranscriptionSettings().providerId, "local", "new users should see the keyless local option first");
  const local = new LocalTranscriptionService({ userDataPath: root, resourcesPath: join(root, "missing-resources") });
  assert.equal(local.snapshot().status, "not-installed");
  assert.equal(local.snapshot().offlineAfterInstall, true);
    assert.equal((await local.health()).ready, false, "wake listening must not arm before the local model is installed");
  updateVoiceTranscriptionSettings({ providerId: "openai" });
  assert.equal(getVoiceTranscriptionSettings().baseUrl, "https://api.openai.com/v1");
  assert.equal(getVoiceTranscriptionSettings().model, "whisper-1");
  assert.throws(() => updateVoiceTranscriptionSettings({ provider: "ollama" }), /invalid speech recognition setting/i, "legacy AI-provider fields cannot become the speech recognition path");

  let apiKey: string | undefined;
  const secrets = {
    async has() { return Boolean(apiKey); },
    async get() { return apiKey; },
  } as unknown as PluginSecretsStore;
  let requestedUrl = "";
  let authorization = "";
  const gateway = new VoiceOpenAiTranscriptionGateway(secrets, (async (input, init) => {
    requestedUrl = String(input);
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(JSON.stringify({ text: "  hello Pedra  " }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch);

  const missingKey = await gateway.health();
  assert.equal(missingKey.ready, false);
  assert.match(missingKey.reason ?? "", /API key/i);

  apiKey = "test-key";
  assert.equal((await gateway.health()).ready, true);
  const text = await gateway.transcribe(Uint8Array.from([1, 2, 3]), "audio/wav");
  assert.equal(text, "  hello Pedra  ");
  assert.equal(requestedUrl, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(authorization, "Bearer test-key");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("Speech recognition settings passed.");
