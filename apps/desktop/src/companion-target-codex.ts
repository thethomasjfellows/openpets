import { CodexConversationTarget } from "./voice-conversation-codex.js";
import { getCompanionSettings } from "./companion-settings.js";
import type {
  CompanionTarget,
  CompanionTargetHealth,
  CompanionTargetImageInspectionRequest,
  CompanionTargetImageInspectionResult,
  CompanionTargetRequest,
  CompanionTargetResult,
} from "./companion-targets.js";

type CodexImageInspector = (request: CompanionTargetImageInspectionRequest) => Promise<CompanionTargetImageInspectionResult>;
type CodexImageReadiness = () => boolean | Promise<boolean>;

export class CodexCompanionTarget implements CompanionTarget {
  readonly id = "codex" as const;
  readonly #target: CodexConversationTarget;
  readonly #integrationStatus: () => Promise<{ readonly state: string; readonly detected?: boolean; readonly supported?: boolean }>;
  readonly #imageInspector?: CodexImageInspector;
  readonly #configurationKey: () => string | Promise<string>;
  readonly #imageReadiness: CodexImageReadiness;

  constructor(
    target: CodexConversationTarget = new CodexConversationTarget({
      getModel: () => getCompanionSettings().codex.model,
      getReasoningEffort: () => getCompanionSettings().codex.reasoningEffort,
    }),
    integrationStatus: () => Promise<{ readonly state: string; readonly detected?: boolean; readonly supported?: boolean }> = async () => (await import("./agent-setup.js")).getCodexIntegrationStatus(),
    imageInspector?: CodexImageInspector,
    configurationKey: () => string | Promise<string> = () => {
      const settings = getCompanionSettings().codex;
      return `codex\u0000${settings.model ?? ""}\u0000${settings.reasoningEffort ?? ""}`;
    },
    imageReadiness: CodexImageReadiness = () => false,
  ) {
    this.#target = target;
    this.#integrationStatus = integrationStatus;
    this.#imageInspector = imageInspector;
    this.#configurationKey = configurationKey;
    this.#imageReadiness = imageReadiness;
  }

  async health(force = false): Promise<CompanionTargetHealth> {
    const integration = await this.#integrationStatus();
    if (integration.detected === false || integration.state === "not_detected") {
      return {
        targetId: "codex",
        checkedAt: Date.now(),
        configured: false,
        ready: false,
        method: "OpenPets Codex integration",
        reason: "Install or connect Codex before using it as the AI Brain.",
      };
    }
    if (integration.supported === false || integration.state === "unsupported") {
      return { targetId: "codex", checkedAt: Date.now(), configured: false, ready: false, method: "OpenPets Codex integration", reason: "Update Codex to a supported version before using it as the AI Brain." };
    }
    const health = await this.#target.health(force);
    return {
      ...health,
      targetId: "codex",
      configured: health.ready,
    };
  }

  configurationKey(): string | Promise<string> {
    return this.#configurationKey();
  }

  imageInspectionReady(): boolean | Promise<boolean> {
    return this.#imageReadiness();
  }

  async send(request: CompanionTargetRequest): Promise<CompanionTargetResult> {
    const result = await this.#target.sendText({
      text: request.prompt,
      sessionId: request.sessionId,
      signal: request.signal,
      onEvent: request.onEvent,
    });
    return result;
  }

  async inspectImage(request: CompanionTargetImageInspectionRequest): Promise<CompanionTargetImageInspectionResult> {
    if (!this.#imageInspector) throw new Error("Codex image inspection is unavailable in this runtime.");
    return this.#imageInspector(request);
  }

  dispose(): void {
    this.#target.dispose();
  }
}
