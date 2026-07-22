import { createHash } from "node:crypto";

import {
  defaultHostAiBaseUrls,
  defaultHostAiModels,
  getHostAiSettings,
  type AiBrainProviderKind,
  type HostAiProfileId,
  type HostAiProviderKind,
} from "./host-ai-settings.js";

export const hostSecretsOwner = "__openpets-host";
/** Legacy single-provider slot. Read only during the one-way migration. */
export const hostAiApiKeySecret = "ai-api-key";
export const hostAiApiKeySecretForProvider = (provider: HostAiProfileId): string => `ai-api-key:${provider}`;

export type HostAiRequest = {
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens?: number;
  temperature?: number;
  tools?: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
};

export type HostAiResult = {
  text: string;
  toolCalls?: Array<{ name: string; input: Record<string, unknown> }>;
};

export type HostAiImageSummaryRequest = {
  readonly image: Uint8Array;
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
  readonly prompt: string;
  readonly maxTokens?: number;
};

export type HostAiImageSummaryResult = {
  readonly text: string;
  readonly provider: AiBrainProviderKind;
  readonly model: string;
};

export type HostAiImageSummaryStatus =
  | "unconfigured"
  | "configured-unverified"
  | "probing"
  | "ready"
  | "unsupported"
  | "error";

export type HostAiImageSummaryHealthSnapshot = {
  readonly status: HostAiImageSummaryStatus;
  readonly configured: boolean;
  readonly ready: boolean;
  readonly provider: AiBrainProviderKind;
  readonly model: string;
  readonly checkedAt?: number;
  readonly stale: boolean;
  readonly error?: string;
};

export type HostAiHealthStatus = "unconfigured" | "configured-unverified" | "probing" | "ready" | "error";
export type HostAiHealthEvidence = "anthropic-model" | "openai-model" | "openai-compatible-models";

export type HostAiHealthSnapshot = {
  readonly status: HostAiHealthStatus;
  readonly configured: boolean;
  readonly ready: boolean;
  readonly provider: HostAiProviderKind;
  readonly model: string;
  readonly baseUrl?: string;
  readonly checkedAt?: number;
  readonly stale: boolean;
  readonly evidence?: HostAiHealthEvidence;
  readonly error?: string;
};

export type HostAiSecrets = {
  get(owner: string, key: string): Promise<string | undefined>;
};

export type MutableHostAiSecrets = HostAiSecrets & {
  has(owner: string, key: string): Promise<boolean>;
  set(owner: string, key: string, value: string): Promise<void>;
  delete(owner: string, key: string): Promise<void>;
};

/** Move the former one-slot credential once the provider profiles are available. */
export async function migrateLegacyHostAiApiKey(secrets: MutableHostAiSecrets): Promise<{ migrated: boolean; provider?: HostAiProfileId }> {
  const settings = getHostAiSettings();
  if (settings.provider === "none" || settings.provider === "ollama") return { migrated: false };
  const destination = hostAiApiKeySecretForProvider(settings.provider);
  if (await secrets.has(hostSecretsOwner, destination)) {
    if (await secrets.has(hostSecretsOwner, hostAiApiKeySecret)) {
      await secrets.delete(hostSecretsOwner, hostAiApiKeySecret);
    }
    return { migrated: false };
  }
  const legacy = await secrets.get(hostSecretsOwner, hostAiApiKeySecret);
  if (!legacy) return { migrated: false };
  await secrets.set(hostSecretsOwner, destination, legacy);
  await secrets.delete(hostSecretsOwner, hostAiApiKeySecret);
  return { migrated: true, provider: settings.provider };
}

export type HostAiGatewayOptions = {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly healthTtlMs?: number;
};

export type HostAiCallOptions = { readonly signal?: AbortSignal };
export type HostAiProbeOptions = HostAiCallOptions & { readonly force?: boolean; readonly provider?: HostAiProfileId };
export type HostAiModelOption = { readonly id: string; readonly name: string };
export type HostAiModelCatalog = { readonly provider: HostAiProfileId; readonly models: readonly HostAiModelOption[] };

