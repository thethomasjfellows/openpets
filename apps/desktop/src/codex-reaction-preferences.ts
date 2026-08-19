import type { OpenPetsIntegrationLifecycle } from "./local-ipc-protocol.js";

export interface CodexReactionPreferences {
  readonly taskStarted: boolean;
  readonly taskWorking: boolean;
  readonly taskCompleted: boolean;
}

export const defaultCodexReactionPreferences: CodexReactionPreferences = {
  taskStarted: false,
  taskWorking: false,
  taskCompleted: true,
};

export function normalizeCodexReactionPreferences(value: unknown): CodexReactionPreferences {
  const record = isRecord(value) ? value : {};
  return {
    taskStarted: typeof record.taskStarted === "boolean" ? record.taskStarted : defaultCodexReactionPreferences.taskStarted,
    taskWorking: typeof record.taskWorking === "boolean" ? record.taskWorking : defaultCodexReactionPreferences.taskWorking,
    taskCompleted: typeof record.taskCompleted === "boolean" ? record.taskCompleted : defaultCodexReactionPreferences.taskCompleted,
  };
}

export function isCodexLifecycleReactionEnabled(
  preferences: CodexReactionPreferences,
  lifecycle: OpenPetsIntegrationLifecycle,
): boolean {
  if (lifecycle === "thinking") return preferences.taskStarted;
  if (lifecycle === "success" || lifecycle === "error") return preferences.taskCompleted;
  return preferences.taskWorking;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
