import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HostAiGateway,
  hostAiApiKeySecret,
  hostAiApiKeySecretForProvider,
  hostSecretsOwner,
  migrateLegacyHostAiApiKey,
  type HostAiSecrets,
} from "../src/host-ai-gateway.js";
import { initializeHostAiSettings, updateHostAiProviderConfig, updateHostAiSettings } from "../src/host-ai-settings.js";
import { PluginAiGateway } from "../src/plugin-ai-gateway.js";

let secret: string | undefined = "test-key";
const secrets: HostAiSecrets = {
  async get(owner, key) {
    assert.equal(owner, "__openpets-host");
    assert.match(key, /^ai-api-key:(?:anthropic|openai|openrouter|ollama|custom)$/);
    return secret;
  },
};

const migrationUserData = mkdtempSync(join(tmpdir(), "openpets-host-ai-secret-migration-"));
initializeHostAiSettings(migrationUserData);
updateHostAiSettings({ provider: "openai", model: "gpt-test", baseUrl: "https://api.openai.com/v1" });
const migratedSecrets = new Map<string, string>([[hostAiApiKeySecret, "legacy-key"]]);
const migrationResult = await migrateLegacyHostAiApiKey({
  async get(_owner, key) { return migratedSecrets.get(key); },
  async has(_owner, key) { return migratedSecrets.has(key); },
  async set(_owner, key, value) { migratedSecrets.set(key, value); },
  async delete(_owner, key) { migratedSecrets.delete(key); },
});
assert.deepEqual(migrationResult, { migrated: true, provider: "openai" });
assert.equal(migratedSecrets.get(hostAiApiKeySecretForProvider("openai")), "legacy-key");
assert.equal(migratedSecrets.has(hostAiApiKeySecret), false);

// A new provider-specific credential always wins over the retired shared slot.
migratedSecrets.set(hostAiApiKeySecret, "stale-legacy-key");
migratedSecrets.set(hostAiApiKeySecretForProvider("openai"), "current-key");
assert.deepEqual(await migrateLegacyHostAiApiKey({
  async get(_owner, key) { return migratedSecrets.get(key); },
  async has(_owner, key) { return migratedSecrets.has(key); },
  async set(_owner, key, value) { migratedSecrets.set(key, value); },
  async delete(_owner, key) { migratedSecrets.delete(key); },
}), { migrated: false });
assert.equal(migratedSecrets.get(hostAiApiKeySecretForProvider("openai")), "current-key");
assert.equal(migratedSecrets.has(hostAiApiKeySecret), false);

const healthUserData = mkdtempSync(join(tmpdir(), "openpets-host-ai-health-"));
initializeHostAiSettings(healthUserData);
updateHostAiSettings({ provider: "openai", model: "gpt-test" });

let now = 1_000;
const probeCalls: Array<{ url: string; init?: RequestInit }> = [];
const probeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  probeCalls.push({ url, init });
  if (url === "https://openrouter.ai/api/v1/models") return Response.json({ data: [] });
  if (url === "http://127.0.0.1:11434/v1/models") return Response.json({ data: [{ id: "llama-test" }] });
  return new Response(null, { status: 204 });
}) as typeof fetch;
const healthGateway = new HostAiGateway(secrets, { fetch: probeFetch, now: () => now, healthTtlMs: 100 });

const beforeProbe = await healthGateway.getHealthSnapshot();
assert.equal(beforeProbe.status, "configured-unverified");
assert.equal(beforeProbe.configured, true);
assert.equal(beforeProbe.ready, false);
assert.equal(beforeProbe.baseUrl, "https://api.openai.com/v1");

const ready = await healthGateway.probeHealth();
assert.equal(ready.status, "ready");
assert.equal(ready.ready, true);
assert.equal(ready.evidence, "openai-model");
assert.equal(probeCalls[0]?.url, "https://api.openai.com/v1/models/gpt-test");
assert.equal(new Headers(probeCalls[0]?.init?.headers).get("authorization"), "Bearer test-key");
await healthGateway.probeHealth();
assert.equal(probeCalls.length, 1);
now += 101;
assert.equal((await healthGateway.getHealthSnapshot()).stale, true);
await healthGateway.probeHealth();
assert.equal(probeCalls.length, 2);
await healthGateway.probeHealth({ force: true });
assert.equal(probeCalls.length, 3);

updateHostAiSettings({ provider: "openrouter", model: "openrouter/free" });
const openRouter = await healthGateway.probeHealth({ force: true });
assert.equal(openRouter.ready, true);
assert.equal(probeCalls.at(-1)?.url, "https://openrouter.ai/api/v1/models");
assert.equal(new Headers(probeCalls.at(-1)?.init?.headers).get("authorization"), "Bearer test-key");
assert.equal(new Headers(probeCalls.at(-1)?.init?.headers).get("HTTP-Referer"), "https://openpets.dev");
assert.equal(new Headers(probeCalls.at(-1)?.init?.headers).get("X-Title"), "OpenPets");

