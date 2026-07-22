import { getCompanionSettings } from "./companion-settings.js";
import type { HostAiProbeOptions } from "./host-ai-gateway.js";
import type { VisionAiGateway } from "./vision-service.js";

export class VisionAiRouter implements VisionAiGateway {
  readonly #codex: VisionAiGateway;
  readonly #api: VisionAiGateway;

  constructor(codex: VisionAiGateway, api: VisionAiGateway) {
    this.#codex = codex;
    this.#api = api;
  }

  summarizeImage(...args: Parameters<VisionAiGateway["summarizeImage"]>) {
    return this.#active().summarizeImage(...args);
  }

  getImageSummaryHealthSnapshot() {
    return this.#active().getImageSummaryHealthSnapshot();
  }

  probeImageSummary(options?: HostAiProbeOptions) {
    return this.#active().probeImageSummary(options);
  }

  invalidateImageSummaryHealth(): void {
    this.#codex.invalidateImageSummaryHealth();
    this.#api.invalidateImageSummaryHealth();
  }

  #active(): VisionAiGateway {
    return getCompanionSettings().target === "codex" ? this.#codex : this.#api;
  }
}
