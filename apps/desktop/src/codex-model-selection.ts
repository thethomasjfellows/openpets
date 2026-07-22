import type { CodexModelDiscoverySnapshot, CodexModelInfo } from "@open-pets/codex";

export function resolveCodexModelInfo(discovery: CodexModelDiscoverySnapshot, requested: string): CodexModelInfo | undefined {
  return requested
    ? discovery.models.find((model) => model.id === requested || model.model === requested)
    : discovery.models.find((model) => model.isDefault) ?? discovery.models[0];
}
