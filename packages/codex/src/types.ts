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
  };
  readonly mcp: {
    readonly state: CodexComponentState;
    readonly serverName: "openpets";
    readonly command?: string;
    readonly args?: readonly string[];
  };
  readonly legacy: {
    readonly detected: boolean;
    readonly removable: boolean;
    readonly details: readonly string[];
  };
  readonly managedChanges: readonly CodexManagedChange[];
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
