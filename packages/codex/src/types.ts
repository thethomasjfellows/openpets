export const codexLifecycleEvents = [
  "thinking",
  "working",
  "editing",
  "testing",
  "waiting",
  "success",
  "error",
] as const;

export type CodexLifecycleEvent = typeof codexLifecycleEvents[number];

export const codexIntegrationStates = [
  "not_detected",
  "installable",
  "installing",
  "waiting_for_trust",
  "connected",
  "needs_repair",
  "conflict",
  "unsupported",
] as const;

export type CodexIntegrationState = typeof codexIntegrationStates[number];
export type CodexHookTrustState = "missing" | "waiting" | "trusted" | "modified" | "unsupported";
export type CodexComponentState = "missing" | "current" | "modified" | "conflict" | "error";

export interface CodexIntegrationCheck {
  readonly id: "cli" | "version" | "hooks" | "hook-trust" | "mcp" | "legacy";
  readonly state: "ok" | "needs_action" | "waiting" | "conflict" | "unsupported" | "error";
  readonly message: string;
  readonly detail?: string;
}

export interface CodexManagedChange {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly detail: string;
  readonly ownership: "managed" | "read_only" | "legacy";
  readonly present: boolean;
}

export interface CodexIntegrationSnapshot {
  readonly state: CodexIntegrationState;
  readonly message: string;
  readonly detected: boolean;
  readonly command: string;
  readonly version?: string;
  readonly location?: string;
  readonly supported: boolean;
  readonly hooks: {
    readonly state: CodexComponentState;
    readonly trust: CodexHookTrustState;
    readonly path: string;
    readonly installedEvents: readonly string[];
    readonly changedEvents?: readonly string[];
  };
  readonly mcp: {
    readonly state: CodexComponentState;
    readonly serverName: "openpets";
    readonly command?: string;
    readonly args?: readonly string[];
    readonly message?: string;
  };
  readonly legacy: {
    readonly detected: boolean;
    readonly removable: boolean;
    readonly details: readonly string[];
  };
  readonly managedChanges: readonly CodexManagedChange[];
  readonly checks: readonly CodexIntegrationCheck[];
  readonly canInstall: boolean;
  readonly canRepair: boolean;
  readonly canDisconnect: boolean;
  readonly canRefresh: true;
}

export interface CodexCommandResult {
  readonly ok: boolean;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

export type CodexCommandRunner = (
  command: string,
  args: readonly string[],
  options?: { readonly timeoutMs?: number },
) => Promise<CodexCommandResult>;

export interface CodexIntegrationOptions {
  readonly codexCommand?: string;
  readonly nodeCommand?: string;
  readonly codexHome?: string;
  readonly hookCliPath: string;
  readonly mcpEntryPath: string;
  readonly runCommand?: CodexCommandRunner;
  readonly now?: () => number;
}

export interface CodexActionResult {
  readonly ok: boolean;
  readonly changed: boolean;
  readonly message: string;
  readonly snapshot: CodexIntegrationSnapshot;
}

export type CodexModelInputModality = "text" | "image" | (string & {});

export interface CodexReasoningEffortOption {
  readonly value: string;
  readonly description: string;
}

export interface CodexModelInfo {
  readonly id: string;
  readonly model: string;
  readonly displayName: string;
  readonly description: string;
  readonly hidden: boolean;
  readonly isDefault: boolean;
  readonly inputModalities: readonly CodexModelInputModality[];
  readonly defaultReasoningEffort: string;
  readonly supportedReasoningEfforts: readonly CodexReasoningEffortOption[];
}

export interface CodexModelDiscoverySnapshot {
  readonly checkedAt: number;
  readonly status: "ready" | "not_detected" | "unsupported" | "error";
  readonly models: readonly CodexModelInfo[];
  readonly defaultModelId?: string;
  readonly reason?: string;
}

export interface CodexModelDiscoveryOptions {
  readonly codexCommand?: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly runAppServer?: (command: string, timeoutMs: number) => Promise<unknown>;
}
