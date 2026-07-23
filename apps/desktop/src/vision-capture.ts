import { desktopCapturer, screen, systemPreferences } from "electron";

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
  readonly displayId: string;
  readonly displayLabel: string;
  readonly displayBounds?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly primary: boolean;
};

export type VisionCaptureAdapter = {
  checkHealth(force?: boolean): Promise<VisionCaptureHealth>;
  capture(signal?: AbortSignal): Promise<readonly VisionCapturedScreen[]>;
};

export type ElectronVisionCaptureOptions = {
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
      const expectedDisplayCount = Math.max(1, screen.getAllDisplays().length);
      const usableDisplayCount = sources.filter((source) => !source.thumbnail.isEmpty()).length;
      cachedHealth = usableDisplayCount >= expectedDisplayCount
        ? { ready: true, status: "ready", checkedAt: now() }
        : {
            ready: false,
            status: "unavailable",
            checkedAt: now(),
            reason: usableDisplayCount > 0
              ? "OpenPets can see your monitors but cannot capture all of them yet. Restart OpenPets and check again."
              : sources.length > 0
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
      const describedSources = describeScreenSources(sources);
      const expectedDisplayCount = Math.max(1, screen.getAllDisplays().length);
      if (describedSources.length < expectedDisplayCount) {
        throw new Error("OpenPets could not capture every connected monitor.");
      }

      return describedSources.map(({ source, displayId, displayLabel, displayBounds, primary }) => {
        throwIfAborted(signal);
        let image = source.thumbnail;
        let jpeg = image.toJPEG(captureJpegQuality);
        for (const width of [1120, 960, 800, 640]) {
          if (jpeg.byteLength <= maxVisionScreenshotBytes) break;
          image = image.resize({ width, quality: "good" });
          jpeg = image.toJPEG(captureJpegQuality);
        }
        if (jpeg.byteLength === 0 || jpeg.byteLength > maxVisionScreenshotBytes) {
          throw new Error(`${displayLabel} exceeded the local Vision size limit.`);
        }
        return {
          image: Uint8Array.from(jpeg),
          mimeType: "image/jpeg" as const,
          displayId,
          displayLabel,
          ...(displayBounds ? { displayBounds } : {}),
          primary,
        };
      });
    },
  };
}

function describeScreenSources(
  sources: Awaited<ReturnType<typeof desktopCapturer.getSources>>,
): readonly {
  readonly source: (typeof sources)[number];
  readonly displayId: string;
  readonly displayLabel: string;
  readonly displayBounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly primary: boolean;
}[] {
  const displays = screen.getAllDisplays();
  const primaryId = String(screen.getPrimaryDisplay().id);
  const displaysById = new Map(displays.map((display) => [String(display.id), display]));
  const displayOrder = new Map(
    [...displays]
      .sort((left, right) => {
        const leftPrimary = String(left.id) === primaryId ? 0 : 1;
        const rightPrimary = String(right.id) === primaryId ? 0 : 1;
        return leftPrimary - rightPrimary || left.bounds.x - right.bounds.x || left.bounds.y - right.bounds.y;
      })
      .map((display, index) => [String(display.id), index]),
  );

  return sources
    .filter((source) => !source.thumbnail.isEmpty())
    .sort((left, right) => {
      const leftOrder = displayOrder.get(left.display_id) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = displayOrder.get(right.display_id) ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.name.localeCompare(right.name);
    })
    .map((source, index) => {
      const display = displaysById.get(source.display_id);
      const primary = source.display_id === primaryId;
      return {
        source,
        displayId: source.display_id || `monitor-${index + 1}`,
        displayLabel: primary ? "Primary monitor" : `Monitor ${index + 1}`,
        ...(display ? { displayBounds: { ...display.bounds } } : {}),
        primary,
      };
    });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  throw error;
}
