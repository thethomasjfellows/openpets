import type { PluginSecretsStore } from "./plugin-secrets.js";
import { getVoiceSecret, voiceOpenAiCompatibleApiKeySecret, voiceSecretsOwner } from "./voice-secrets.js";
import { getVoiceTranscriptionSettings, type VoiceTranscriptionProviderId } from "./voice-transcription-settings.js";

export type VoiceTranscriptionHealth = {
  readonly checkedAt: number;
  readonly configured: boolean;
  readonly ready: boolean;
  readonly providerId: VoiceTranscriptionProviderId;
  readonly model: string;
  readonly baseUrl: string;
  readonly reason?: string;
};

const maxResponseBytes = 1024 * 1024;

export class VoiceOpenAiTranscriptionGateway {
  readonly #secrets: PluginSecretsStore;
  readonly #fetch: typeof fetch;

  constructor(secrets: PluginSecretsStore, fetchImpl: typeof fetch = globalThis.fetch) {
    this.#secrets = secrets;
    this.#fetch = fetchImpl;
  }

  async health(): Promise<VoiceTranscriptionHealth> {
    const settings = getVoiceTranscriptionSettings();
    if (settings.providerId !== "openai") return { checkedAt: Date.now(), configured: false, ready: false, ...settings, reason: "Choose OpenAI Audio Transcriptions for speech recognition." };
    const hasKey = await this.#secrets.has(voiceSecretsOwner, voiceOpenAiCompatibleApiKeySecret);
    return {
      checkedAt: Date.now(),
      configured: hasKey,
      ready: hasKey,
      ...settings,
      ...(!hasKey ? { reason: "Add an OpenAI API key for speech recognition." } : {}),
    };
  }

  async transcribe(audio: Uint8Array, mimeType: string, options: { readonly signal?: AbortSignal } = {}): Promise<string> {
    const health = await this.health();
    if (!health.ready) throw new Error(health.reason ?? "Speech recognition is not configured.");
    const apiKey = await getVoiceSecret(this.#secrets, "openai-compatible");
    if (!apiKey) throw new Error("Add an OpenAI API key for speech recognition.");
    const form = new FormData();
    const filename = mimeType === "audio/wav" ? "speech.wav" : "speech.webm";
    form.append("file", new Blob([Buffer.from(audio)], { type: mimeType }), filename);
    form.append("model", health.model);
    const response = await this.#fetch(`${health.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: options.signal,
    });
    if (!response.ok) throw new Error(`Speech recognition failed with HTTP ${response.status}.`);
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) throw new Error("Speech recognition returned too much data.");
    const body = await response.text();
    if (Buffer.byteLength(body) > maxResponseBytes) throw new Error("Speech recognition returned too much data.");
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { throw new Error("Speech recognition returned an invalid response."); }
    return isRecord(parsed) && typeof parsed.text === "string" ? parsed.text : "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
