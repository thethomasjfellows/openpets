import { CodexConversationTarget } from "./voice-conversation-codex.js";
import { getCompanionSettings } from "./companion-settings.js";
import type { CompanionTarget, CompanionTargetHealth, CompanionTargetRequest, CompanionTargetResult } from "./companion-targets.js";

export class CodexCompanionTarget implements CompanionTarget {
  readonly id = "codex" as const;
  readonly #target: CodexConversationTarget;
  readonly #integrationStatus: () => Promise<{ readonly state: string; readonly detected?: boolean; readonly supported?: boolean }>;

  constructor(
    target: CodexConversationTarget = new CodexConversationTarget({
      getModel: () => getCompanionSettings().codex.model,
      getReasoningEffort: () => getCompanionSettings().codex.reasoningEffort,
    }),
    integrationStatus: () => Promise<{ readonly state: string; readonly detected?: boolean; readonly supported?: boolean }> = async () => (await import("./agent-setup.js")).getCodexIntegrationStatus(),
  ) {
    this.#target = target;
    this.#integrationStatus = integrationStatus;
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

  async send(request: CompanionTargetRequest): Promise<CompanionTargetResult> {
    const result = await this.#target.sendText({
      text: request.prompt,
      sessionId: request.sessionId,
      signal: request.signal,
      onEvent: request.onEvent,
    });
    return result;
  }

  dispose(): void {
    this.#target.dispose();
  }
}