type ActiveProvider = Exclude<HostAiProviderKind, "none">;
type ProviderContext = {
  readonly provider: ActiveProvider;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
};
type HealthContext = {
  readonly provider: HostAiProviderKind;
  readonly model: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly configured: boolean;
  readonly cacheKey: string;
};
type HealthCache = { readonly key: string; readonly snapshot: HostAiHealthSnapshot };
type ImageHealthCache = { readonly key: string; readonly snapshot: HostAiImageSummaryHealthSnapshot };

const defaultHealthTtlMs = 5 * 60_000;
const maxNonStreamJsonBytes = 2 * 1024 * 1024;
const maxImageSummaryInputBytes = 5 * 1024 * 1024;
const imageSummaryProbePng = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVR4nGP4z/D/Pz7MMDIUAACD5r9BB2dd7wAAAABJRU5ErkJggg==",
  "base64",
));

/**
 * Host-owned AI provider gateway shared by companion, voice, and plugin
 * compatibility surfaces. Provider settings and encrypted credentials remain
 * outside callers; readiness is an explicit cached probe rather than an
 * overloaded meaning of `available()`.
 */
export class HostAiGateway {
  readonly #secrets: HostAiSecrets;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #healthTtlMs: number;
  #healthCache: HealthCache | null = null;
  #probingKey: string | null = null;
  #imageHealthCache: ImageHealthCache | null = null;
  #imageProbingKey: string | null = null;

  constructor(secrets: HostAiSecrets, options: HostAiGatewayOptions = {}) {
    this.#secrets = secrets;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#healthTtlMs = Math.max(0, options.healthTtlMs ?? defaultHealthTtlMs);
  }

