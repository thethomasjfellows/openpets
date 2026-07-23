import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverCodexModels, type CodexModelDiscoverySnapshot, type CodexModelInfo } from "@open-pets/codex";

import { getCompanionSettings } from "./companion-settings.js";
import { getPreferredCodexCommand } from "./codex-command.js";
import { resolveCodexModelInfo } from "./codex-model-selection.js";
import type {
  HostAiImageSummaryHealthSnapshot,
  HostAiImageOptions,
  HostAiImageSummaryRequest,
  HostAiImageSummaryResult,
} from "./host-ai-gateway.js";
import { CodexConversationTarget } from "./voice-conversation-codex.js";

const discoveryTtlMs = 60_000;
const healthTtlMs = 5 * 60_000;
const maxImageBytes = 5 * 1024 * 1024;
const probeImage = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVR4nGP4z/D/Pz7MMDIUAACD5r9BB2dd7wAAAABJRU5ErkJggg==",
  "base64",
));

export class CodexAiBrain {
  readonly #target: CodexConversationTarget;
  readonly #discover: typeof discoverCodexModels;
  readonly #now: () => number;
  #discovery: CodexModelDiscoverySnapshot | null = null;
  #imageHealth: HostAiImageSummaryHealthSnapshot | null = null;
  #imageHealthKey: string | null = null;
  #probingKey: string | null = null;