let catalogHeaders = new Headers();
const catalogGateway = new HostAiGateway(secrets, {
  fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
    catalogHeaders = new Headers(init?.headers);
    return Response.json({ data: [
      { id: "provider/free-model:free", name: "Free Model" },
      { id: "provider/free-model:free", name: "Duplicate" },
      { id: "", name: "Invalid" },
    ] });
  }) as typeof fetch,
});
const catalog = await catalogGateway.listModels("openrouter");
assert.deepEqual(catalog.models, [
  { id: "openrouter/free", name: "OpenRouter Free Models Router" },
  { id: "provider/free-model:free", name: "Free Model" },
]);
assert.equal(catalogHeaders.get("authorization"), "Bearer test-key");
assert.equal(catalogHeaders.get("HTTP-Referer"), "https://openpets.dev");

updateHostAiSettings({ provider: "anthropic", model: "claude-test" });
const anthropic = await healthGateway.probeHealth();
assert.equal(anthropic.evidence, "anthropic-model");
assert.equal(probeCalls.at(-1)?.url, "https://api.anthropic.com/v1/models/claude-test");
assert.equal(new Headers(probeCalls.at(-1)?.init?.headers).get("x-api-key"), "test-key");

secret = undefined;
updateHostAiSettings({ provider: "ollama", model: "llama-test", baseUrl: "http://127.0.0.1:11434/v1/" });
assert.equal(await healthGateway.available(), true);
const ollama = await healthGateway.probeHealth();
assert.equal(ollama.evidence, "openai-compatible-models");
assert.equal(probeCalls.at(-1)?.url, "http://127.0.0.1:11434/v1/models");
assert.equal(new Headers(probeCalls.at(-1)?.init?.headers).has("authorization"), false);

updateHostAiSettings({ provider: "ollama", model: "missing-model", baseUrl: "http://127.0.0.1:11434/v1" });
const missingOllamaModel = await healthGateway.probeHealth({ force: true });
assert.equal(missingOllamaModel.ready, false);
assert.match(missingOllamaModel.error ?? "", /selected model.*not found/i);

updateHostAiSettings({ provider: "custom" });
updateHostAiProviderConfig("custom", { model: "local-chat", baseUrl: "http://127.0.0.1:9000/v1", requiresApiKey: false });
let customHeaders = new Headers();
const customGateway = new HostAiGateway(secrets, {
  fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
    customHeaders = new Headers(init?.headers);
    return Response.json({ choices: [{ message: { content: "local" } }] });
  }) as typeof fetch,
});
assert.equal(await customGateway.available(), true, "a custom local provider may explicitly opt out of API-key auth");
assert.equal((await customGateway.complete({ messages: [{ role: "user", content: "Hi" }] })).text, "local");
assert.equal(customHeaders.has("authorization"), false);

updateHostAiSettings({ provider: "openai", model: "gpt-test" });
assert.equal(await healthGateway.available(), false);
const missingKey = await healthGateway.getHealthSnapshot();
assert.equal(missingKey.status, "unconfigured");
assert.equal(missingKey.configured, false);

secret = "test-key";
const failingGateway = new HostAiGateway(secrets, {
  fetch: (async () => new Response(null, { status: 503 })) as typeof fetch,
});
const failed = await failingGateway.probeHealth();
assert.equal(failed.status, "error");
assert.equal(failed.ready, false);
assert.equal(failed.error, "AI provider probe failed with HTTP 503.");

const completionController = new AbortController();
let completionSignal: AbortSignal | null | undefined;
const completionGateway = new HostAiGateway(secrets, {
  fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
    completionSignal = init?.signal;
    return Response.json({ choices: [{ message: { content: "Hello" } }] });
  }) as typeof fetch,
});
const completion = await completionGateway.complete(
  { messages: [{ role: "user", content: "Hi" }] },
  { signal: completionController.signal },
);
assert.equal(completion.text, "Hello");
assert.equal(completionSignal, completionController.signal);