  /** Compatibility readiness: configured enough to attempt, without a probe. */
  async available(): Promise<boolean> {
    return (await this.#resolveHealthContext()).configured;
  }

  async complete(req: HostAiRequest, options: HostAiCallOptions = {}): Promise<HostAiResult> {
    const provider = await this.#resolveProvider();
    if (provider.provider === "anthropic") return this.#anthropicComplete(req, provider, options.signal);
    return this.#openAiComplete(req, provider, options.signal);
  }

  async stream(req: HostAiRequest, onToken: (chunk: string) => void, options: HostAiCallOptions = {}): Promise<{ text: string }> {
    const provider = await this.#resolveProvider();
    if (provider.provider === "anthropic") return this.#anthropicStream(req, provider, onToken, options.signal);
    return this.#openAiStream(req, provider, onToken, options.signal);
  }

  /** One-shot audio transcription for OpenAI-compatible providers. */
  async transcribe(audio: Uint8Array, mimeType: string, options: HostAiCallOptions = {}): Promise<string> {
    const provider = await this.#resolveProvider();
    if (provider.provider === "anthropic") throw new Error("Speech-to-text needs an OpenAI-compatible AI provider.");
    const form = new FormData();
    const filename = mimeType === "audio/wav" ? "speech.wav" : "speech.webm";
    form.append("file", new Blob([Buffer.from(audio)], { type: mimeType }), filename);
    form.append("model", "whisper-1");
    const response = await this.#fetch(`${provider.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: openAiHeaders(provider.provider, provider.apiKey, false),
      body: form,
      signal: options.signal,
    });
    if (!response.ok) throw new Error(`Transcription failed with HTTP ${response.status}.`);
    const parsed = await readBoundedJson<{ text?: string }>(response, "Transcription response", options.signal);
    return typeof parsed.text === "string" ? parsed.text : "";
  }

  async summarizeImage(
    req: HostAiImageSummaryRequest,
    options: HostAiCallOptions = {},
  ): Promise<HostAiImageSummaryResult> {
    validateImageSummaryRequest(req);
    throwIfAborted(options.signal);
    const context = await this.#resolveHealthContext();
    if (!context.configured || context.provider === "none" || !context.baseUrl) {
      throw new Error("Vision needs a configured AI provider and API key.");
    }
    const provider: ProviderContext = {
      provider: context.provider,
      model: context.model,
      baseUrl: context.baseUrl,
      apiKey: context.apiKey,
    };
    try {
      const text = provider.provider === "anthropic"
        ? await this.#anthropicImageSummary(req, provider, options.signal)
        : await this.#openAiImageSummary(req, provider, options.signal);
      const normalizedText = text.trim();
      if (!normalizedText) throw new ImageSummaryOutputError();
      const checkedAt = this.#now();
      this.#imageHealthCache = {
        key: context.cacheKey,
        snapshot: this.#baseImageHealth(context, {
          status: "ready",
          configured: true,
          ready: true,
          checkedAt,
          stale: false,
        }),
      };
      return { text: normalizedText, provider: context.provider, model: context.model };
    } catch (error) {
      if (isAbortError(error, options.signal)) throw error;
      const unsupported = error instanceof ImageSummaryHttpError && error.unsupported;
      const emptyOutput = error instanceof ImageSummaryOutputError;
      const message = imageSummaryFailureMessage(error, { unsupported, emptyOutput });
      this.#imageHealthCache = {
        key: context.cacheKey,
        snapshot: this.#baseImageHealth(context, {
          status: unsupported ? "unsupported" : "error",
          configured: true,
          ready: false,
          checkedAt: this.#now(),
          stale: false,
          error: message,
        }),
      };
      throw new Error(message);
    }
  }

  async getImageSummaryHealthSnapshot(): Promise<HostAiImageSummaryHealthSnapshot> {
    return this.#imageSnapshotForContext(await this.#resolveHealthContext());
  }

  async probeImageSummary(options: HostAiProbeOptions = {}): Promise<HostAiImageSummaryHealthSnapshot> {
    const context = await this.#resolveHealthContext();
    const current = this.#imageSnapshotForContext(context);
    if (!context.configured) return current;
    if (options.force !== true
      && (current.status === "ready" || current.status === "unsupported" || current.status === "error")
      && !current.stale) return current;

    throwIfAborted(options.signal);
    this.#imageProbingKey = context.cacheKey;
    try {
      const probe = await this.summarizeImage({
        image: imageSummaryProbePng,
        mimeType: "image/png",
        prompt: "What single basic color fills this image? Reply with only the color name.",
        maxTokens: 8,
      }, options);
      if (!/\b(?:magenta|fuchsia|pink|purple)\b/i.test(probe.text.trim())) {
        this.#imageHealthCache = {
          key: context.cacheKey,
          snapshot: this.#baseImageHealth(context, {
            status: "unsupported",
            configured: true,
            ready: false,
            checkedAt: this.#now(),
            stale: false,
            error: "The configured AI model did not demonstrate image understanding. Choose a vision-capable model or provider.",
          }),
        };
      }
    } catch (error) {
      if (isAbortError(error, options.signal)) throw error;
    } finally {
      if (this.#imageProbingKey === context.cacheKey) this.#imageProbingKey = null;
    }
    return this.#imageSnapshotForContext(context);
  }

  invalidateImageSummaryHealth(): void {
    this.#imageHealthCache = null;
    this.#imageProbingKey = null;
  }

  async getHealthSnapshot(): Promise<HostAiHealthSnapshot> {
    return this.#snapshotForContext(await this.#resolveHealthContext());
  }

  async probeHealth(options: HostAiProbeOptions = {}): Promise<HostAiHealthSnapshot> {
    const context = await this.#resolveHealthContext(options.provider);
    const current = this.#snapshotForContext(context);
    if (!context.configured) return current;
    if (options.force !== true && (current.status === "ready" || current.status === "error") && !current.stale) return current;

    throwIfAborted(options.signal);
    this.#probingKey = context.cacheKey;
    const evidence = probeEvidence(context.provider);
    try {
      const probe = await this.#probeProvider(context, options.signal);
      const response = probe.response;
      throwIfAborted(options.signal);
      const checkedAt = this.#now();
      const snapshot: HostAiHealthSnapshot = response.ok && probe.selectedModelAvailable !== false
        ? this.#baseHealth(context, { status: "ready", configured: true, ready: true, checkedAt, stale: false, evidence })
        : this.#baseHealth(context, {
            status: "error",
            configured: true,
            ready: false,
            checkedAt,
            stale: false,
            evidence,
            error: response.ok
              ? `The selected model “${context.model}” was not found in this provider's model catalog.`
              : `AI provider probe failed with HTTP ${response.status}.`,
          });
      this.#healthCache = { key: context.cacheKey, snapshot };
      return snapshot;
    } catch (error) {
      if (isAbortError(error, options.signal)) throw error;
      const snapshot = this.#baseHealth(context, {
        status: "error",
        configured: true,
        ready: false,
        checkedAt: this.#now(),
        stale: false,
        evidence,
        error: "AI provider probe failed.",
      });
      this.#healthCache = { key: context.cacheKey, snapshot };
      return snapshot;
    } finally {
      if (this.#probingKey === context.cacheKey) this.#probingKey = null;
    }
  }

  /** Load the models visible to one saved provider profile without selecting it. */
  async listModels(provider: HostAiProfileId, options: HostAiCallOptions = {}): Promise<HostAiModelCatalog> {
    const settings = getHostAiSettings();
    const config = settings.providers[provider];
    const apiKey = await this.#secrets.get(hostSecretsOwner, hostAiApiKeySecretForProvider(provider));
    if (config.requiresApiKey && !apiKey) throw new Error(`Save the ${provider} API key before loading its models.`);
    const baseUrl = effectiveBaseUrl(provider, config.baseUrl);
    if (!baseUrl) throw new Error("Enter the provider URL before loading its models.");
    const response = await this.#fetch(provider === "anthropic" ? `${baseUrl}/v1/models?limit=100` : `${baseUrl}/models`, {
      method: "GET",
      headers: provider === "anthropic"
        ? { "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01" }
        : openAiHeaders(provider, apiKey, false),
      signal: options.signal,
    });
    if (!response.ok) throw new Error(`Model catalog request failed with HTTP ${response.status}.`);
    const parsed = await readBoundedJson<{ data?: Array<{ id?: unknown; name?: unknown; display_name?: unknown }> }>(response, "Model catalog", options.signal);
    const seen = new Set<string>();
    const models: HostAiModelOption[] = [];
    if (provider === "openrouter") {
      models.push({ id: "openrouter/free", name: "OpenRouter Free Models Router" });
      seen.add("openrouter/free");
    }
    for (const candidate of parsed.data ?? []) {
      const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
      if (!id || id.length > 200 || seen.has(id)) continue;
      const display = typeof candidate.name === "string" ? candidate.name.trim()
        : typeof candidate.display_name === "string" ? candidate.display_name.trim()
          : "";
      models.push({ id, name: display || id });
      seen.add(id);
      if (models.length >= 500) break;
    }
    if (models.length === 0) throw new Error("The provider returned no selectable models.");
    return { provider, models };
  }

  invalidateHealth(): void {
    this.#healthCache = null;
    this.#probingKey = null;
    this.invalidateImageSummaryHealth();
  }

  async #resolveProvider(): Promise<ProviderContext> {
    const settings = getHostAiSettings();
    if (settings.provider === "none") throw new Error("No AI provider is configured in OpenPets settings.");
    const config = settings.providers[settings.provider];
    const apiKey = await this.#secrets.get(hostSecretsOwner, hostAiApiKeySecretForProvider(settings.provider));
    if (config.requiresApiKey && !apiKey) throw new Error(`The ${settings.provider} AI provider has no API key.`);
    return {
      provider: settings.provider,
      model: config.model || defaultHostAiModels[settings.provider],
      baseUrl: effectiveBaseUrl(settings.provider, config.baseUrl),
      apiKey,
    };
  }

  async #resolveHealthContext(requestedProvider?: HostAiProfileId): Promise<HealthContext> {
    const settings = getHostAiSettings();
    const provider = requestedProvider ?? settings.provider;
    const config = provider === "none" ? undefined : settings.providers[provider];
    const apiKey = provider === "none"
      ? undefined
      : await this.#secrets.get(hostSecretsOwner, hostAiApiKeySecretForProvider(provider));
    const configured = provider !== "none"
      && Boolean(config?.model && config.baseUrl)
      && (config?.requiresApiKey !== true || Boolean(apiKey));
    const model = provider === "none" ? "" : config?.model || defaultHostAiModels[provider];
    const baseUrl = provider === "none" ? undefined : effectiveBaseUrl(provider, config?.baseUrl);
    const keyFingerprint = apiKey ? createHash("sha256").update(apiKey).digest("hex") : "none";
    return {
      provider,
      model,
      baseUrl,
      apiKey,
      configured,
      cacheKey: `${provider}\u0000${model}\u0000${baseUrl ?? ""}\u0000${keyFingerprint}`,
    };
  }

  #snapshotForContext(context: HealthContext): HostAiHealthSnapshot {
    if (!context.configured) {
      return this.#baseHealth(context, { status: "unconfigured", configured: false, ready: false, stale: false });
    }
    if (this.#probingKey === context.cacheKey) {
      return this.#baseHealth(context, { status: "probing", configured: true, ready: false, stale: false });
    }
    if (this.#healthCache?.key === context.cacheKey) {
      const checkedAt = this.#healthCache.snapshot.checkedAt;
      const stale = checkedAt === undefined || this.#now() - checkedAt >= this.#healthTtlMs;
      return { ...this.#healthCache.snapshot, stale };
    }
    return this.#baseHealth(context, { status: "configured-unverified", configured: true, ready: false, stale: false });
  }

  #baseHealth(
    context: HealthContext,
    state: Omit<HostAiHealthSnapshot, "provider" | "model" | "baseUrl">,
  ): HostAiHealthSnapshot {
    return {
      ...state,
      provider: context.provider,
      model: context.model,
      ...(context.baseUrl === undefined ? {} : { baseUrl: context.baseUrl }),
    };
  }

  #imageSnapshotForContext(context: HealthContext): HostAiImageSummaryHealthSnapshot {
    if (!context.configured) {
      return this.#baseImageHealth(context, {
        status: "unconfigured",
        configured: false,
        ready: false,
        stale: false,
        error: "Set up an AI provider and API key before enabling Vision summaries.",
      });
    }
    if (this.#imageProbingKey === context.cacheKey) {
      return this.#baseImageHealth(context, {
        status: "probing",
        configured: true,
        ready: false,
        stale: false,
      });
    }
    if (this.#imageHealthCache?.key === context.cacheKey) {
      const checkedAt = this.#imageHealthCache.snapshot.checkedAt;
      const stale = checkedAt === undefined || this.#now() - checkedAt >= this.#healthTtlMs;
      return { ...this.#imageHealthCache.snapshot, stale };
    }
    return this.#baseImageHealth(context, {
      status: "configured-unverified",
      configured: true,
      ready: false,
      stale: false,
      error: "OpenPets has not yet checked whether this AI model can understand images.",
    });
  }

  #baseImageHealth(
    context: HealthContext,
    state: Omit<HostAiImageSummaryHealthSnapshot, "provider" | "model">,
  ): HostAiImageSummaryHealthSnapshot {
    return { ...state, provider: context.provider, model: context.model };
  }

  async #probeProvider(context: HealthContext, signal?: AbortSignal): Promise<{ response: Response; selectedModelAvailable?: boolean }> {
    if (context.provider === "anthropic") {
      return { response: await this.#fetch(`${context.baseUrl}/v1/models/${encodeURIComponent(context.model)}`, {
        method: "GET",
        headers: { "x-api-key": context.apiKey ?? "", "anthropic-version": "2023-06-01" },
        signal,
      }) };
    }
    if (context.provider === "openai") {
      return { response: await this.#fetch(`${context.baseUrl}/models/${encodeURIComponent(context.model)}`, {
        method: "GET",
        headers: { authorization: `Bearer ${context.apiKey ?? ""}` },
        signal,
      }) };
    }
    const response = await this.#fetch(`${context.baseUrl}/models`, {
      method: "GET",
      headers: openAiHeaders(context.provider, context.apiKey, false),
      signal,
    });
    if (!response.ok) return { response };
    const parsed = await readBoundedJson<{ data?: Array<{ id?: unknown }> }>(response, "Model catalog", signal);
    const selectedModelAvailable = context.provider === "openrouter" && context.model === "openrouter/free"
      || (parsed.data ?? []).some((candidate) => typeof candidate.id === "string" && candidate.id === context.model);
    return { response, selectedModelAvailable };
  }

  async #anthropicImageSummary(
    req: HostAiImageSummaryRequest,
    provider: ProviderContext,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await this.#fetch(`${provider.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": provider.apiKey ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: req.maxTokens ?? 300,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: req.mimeType,
                data: Buffer.from(req.image).toString("base64"),
              },
            },
            { type: "text", text: req.prompt },
          ],
        }],
      }),
      signal,
    });
    if (!response.ok) throw new ImageSummaryHttpError(response.status);
    const parsed = await readBoundedJson<{ content?: Array<{ type?: string; text?: string }> }>(
      response,
      "Image summary response",
      signal,
    );
    return (parsed.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("")
      .trim();
  }

  async #openAiImageSummary(
    req: HostAiImageSummaryRequest,
    provider: ProviderContext,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await this.#fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...openAiHeaders(provider.provider, provider.apiKey, false),
      },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: req.maxTokens ?? 300,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: req.prompt },
            {
              type: "image_url",
              image_url: { url: `data:${req.mimeType};base64,${Buffer.from(req.image).toString("base64")}` },
            },
          ],
        }],
      }),
      signal,
    });
    if (!response.ok) throw new ImageSummaryHttpError(response.status);
    const parsed = await readBoundedJson<{
      choices?: Array<{ message?: { content?: string | null } }>;
    }>(response, "Image summary response", signal);
    return (parsed.choices?.[0]?.message?.content ?? "").trim();
  }

  async #anthropicComplete(req: HostAiRequest, provider: ProviderContext, signal?: AbortSignal): Promise<HostAiResult> {
    const response = await this.#fetch(`${provider.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": provider.apiKey ?? "", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: req.maxTokens ?? 1024,
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
        ...(req.system === undefined ? {} : { system: req.system }),
        messages: req.messages,
        ...(req.tools === undefined ? {} : { tools: req.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) }),
      }),
      signal,
    });
    if (!response.ok) throw new Error(`AI request failed with HTTP ${response.status}.`);
    const parsed = await readBoundedJson<{ content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> }>(response, "AI response", signal);
    const blocks = parsed.content ?? [];
    const text = blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
    const toolCalls = blocks
      .filter((block) => block.type === "tool_use" && typeof block.name === "string")
      .map((block) => ({ name: block.name!, input: block.input ?? {} }));
    return { text, ...(toolCalls.length > 0 ? { toolCalls } : {}) };
  }

  async #anthropicStream(req: HostAiRequest, provider: ProviderContext, onToken: (chunk: string) => void, signal?: AbortSignal): Promise<{ text: string }> {
    const response = await this.#fetch(`${provider.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": provider.apiKey ?? "", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: req.maxTokens ?? 1024,
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
        ...(req.system === undefined ? {} : { system: req.system }),
        messages: req.messages,
        stream: true,
      }),
      signal,
    });
    if (!response.ok || !response.body) throw new Error(`AI request failed with HTTP ${response.status}.`);
    let text = "";
    await readSseStream(response.body, (data) => {
      try {
        const event = JSON.parse(data) as { type?: string; delta?: { type?: string; text?: string } };
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
          text += event.delta.text;
          onToken(event.delta.text);
        }
      } catch { /* keepalive/non-JSON lines */ }
    }, signal);
    return { text };
  }

  async #openAiComplete(req: HostAiRequest, provider: ProviderContext, signal?: AbortSignal): Promise<HostAiResult> {
    const response = await this.#fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...openAiHeaders(provider.provider, provider.apiKey, false) },
      body: JSON.stringify({
        model: provider.model,
        ...(req.maxTokens === undefined ? {} : { max_tokens: req.maxTokens }),
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
        messages: [...(req.system ? [{ role: "system", content: req.system }] : []), ...req.messages],
        ...(req.tools === undefined ? {} : { tools: req.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) }),
      }),
      signal,
    });
    if (!response.ok) throw new Error(`AI request failed with HTTP ${response.status}.`);
    const parsed = await readBoundedJson<{ choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }> }>(response, "AI response", signal);
    const message = parsed.choices?.[0]?.message;
    const toolCalls = (message?.tool_calls ?? []).flatMap((call) => {
      if (!call.function?.name) return [];
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(call.function.arguments ?? "{}") as Record<string, unknown>; } catch { /* leave empty */ }
      return [{ name: call.function.name, input }];
    });
    return { text: message?.content ?? "", ...(toolCalls.length > 0 ? { toolCalls } : {}) };
  }

  async #openAiStream(req: HostAiRequest, provider: ProviderContext, onToken: (chunk: string) => void, signal?: AbortSignal): Promise<{ text: string }> {
    const response = await this.#fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...openAiHeaders(provider.provider, provider.apiKey, false) },
      body: JSON.stringify({
        model: provider.model,
        ...(req.maxTokens === undefined ? {} : { max_tokens: req.maxTokens }),
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
        messages: [...(req.system ? [{ role: "system", content: req.system }] : []), ...req.messages],
        stream: true,
      }),
      signal,
    });
    if (!response.ok || !response.body) throw new Error(`AI request failed with HTTP ${response.status}.`);
    let text = "";
    await readSseStream(response.body, (data) => {
      if (data === "[DONE]") return;
      try {
        const event = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
        const token = event.choices?.[0]?.delta?.content;
        if (token) {
          text += token;
          onToken(token);
        }
      } catch { /* keepalive/non-JSON lines */ }
    }, signal);
    return { text };
  }
}

