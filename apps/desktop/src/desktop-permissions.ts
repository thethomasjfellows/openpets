export type DesktopPermissionKind = "microphone" | "screen-recording";
export type DesktopPermissionStatus = "granted" | "denied" | "restricted" | "not-determined" | "unknown" | "unsupported";

export type DesktopPermissionSnapshot = {
  readonly platform: NodeJS.Platform;
  readonly appLocation: "applications" | "development" | "other";
  readonly permissions: Record<DesktopPermissionKind, {
    readonly status: DesktopPermissionStatus;
    readonly canRequest: boolean;
    readonly canOpenSettings: boolean;
    readonly requiresRestartAfterGrant: boolean;
  }>;
};

export type DesktopPermissionDependencies = {
  readonly platform: NodeJS.Platform;
  readonly executablePath: string;
  getMediaAccessStatus(kind: "microphone" | "screen"): string;
  askForMicrophone(): Promise<boolean>;
  requestScreenCapture(): Promise<void>;
  probeScreenAccess?(): Promise<"granted" | "denied" | "unknown">;
  openExternal(url: string): Promise<unknown>;
};

export const desktopPermissionRestartMarker = "--openpets-permission-restart";

export type DesktopPermissionRestartDependencies = {
  readonly argv: readonly string[];
  relaunch(options: { readonly args: readonly string[] }): void;
  exit(): void;
};

export function createDesktopPermissionRestartController(deps: DesktopPermissionRestartDependencies): {
  restart(): boolean;
} {
  let scheduled = false;
  return {
    restart(): boolean {
      if (scheduled) return false;
      scheduled = true;
      const args = deps.argv
        .slice(1)
        .filter((argument) => argument !== desktopPermissionRestartMarker);
      deps.relaunch({ args: [...args, desktopPermissionRestartMarker] });
      // Electron's documented immediate-restart sequence is relaunch followed
      // by exit. A normal app.quit() completed shutdown in the packaged macOS
      // app without allowing the scheduled replacement process to start.
      deps.exit();
      return true;
    },
  };
}

export function isDesktopPermissionRestart(argv: readonly string[]): boolean {
  return argv.includes(desktopPermissionRestartMarker);
}

const settingsUrls: Record<DesktopPermissionKind, string> = {
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  "screen-recording": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
};

export class DesktopPermissionService {
  readonly #deps: DesktopPermissionDependencies;
  #screenProbeStatus: DesktopPermissionStatus | null = null;

  constructor(deps: DesktopPermissionDependencies) {
    this.#deps = deps;
  }

  snapshot(): DesktopPermissionSnapshot {
    const mac = this.#deps.platform === "darwin";
    const rawScreenStatus = mac ? normalizeStatus(this.#deps.getMediaAccessStatus("screen")) : "unsupported";
    return {
      platform: this.#deps.platform,
      appLocation: classifyAppLocation(this.#deps.executablePath),
      permissions: {
        microphone: {
          status: mac ? normalizeStatus(this.#deps.getMediaAccessStatus("microphone")) : "unsupported",
          canRequest: mac,
          canOpenSettings: mac,
          requiresRestartAfterGrant: false,
        },
        "screen-recording": {
          // The asynchronous capture probe observes the permission that this
          // exact running executable can actually use. Treat both success and
          // failure as more authoritative than macOS's sometimes-stale status.
          status: this.#screenProbeStatus ?? rawScreenStatus,
          canRequest: mac,
          canOpenSettings: mac,
          requiresRestartAfterGrant: true,
        },
      },
    };
  }

  async refresh(): Promise<DesktopPermissionSnapshot> {
    if (this.#deps.platform === "darwin" && this.#deps.probeScreenAccess) {
      try {
        const result = await this.#deps.probeScreenAccess();
        this.#screenProbeStatus = result === "granted" ? "granted" : result === "denied" ? "denied" : null;
      } catch {
        this.#screenProbeStatus = null;
      }
    }
    return this.snapshot();
  }

  async request(kind: DesktopPermissionKind): Promise<DesktopPermissionSnapshot> {
    assertPermissionKind(kind);
    if (this.#deps.platform !== "darwin") return this.snapshot();
    if (kind === "microphone") {
      const granted = await this.#deps.askForMicrophone();
      if (!granted) await this.#deps.openExternal(settingsUrls.microphone);
    } else {
      try {
        await this.#deps.requestScreenCapture();
      } catch {
        // A denied Screen Recording request may reject before Electron can
        // enumerate sources. The settings pane is still the recovery path.
      }
      const refreshed = await this.refresh();
      if (refreshed.permissions["screen-recording"].status !== "granted") {
        await this.#deps.openExternal(settingsUrls["screen-recording"]);
      }
      return refreshed;
    }
    return this.refresh();
  }

  async openSettings(kind: DesktopPermissionKind): Promise<DesktopPermissionSnapshot> {
    assertPermissionKind(kind);
    if (this.#deps.platform === "darwin") await this.#deps.openExternal(settingsUrls[kind]);
    return this.snapshot();
  }
}

function classifyAppLocation(executablePath: string): DesktopPermissionSnapshot["appLocation"] {
  const normalized = executablePath.replace(/\\/g, "/");
  if (/\/Applications\/[^/]+\.app\/Contents\/MacOS\//.test(normalized)) return "applications";
  if (/\/dist-electron\/|\/node_modules\/electron\//.test(normalized)) return "development";
  return "other";
}

function normalizeStatus(value: string): DesktopPermissionStatus {
  if (value === "granted" || value === "denied" || value === "restricted" || value === "not-determined" || value === "unknown") return value;
  return "unknown";
}

function assertPermissionKind(value: unknown): asserts value is DesktopPermissionKind {
  if (value !== "microphone" && value !== "screen-recording") throw new Error("Invalid desktop permission.");
}
