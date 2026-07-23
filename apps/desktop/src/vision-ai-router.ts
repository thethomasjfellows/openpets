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
    return this.#active().summarizeImage(request, { ...options, model: this.#modelPreference() });
  }

  getImageSummaryHealthSnapshot() {
    return this.#active().getImageSummaryHealthSnapshot({ model: this.#modelPreference() });
  }

  probeImageSummary(options: HostAiImageOptions = {}) {
    return this.#active().probeImageSummary({ ...options, model: this.#modelPreference() });
  }

  invalidateImageSummaryHealth(): void {
    this.#codex.invalidateImageSummaryHealth();
    this.#api.invalidateImageSummaryHealth();
  }

  #active(): VisionAiGateway {
    return getCompanionSettings().target === "codex" ? this.#codex : this.#api;
  }

  #modelPreference(): string | undefined {
    const companion = getCompanionSettings();
    const preference = getVisionSettings().modelPreference;
    if (!preference) return undefined;
    if (companion.target === "codex") return preference.owner === "codex" ? preference.model : undefined;
    const provider = getHostAiSettings().provider;
    return preference.owner === "host-ai" && preference.provider === provider ? preference.model : undefined;
  }
}