class ImageSummaryOutputError extends Error {
  constructor() {
    super("Image summary output was empty.");
  }
}

class ImageSummaryHttpError extends Error {
  readonly unsupported: boolean;

  constructor(readonly status: number) {
    super(`Image summary request failed with HTTP ${status}.`);
    this.unsupported = status === 400 || status === 404 || status === 415 || status === 422;
  }
}

function imageSummaryFailureMessage(
  error: unknown,
  classification: { readonly unsupported: boolean; readonly emptyOutput: boolean },
): string {
  if (classification.unsupported) {
    return "The configured AI model did not accept image summaries. Choose a vision-capable model or provider.";
  }
  if (classification.emptyOutput) {
    return "The configured AI provider returned an empty image summary. Choose a vision-capable model or provider.";
  }
  if (error instanceof ImageSummaryHttpError) {
    if (error.status === 401 || error.status === 403) {
      return "The AI provider rejected the API key. Check the key in AI Brain, then try Vision again.";
    }
    if (error.status === 429) {
      return "The AI provider is rate-limited or out of quota. Check the account, then try Vision again.";
    }
    if (error.status >= 500) {
      return "The AI provider is temporarily unavailable. Try Vision again in a moment.";
    }
  }
  if (error instanceof TypeError || (error instanceof Error && /fetch failed|network|connect/i.test(error.message))) {
    return "OpenPets could not reach the configured AI provider. Check its address or your connection in AI Brain.";
  }
  return "OpenPets could not summarize images with the configured AI provider.";
}

