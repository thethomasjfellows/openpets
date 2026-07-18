import { CodexConversationTarget } from "./voice-conversation-codex.js";
import type { CompanionTarget, CompanionTargetHealth, CompanionTargetRequest, CompanionTargetResult } from "./companion-targets.js";

export class CodexCompanionTarget implements CompanionTarget {
  readonly id = "codex" as const;
  readonly #target: CodexConversationTarget;
  readonly #integrationStatus: () => Promise<{ readonly state: string }>;

  constructor(
    target: CodexConversationTarget = new CodexConversationTarget(),
    integrationStatus: () => Promise<{ readonly state: string }> = async () => (await import("./agent-setup.js")).getCodexIntegrationStatus(),
  ) {
    this.#target = target;
    this.#integrationStatus = integrationStatus;
  }

  async health(force = false): Promise<CompanionTargetHealth> {
    const integration = await this.#integrationStatus();
    if (integration.state !== "connected") {
      return {
        targetId: "codex",
        checkedAt: Date.now(),
        configured: false,
        ready: false,
        method: "OpenPets Codex integration",
        reason: "Connect Codex in Integrations before using Codex CLI as the Companion provider.",
      };
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