const transcriptionController = new AbortController();
let transcriptionSignal: AbortSignal | null | undefined;
let transcriptionFileName = "";
const transcriptionGateway = new HostAiGateway(secrets, {
  fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
    transcriptionSignal = init?.signal;
    const entry = init?.body instanceof FormData ? init.body.get("file") : null;
    transcriptionFileName = entry && typeof entry === "object" && "name" in entry ? String(entry.name) : "";
    return Response.json({ text: "heard" });
  }) as typeof fetch,
});
assert.equal(await transcriptionGateway.transcribe(new Uint8Array([1, 2, 3]), "audio/webm", { signal: transcriptionController.signal }), "heard");
assert.equal(transcriptionSignal, transcriptionController.signal);
assert.equal(transcriptionFileName, "speech.webm");
assert.equal(await transcriptionGateway.transcribe(new Uint8Array([1, 2, 3]), "audio/wav"), "heard");
assert.equal(transcriptionFileName, "speech.wav");

let oversizedCompletionCancelled = false;
const oversizedCompletionGateway = new HostAiGateway(secrets, {
  fetch: (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
    cancel() { oversizedCompletionCancelled = true; },
  }), { status: 200 })) as typeof fetch,
});
await assert.rejects(
  () => oversizedCompletionGateway.complete({ messages: [{ role: "user", content: "Hi" }] }),
  /AI response is too large/,
);
assert.equal(oversizedCompletionCancelled, true);

let oversizedTranscriptionCancelled = false;
const oversizedTranscriptionGateway = new HostAiGateway(secrets, {
  fetch: (async () => new Response(new ReadableStream<Uint8Array>({
    cancel() { oversizedTranscriptionCancelled = true; },
  }), { status: 200, headers: { "content-length": String(2 * 1024 * 1024 + 1) } })) as typeof fetch,
});
await assert.rejects(
  () => oversizedTranscriptionGateway.transcribe(new Uint8Array([1, 2, 3]), "audio/webm"),
  /Transcription response is too large/,
);
assert.equal(oversizedTranscriptionCancelled, true);

const streamController = new AbortController();
let streamSignal: AbortSignal | null | undefined;
let streamCancelled = false;
let pullCount = 0;
const encoder = new TextEncoder();
const streamBody = new ReadableStream<Uint8Array>({
  pull(controller) {
    if (pullCount++ === 0) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
      return;
    }
    return new Promise<void>(() => undefined);
  },
  cancel() {
    streamCancelled = true;
  },
});
const streamGateway = new HostAiGateway(secrets, {
  fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
    streamSignal = init?.signal;
    return new Response(streamBody, { status: 200 });
  }) as typeof fetch,
});
const streamed = streamGateway.stream(
  { messages: [{ role: "user", content: "Hi" }] },
  () => undefined,
  { signal: streamController.signal },
);
await new Promise<void>((resolve) => setImmediate(resolve));
streamController.abort();
await assert.rejects(streamed, (error: unknown) => error instanceof Error && error.name === "AbortError");
assert.equal(streamSignal, streamController.signal);
assert.equal(streamCancelled, true);

const preAbortedController = new AbortController();
preAbortedController.abort();
let preAbortedStreamCancelled = false;
const preAbortedGateway = new HostAiGateway(secrets, {
  fetch: (async () => new Response(new ReadableStream<Uint8Array>({
    cancel() { preAbortedStreamCancelled = true; },
  }), { status: 200 })) as typeof fetch,
});
await assert.rejects(
  () => preAbortedGateway.stream(
    { messages: [{ role: "user", content: "Hi" }] },
    () => undefined,
    { signal: preAbortedController.signal },
  ),
  (error: unknown) => error instanceof Error && error.name === "AbortError",
);
assert.equal(preAbortedStreamCancelled, true);

updateHostAiSettings({ provider: "openai", model: "gpt-4o-mini" });
const imageCalls: Array<{ url: string; init?: RequestInit }> = [];
const imageGateway = new HostAiGateway(secrets, {
  fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    imageCalls.push({ url: String(input), init });
    return Response.json({ choices: [{ message: { content: "The user is working in a code editor." } }] });
  }) as typeof fetch,
});
const imageResult = await imageGateway.summarizeImage({
  image: new Uint8Array([137, 80, 78, 71]),
  mimeType: "image/png",
  prompt: "Summarize the visible desktop.",
});
assert.equal(imageResult.text, "The user is working in a code editor.");
assert.equal(imageCalls[0]?.url, "https://api.openai.com/v1/chat/completions");
const openAiImageBody = JSON.parse(String(imageCalls[0]?.init?.body)) as {
  messages: Array<{ content: Array<{ type: string; image_url?: { url?: string } }> }>;
};
assert.equal(openAiImageBody.messages[0]?.content[0]?.type, "text");
assert.match(openAiImageBody.messages[0]?.content[1]?.image_url?.url ?? "", /^data:image\/png;base64,/);
assert.equal((await imageGateway.getImageSummaryHealthSnapshot()).status, "ready");

const probeImageGateway = new HostAiGateway(secrets, {
  fetch: (async () => Response.json({ choices: [{ message: { content: "magenta" } }] })) as typeof fetch,
});
assert.equal((await probeImageGateway.probeImageSummary({ force: true })).status, "ready");