function validateImageSummaryRequest(req: HostAiImageSummaryRequest): void {
  if (!(req.image instanceof Uint8Array) || req.image.byteLength === 0
    || req.image.byteLength > maxImageSummaryInputBytes) {
    throw new Error("Vision image is empty or exceeds the local size limit.");
  }
  if (req.mimeType !== "image/png" && req.mimeType !== "image/jpeg" && req.mimeType !== "image/webp") {
    throw new Error("Vision image type is not supported.");
  }
  if (typeof req.prompt !== "string" || !req.prompt.trim() || req.prompt.length > 4_000) {
    throw new Error("Vision summary prompt is invalid.");
  }
}

function effectiveBaseUrl(provider: ActiveProvider, baseUrl: string | undefined): string {
  if (baseUrl) return baseUrl.replace(/\/+$/, "");
  return defaultHostAiBaseUrls[provider];
}

function probeEvidence(provider: HostAiProviderKind): HostAiHealthEvidence {
  if (provider === "anthropic") return "anthropic-model";
  if (provider === "openai") return "openai-model";
  return "openai-compatible-models";
}

function openAiHeaders(provider: HostAiProviderKind, apiKey: string | undefined, includeContentType: boolean): Record<string, string> {
  return {
    ...(includeContentType ? { "content-type": "application/json" } : {}),
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...(provider === "openrouter" ? {
      "HTTP-Referer": "https://openpets.dev",
      "X-Title": "OpenPets",
    } : {}),
  };
}

