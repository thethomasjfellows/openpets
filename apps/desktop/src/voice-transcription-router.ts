import type { PluginSecretsStore } from "./plugin-secrets.js";
import {
  type LocalTranscriptionService,
  localTranscriptionModelId,
} from "./voice-local-transcription.js";
import {
  VoiceOpenAiTranscriptionGateway,
  type VoiceTranscriptionHealth,
} from "./voice-openai-transcription.js";
import { getVoiceTranscriptionSettings } from "./voice-transcription-settings.js";

export class VoiceTranscriptionRouter {
  readonly #local: LocalTranscriptionService;
  readonly #openAi: VoiceOpenAiTranscriptionGateway;

  constructor(input: { readonly local: LocalTranscriptionService; readonly secrets: PluginSecretsStore; readonly fetchImpl?: typeof fetch }) {
    this.#local = input.local;
    this.#openAi = new VoiceOpenAiTranscriptionGateway(input.secrets, input.fetchImpl);
  }

  async health(): Promise<VoiceTranscriptionHealth> {
    const settings = getVoiceTranscriptionSettings();
    if (settings.providerId === "openai") return this.#openAi.health();
    if (settings.providerId === "none") {
      return {
        checkedAt: Date.now(),
        configured: false,
        ready: false,
        providerId: "none",
        model: "",
        baseUrl: "",
        reason: "Speech recognition is turned off.",
      };
    }
    const local = this.#local.snapshot();
    const health = await this.#local.health();
    return {
      checkedAt: Date.now(),
      configured: local.status === "ready",
      ready: health.ready,
      providerId: "local",
      model: localTranscriptionModelId,
      baseUrl: "",
      ...(health.reason ? { reason: health.reason } : {}),
    };
  }

  async transcribe(audio: Uint8Array, mimeType: string, options: { readonly signal?: AbortSignal } = {}): Promise<string> {
    const settings = getVoiceTranscriptionSettings();
    if (settings.providerId === "local") return this.#local.transcribe(audio, mimeType, options.signal);
    if (settings.providerId === "openai") return this.#openAi.transcribe(audio, mimeType, options);
    throw new Error("Choose a speech recognition provider before listening.");
  }
}
