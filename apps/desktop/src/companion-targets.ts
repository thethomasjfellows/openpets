import type { CompanionTargetId } from "./companion-types.js";

export type CompanionTargetHealth = {
  readonly targetId: CompanionTargetId;
  readonly checkedAt: number;
  readonly configured: boolean;
  readonly ready: boolean;
  readonly method: string;
  readonly provider?: string;
  readonly model?: string;
  readonly version?: string;
  readonly reason?: string;
};

export type CompanionTargetEvent =
  | { readonly type: "session"; readonly sessionId: string }
  | { readonly type: "text"; readonly text: string; readonly final: boolean }
  | { readonly type: "error"; readonly message: string };

export type CompanionTargetRequest = {
  readonly prompt: string;
  readonly sessionId?: string;
  readonly signal: AbortSignal;
  readonly onEvent?: (event: CompanionTargetEvent) => void;
};

export type CompanionTargetResult = {
  readonly text: string;
  readonly sessionId?: string;
};

export type CompanionTargetImageInspectionRequest = {
  readonly image: Uint8Array;
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
  readonly prompt: string;
  readonly signal: AbortSignal;
};

export type CompanionTargetImageInspectionResult = {
  readonly text: string;
  readonly provider?: string;
  readonly model?: string;
};

export interface CompanionTarget {
  readonly id: CompanionTargetId;
  health(force?: boolean): Promise<CompanionTargetHealth>;
  configurationKey?(): string | Promise<string>;
  imageInspectionReady?(): boolean | Promise<boolean>;
  send(request: CompanionTargetRequest): Promise<CompanionTargetResult>;
  inspectImage?(request: CompanionTargetImageInspectionRequest): Promise<CompanionTargetImageInspectionResult>;
  dispose(): void;
}