async function readBoundedJson<T>(response: Response, label: string, signal?: AbortSignal): Promise<T> {
  const body = response.body;
  if (!body) throw new Error(`${label} was empty.`);
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxNonStreamJsonBytes) {
      await body.cancel().catch(() => undefined);
      throw new Error(`${label} is too large.`);
    }
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let totalBytes = 0;
  const onAbort = () => { void reader.cancel(abortReason(signal)).catch(() => undefined); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) {
      await reader.cancel(abortReason(signal)).catch(() => undefined);
      throw abortReason(signal);
    }
    for (;;) {
      const chunk = await reader.read().catch((error: unknown) => {
        if (signal?.aborted) throw abortReason(signal);
        throw error;
      });
      throwIfAborted(signal);
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxNonStreamJsonBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${label} is too large.`);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label} was not valid JSON.`);
  }
}

async function readSseStream(body: ReadableStream<Uint8Array>, onData: (data: string) => void, signal?: AbortSignal): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let total = 0;
  const onAbort = () => { void reader.cancel(abortReason(signal)).catch(() => undefined); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) {
      await reader.cancel(abortReason(signal)).catch(() => undefined);
      throw abortReason(signal);
    }
    for (;;) {
      const chunk = await reader.read().catch((error: unknown) => {
        if (signal?.aborted) throw abortReason(signal);
        throw error;
      });
      throwIfAborted(signal);
      const { done, value } = chunk;
      if (done) break;
      total += value.byteLength;
      if (total > 32 * 1024 * 1024) {
        await reader.cancel().catch(() => undefined);
        throw new Error("AI stream is too large.");
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data:")) onData(trimmed.slice(5).trim());
      }
    }
    const trailing = buffer.trim();
    if (trailing.startsWith("data:")) onData(trailing.slice(5).trim());
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal | undefined): unknown {
  if (signal?.reason !== undefined) return signal.reason;
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}
