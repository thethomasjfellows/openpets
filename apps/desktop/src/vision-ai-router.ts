import { getCompanionSettings } from "./companion-settings.js";
import { getHostAiSettings } from "./host-ai-settings.js";
import type { HostAiImageOptions } from "./host-ai-gateway.js";
import { getVisionSettings } from "./vision-settings.js";
import type { VisionAiGateway } from "./vision-service.js";

export class VisionAiRouter implements VisionAiGateway {
  readonly #codex: VisionAiGateway;
  readonly #api: VisionAiGateway;

  constructor(codex: VisionAiGateway, api: VisionAiGateway) {
    this.#codex = codex;
    this.#api = api;
  }

  summarizeImage(...args: Parameters<VisionAiGateway["summarizeImage"]>) {
    const [request, options = {}] = args;
    return this.#active().summarizeImage(request, this.#options(options));
  }

  getImageSummaryHealthSnapshot() {
    return this.#active().getImageSummaryHealthSnapshot(this.#options());
  }

  probeImageSummary(options: HostAiImageOptions = {}) {
    return this.#active().probeImageSummary(this.#options(options));
  }

  invalidateImageSummaryHealth(): void {
    this.#codex.invalidateImageSummaryHealth();
    this.#api.invalidateImageSummaryHealth();
  }

  #active(): VisionAiGateway {
    const preference = getVisionSettings().modelPreference;
    if (preference?.owner === "codex") return this.#codex;
    if (preference?.owner === "host-ai") return this.#api;
    return getCompanionSettings().target === "codex" ? this.#codex : this.#api;
  }

  #options(options: HostAiImageOptions = {}): HostAiImageOptions {
    const preference = getVisionSettings().modelPreference;
    if (preference?.owner === "codex") return { ...options, model: preference.model };
    if (preference?.owner === "host-ai") return { ...options, provider: preference.provider, model: preference.model };
    if (getCompanionSettings().target === "codex") return options;
    const provider = getHostAiSettings().provider;
    return provider === "none" ? options : { ...options, provider };
  }
}