const conversationalProbeImageGateway = new HostAiGateway(secrets, {
  fetch: (async () => Response.json({ choices: [{ message: { content: "It looks pink." } }] })) as typeof fetch,
});
assert.equal(
  (await conversationalProbeImageGateway.probeImageSummary({ force: true })).status,
  "ready",
  "a harmless color synonym or sentence must not reject a working vision model",
);

const imageIgnoringGateway = new HostAiGateway(secrets, {
  fetch: (async () => Response.json({ choices: [{ message: { content: "ready" } }] })) as typeof fetch,
});
const imageIgnoringHealth = await imageIgnoringGateway.probeImageSummary({ force: true });
assert.equal(imageIgnoringHealth.status, "unsupported");
assert.equal(imageIgnoringHealth.ready, false, "a model that answers text without reading the probe image is not Vision-ready");

const emptyImageGateway = new HostAiGateway(secrets, {
  fetch: (async () => Response.json({ choices: [{ message: { content: "   " } }] })) as typeof fetch,
});
await assert.rejects(
  () => emptyImageGateway.summarizeImage({
    image: new Uint8Array([137, 80, 78, 71]),
    mimeType: "image/png",
    prompt: "Summarize.",
  }),
  /empty image summary/i,
);
const emptyImageHealth = await emptyImageGateway.getImageSummaryHealthSnapshot();
assert.equal(emptyImageHealth.status, "error");
assert.equal(emptyImageHealth.ready, false, "empty model output must not advertise image-summary readiness");

updateHostAiSettings({ provider: "anthropic", model: "claude-vision" });
let anthropicImageBody: {
  messages?: Array<{ content?: Array<{ type?: string; source?: { media_type?: string; data?: string } }> }>;
} = {};
const anthropicImageGateway = new HostAiGateway(secrets, {
  fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
    anthropicImageBody = JSON.parse(String(init?.body)) as typeof anthropicImageBody;
    return Response.json({ content: [{ type: "text", text: "A document is open." }] });
  }) as typeof fetch,
});
assert.equal((await anthropicImageGateway.summarizeImage({
  image: new Uint8Array([1, 2, 3]),
  mimeType: "image/png",
  prompt: "Summarize.",
})).text, "A document is open.");
assert.equal(anthropicImageBody.messages?.[0]?.content?.[0]?.type, "image");
assert.equal(anthropicImageBody.messages?.[0]?.content?.[0]?.source?.media_type, "image/png");

updateHostAiSettings({ provider: "openai", model: "text-only" });
const unsupportedImageGateway = new HostAiGateway(secrets, {
  fetch: (async () => new Response(null, { status: 400 })) as typeof fetch,
});
await assert.rejects(
  () => unsupportedImageGateway.summarizeImage({
    image: new Uint8Array([1]),
    mimeType: "image/png",
    prompt: "Summarize.",
  }),
  /did not accept image summaries/i,
);
assert.equal((await unsupportedImageGateway.getImageSummaryHealthSnapshot()).status, "unsupported");

const unauthorizedImageGateway = new HostAiGateway(secrets, {
  fetch: (async () => new Response(null, { status: 401 })) as typeof fetch,
});
await assert.rejects(
  () => unauthorizedImageGateway.summarizeImage({
    image: new Uint8Array([1]),
    mimeType: "image/png",
    prompt: "Summarize.",
  }),
  /rejected the API key/i,
);

const imageAbort = new AbortController();
imageAbort.abort();
let abortedImageFetches = 0;
const abortedImageGateway = new HostAiGateway(secrets, {
  fetch: (async () => {
    abortedImageFetches += 1;
    return Response.json({});
  }) as typeof fetch,
});
await assert.rejects(
  () => abortedImageGateway.summarizeImage({
    image: new Uint8Array([1]),
    mimeType: "image/png",
    prompt: "Summarize.",
  }, { signal: imageAbort.signal }),
  (error: unknown) => error instanceof Error && error.name === "AbortError",
);
assert.equal(abortedImageFetches, 0);

const compatible = new PluginAiGateway(secrets, { fetch: probeFetch });
assert.equal(compatible instanceof HostAiGateway, true);
assert.equal(typeof compatible.complete, "function");
assert.equal(typeof compatible.stream, "function");
assert.equal(typeof compatible.transcribe, "function");
assert.equal(hostSecretsOwner, "__openpets-host");
assert.equal(hostAiApiKeySecret, "ai-api-key");
assert.equal(hostAiApiKeySecretForProvider("openrouter"), "ai-api-key:openrouter");

console.log("host AI gateway health, cancellation, and compatibility behavior verified");