  constructor(options: {
    readonly target?: CodexConversationTarget;
    readonly discover?: typeof discoverCodexModels;
    readonly now?: () => number;
  } = {}) {
    this.#target = options.target ?? new CodexConversationTarget({
      command: getPreferredCodexCommand(),
      getModel: () => this.resolveSelectedExecutableModel(),
      getReasoningEffort: () => getCompanionSettings().codex.reasoningEffort,
    });
    this.#discover = options.discover ?? discoverCodexModels;
    this.#now = options.now ?? Date.now;
  }

  async discoverModels(force = false): Promise<CodexModelDiscoverySnapshot> {
    if (!force && this.#discovery && this.#now() - this.#discovery.checkedAt < discoveryTtlMs) return this.#discovery;
    this.#discovery = await this.#discover({ now: this.#now, codexCommand: getPreferredCodexCommand() });
    if (force) this.invalidateImageSummaryHealth();
    return this.#discovery;
  }

  async resolveSelectedExecutableModel(): Promise<string> {
    const requested = getCompanionSettings().codex.model;
    if (!requested) return "";
    const discovery = await this.discoverModels();
    if (discovery.status !== "ready") throw new Error(discovery.reason ?? "Codex model discovery is unavailable.");
    const modelInfo = resolveCodexModelInfo(discovery, requested);
    if (!modelInfo) throw new Error("The selected Codex model is no longer available. Choose another model in AI Brain.");
    return modelInfo.model;
  }

  async summarizeImage(req: HostAiImageSummaryRequest, options: HostAiImageOptions = {}): Promise<HostAiImageSummaryResult> {
    if (req.image.byteLength === 0 || req.image.byteLength > maxImageBytes) throw new Error("Vision image must contain 1 byte–5 MiB.");
    if (options.signal?.aborted) throw abortError();
    const { model, modelInfo } = await this.#selectedModel(options.model);
    if (!modelInfo.inputModalities.includes("image")) throw new Error(`${modelInfo.displayName} does not support image input.`);
    const dir = await mkdtemp(join(tmpdir(), "openpets-codex-vision-"));
    const imagePath = join(dir, `screen.${extensionFor(req.mimeType)}`);
    try {
      await writeFile(imagePath, req.image, { mode: 0o600 });
      const result = await this.#target.analyzeImage({ text: req.prompt, imagePath, signal: options.signal ?? new AbortController().signal });
      const text = result.text.trim();
      if (!text) throw new Error("Codex returned an empty Vision summary.");
      this.#imageHealth = {
        status: "ready",
        configured: true,
        ready: true,
        provider: "codex",
        model,
        checkedAt: this.#now(),
        stale: false,
      };
      this.#imageHealthKey = model;
      return { text, provider: "codex", model };
    } catch (error) {
      if (isAbortError(error, options.signal)) throw error;
      const message = cleanError(error);
      this.#imageHealth = {
        status: /does not support image/i.test(message) ? "unsupported" : "error",
        configured: true,
        ready: false,
        provider: "codex",
        model,
        checkedAt: this.#now(),
        stale: false,
        error: message,
      };
      this.#imageHealthKey = model;
      throw new Error(message);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async getImageSummaryHealthSnapshot(options: HostAiImageOptions = {}): Promise<HostAiImageSummaryHealthSnapshot> {
    const base = await this.#baseImageHealth(options.model);
    const key = base.model;
    if (this.#probingKey === key) return { ...base, status: "probing", ready: false };
    if (this.#imageHealth && this.#imageHealthKey === key) {
      const checkedAt = this.#imageHealth.checkedAt;
      return { ...this.#imageHealth, stale: checkedAt === undefined || this.#now() - checkedAt >= healthTtlMs };
    }
    return base;
  }

  async probeImageSummary(options: HostAiImageOptions = {}): Promise<HostAiImageSummaryHealthSnapshot> {
    const current = await this.getImageSummaryHealthSnapshot(options);
    if (!current.configured || current.status === "unsupported") return current;
    if (options.force !== true && current.status === "ready" && !current.stale) return current;
    this.#probingKey = current.model;
    try {
      const result = await this.summarizeImage({
        image: probeImage,
        mimeType: "image/png",
        prompt: "What single basic color fills this image? Reply with only the color name.",
        maxTokens: 8,
      }, options);
      if (!/\b(?:magenta|fuchsia|pink|purple)\b/i.test(result.text)) {
        this.#imageHealth = { status: "unsupported", configured: true, ready: false, provider: "codex", model: result.model, checkedAt: this.#now(), stale: false, error: "The selected Codex model did not demonstrate image understanding." };
        this.#imageHealthKey = result.model;
      }
    } catch (error) {
      if (isAbortError(error, options.signal)) throw error;
    } finally {
      if (this.#probingKey === current.model) this.#probingKey = null;
    }
    return this.getImageSummaryHealthSnapshot(options);
  }

  invalidateImageSummaryHealth(): void {
    this.#imageHealth = null;
    this.#imageHealthKey = null;
    this.#probingKey = null;
  }

  dispose(): void {
    this.#target.dispose();
  }

  async #selectedModel(requestedModel?: string): Promise<{ readonly model: string; readonly modelInfo: CodexModelInfo }> {
    const discovery = await this.discoverModels();
    if (discovery.status !== "ready") throw new Error(discovery.reason ?? "Codex model discovery is unavailable.");
    const requested = requestedModel?.trim() || getCompanionSettings().codex.model;
    const modelInfo = resolveCodexModelInfo(discovery, requested);
    if (!modelInfo) throw new Error("The selected Codex model is no longer available. Choose another model in AI Brain.");
    return { model: modelInfo.model, modelInfo };
  }

  async #baseImageHealth(requestedModel?: string): Promise<HostAiImageSummaryHealthSnapshot> {
    try {
      const { model, modelInfo } = await this.#selectedModel(requestedModel);
      if (!modelInfo.inputModalities.includes("image")) {
        return { status: "unsupported", configured: true, ready: false, provider: "codex", model, stale: false, error: `${modelInfo.displayName} does not support image input. Choose a Vision-capable Codex model.` };
      }
      return { status: "configured-unverified", configured: true, ready: false, provider: "codex", model, stale: false, error: "OpenPets has not yet checked Codex image understanding." };
    } catch (error) {
      return { status: "unconfigured", configured: false, ready: false, provider: "codex", model: "", stale: false, error: cleanError(error) };
    }
  }
}

let sharedCodexAiBrain: CodexAiBrain | null = null;

export function getCodexAiBrain(): CodexAiBrain {
  sharedCodexAiBrain ??= new CodexAiBrain();
  return sharedCodexAiBrain;
}

export function disposeCodexAiBrain(): void {
  sharedCodexAiBrain?.dispose();
  sharedCodexAiBrain = null;
}

function extensionFor(mimeType: HostAiImageSummaryRequest["mimeType"]): "png" | "jpg" | "webp" {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(?:[A-Za-z]:)?[\\/][^\s"']{2,}/g, "<path>")
    .replace(/https?:\/\/[^\s]+/gi, "endpoint")
    .replace(/[A-Za-z0-9+/=_-]{48,}/g, "[redacted]")
    .trim()
    .slice(0, 300) || "Codex Vision failed.";
}

function abortError(): Error {
  const error = new Error("Codex Vision was cancelled.");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}
