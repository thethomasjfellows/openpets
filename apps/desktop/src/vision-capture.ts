import { desktopCapturer, screen, systemPreferences, type Rectangle } from "electron";

import { warn } from "./logger.js";
import { maxVisionScreenshotBytes } from "./vision-store.js";

export type VisionCaptureHealthStatus = "unknown" | "ready" | "permission-denied" | "unavailable" | "error";

export type VisionCaptureHealth = {
  readonly ready: boolean;
  readonly status: VisionCaptureHealthStatus;
  readonly checkedAt: number;
  readonly reason?: string;
};

export type VisionCapturedScreen = {
  readonly image: Uint8Array;
  readonly mimeType: "image/png" | "image/jpeg";
};

export type VisionCaptureAdapter = {
  checkHealth(force?: boolean): Promise<VisionCaptureHealth>;
  capture(signal?: AbortSignal): Promise<VisionCapturedScreen>;
};

export type ElectronVisionCaptureOptions = {
  readonly getDefaultPetBounds?: () => Rectangle | null;
  readonly now?: () => number;
};

const captureThumbnailSize = { width: 1280, height: 800 };
const captureJpegQuality = 72;

export function createElectronVisionCapture(options: ElectronVisionCaptureOptions = {}): VisionCaptureAdapter {
  const now = options.now ?? Date.now;
  let cachedHealth: VisionCaptureHealth | null = null;

  const checkHealth = async (force = false): Promise<VisionCaptureHealth> => {
    if (!force && cachedHealth && now() - cachedHealth.checkedAt < 60_000) return cachedHealth;
    const access = process.platform === "darwin" ? systemPreferences.getMediaAccessStatus("screen") : "granted";
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 32, height: 20 } });
      const hasUsableThumbnail = sources.some((source) => !source.thumbnail.isEmpty());
      cachedHealth = hasUsableThumbnail
        ? { ready: true, status: "ready", checkedAt: now() }
        : {
            ready: false,
            status: "unavailable",
            checkedAt: now(),
            reason: sources.length > 0
              ? "OpenPets can see a display but cannot capture it yet. Restart OpenPets and check again."
              : "No screen is currently available to OpenPets.",
          };
      return cachedHealth;
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 240) : "unknown";
      warn("vision", "Vision screen probe failed", { access, reason });
      cachedHealth = {
        ready: false,
        status: access === "denied" || access === "restricted" ? "permission-denied" : "error",
        checkedAt: now(),
        reason: access === "denied" || access === "restricted"
          ? "Allow Screen & System Audio Recording for OpenPets in System Settings."
          : "OpenPets could not check screen access.",
      };
      return cachedHealth;
    }
  };

  return {
    checkHealth,
    async capture(signal) {
      throwIfAborted(signal);
      const health = await checkHealth(true);
      if (!health.ready) throw new Error(health.reason ?? "Screen capture is not available.");
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: captureThumbnailSize });
      throwIfAborted(signal);
      const source = selectScreenSource(sources, options.getDefaultPetBounds?.() ?? null);
      if (!source || source.thumbnail.isEmpty()) throw new Error("OpenPets could not capture the current screen.");

      let image = source.thumbnail;
      let jpeg = image.toJPEG(captureJpegQuality);
      for (const width of [1120, 960, 800, 640]) {
        if (jpeg.byteLength <= maxVisionScreenshotBytes) break;
        image = image.resize({ width, quality: "good" });
        jpeg = image.toJPEG(captureJpegQuality);
      }
      if (jpeg.byteLength === 0 || jpeg.byteLength > maxVisionScreenshotBytes) {
        throw new Error("The screen capture exceeded the local Vision size limit.");
      }
      return { image: Uint8Array.from(jpeg), mimeType: "image/jpeg" };
    },
  };
}

function selectScreenSource(
  sources: Awaited<ReturnType<typeof desktopCapturer.getSources>>,
  petBounds: Rectangle | null,
): (typeof sources)[number] | undefined {
  const targetDisplay = petBounds ? screen.getDisplayMatching(petBounds) : screen.getPrimaryDisplay();
  const targetId = String(targetDisplay.id);
  return sources.find((source) => source.display_id === targetId)
    ?? sources.find((source) => source.display_id === String(screen.getPrimaryDisplay().id))
    ?? sources[0];
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  throw error;
}
