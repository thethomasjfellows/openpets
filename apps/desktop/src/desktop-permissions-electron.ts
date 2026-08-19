import { app, desktopCapturer, shell, systemPreferences } from "electron";

import {
  createDesktopPermissionRestartController,
  DesktopPermissionService,
  type DesktopPermissionDependencies,
} from "./desktop-permissions.js";

let sharedPermissionService: DesktopPermissionService | null = null;
const permissionRestart = createDesktopPermissionRestartController({
  argv: process.argv,
  relaunch: (options) => { app.relaunch({ args: [...options.args] }); },
  exit: () => { app.exit(0); },
});

export function getDesktopPermissionService(): DesktopPermissionService {
  sharedPermissionService ??= new DesktopPermissionService(electronDependencies());
  return sharedPermissionService;
}

export function restartOpenPetsForPermissions(): boolean {
  return permissionRestart.restart();
}

function electronDependencies(): DesktopPermissionDependencies {
  return {
    platform: process.platform,
    executablePath: process.execPath,
    getMediaAccessStatus: (kind) => systemPreferences.getMediaAccessStatus(kind),
    askForMicrophone: () => systemPreferences.askForMediaAccess("microphone"),
    requestScreenCapture: async () => {
      await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 32, height: 20 }, fetchWindowIcons: false });
    },
    probeScreenAccess: async () => {
      try {
        const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 32, height: 20 }, fetchWindowIcons: false });
        return sources.some((source) => !source.thumbnail.isEmpty()) ? "granted" : "unknown";
      } catch {
        const status = systemPreferences.getMediaAccessStatus("screen");
        return status === "denied" || status === "restricted" ? "denied" : "unknown";
      }
    },
    openExternal: (url) => shell.openExternal(url),
  };
}
