export type PetVisionStatus = "off" | "paused" | "working" | "setup-needed";

export function getPetVisionStatus(input: {
  readonly enabled: boolean;
  readonly state: string;
  readonly captureReady: boolean;
  readonly summaryReady: boolean;
}): PetVisionStatus {
  if (!input.enabled) return "off";
  if (input.state === "paused") return "paused";
  if (
    input.captureReady
    && input.summaryReady
    && (input.state === "ready" || input.state === "capturing" || input.state === "summarizing")
  ) return "working";
  return "setup-needed";
}
