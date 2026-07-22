import { app } from "electron";

import { closeAllAgentPets } from "./agent-pet-controller.js";
import { shutdownDesktopAnalytics } from "./analytics.js";
import { disposeCodexAiBrain } from "./codex-ai-brain.js";
import { destroyDefaultPet } from "./default-pet-controller.js";
import { info } from "./logger.js";
import { stopLocalIpcServer } from "./local-ipc.js";
import { stopPluginService } from "./plugin-service.js";
import { shutdownPocketTtsService } from "./pockettts-service.js";
import { focusOpenTaskWindows, openControlCenterWindow } from "./windows.js";
import { shutdownVoicePlatform } from "./voice-platform.js";
import { uninstallVoiceConversationShortcut } from "./voice-conversation-shortcut.js";
import { shutdownVisionService } from "./vision-service.js";

let intentionalQuit = false;
let hardExitTimer: NodeJS.Timeout | null = null;
let cleanupStarted = false;
let cleanupFinished = false;

export function installAppLifecycle(): void {
  app.on("second-instance", () => {
    info("app", "second instance requested");
    console.log("Second OpenPets launch requested; opening Control Center.");
    focusOpenTaskWindows();
    openControlCenterWindow();
  });

  app.on("window-all-closed", () => {
    if (!intentionalQuit) {
      info("app", "all task windows closed; tray app kept alive");
      console.log("All OpenPets task windows closed; keeping tray app running.");
    }
  });

  app.on("activate", () => {
    info("app", "activate event; opening Control Center");
    openControlCenterWindow();
  });

  app.on("before-quit", (event) => {
    intentionalQuit = true;
    if (cleanupFinished) return;
    event.preventDefault();
    if (cleanupStarted) return;
    cleanupStarted = true;
    uninstallVoiceConversationShortcut();
    info("app", "before quit cleanup begin");
    scheduleHardExitFallback("before-quit");
    void (async () => {
      await shutdownVisionService();
      await shutdownVoicePlatform();
      disposeCodexAiBrain();
      await shutdownPocketTtsService();
      stopPluginService();
      stopLocalIpcServer();
      closeAllAgentPets();
      destroyDefaultPet();
      shutdownDesktopAnalytics();
    })().finally(() => {
      cleanupFinished = true;
      info("app", "before quit cleanup complete");
      app.quit();
    });
  });
}

export function quitOpenPets(): void {
  intentionalQuit = true;
  info("app", "quit requested");
  scheduleHardExitFallback("quit-requested");
  app.quit();
}

function scheduleHardExitFallback(reason: string): void {
  if (hardExitTimer) return;
  hardExitTimer = setTimeout(() => {
    info("app", "hard exit fallback", { reason });
    app.exit(0);
  }, 2_000);
  hardExitTimer.unref?.();
}
