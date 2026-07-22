import { globalShortcut } from "electron";

import { info, warn } from "./logger.js";
import { registerVoiceConversationShortcut, voiceConversationCancelAccelerator, type VoiceShortcutRegistrar } from "./voice-conversation-shortcut-core.js";

export { voiceConversationCancelAccelerator } from "./voice-conversation-shortcut-core.js";

let installed = false;

export function installVoiceConversationShortcut(onCancel: () => void, registrar: VoiceShortcutRegistrar = globalShortcut): boolean {
  if (installed) return true;
  try {
    installed = registerVoiceConversationShortcut(registrar, onCancel);
  } catch (error) {
    installed = false;
    warn("app", "voice cancel shortcut registration failed", { reason: error instanceof Error ? error.message : String(error) });
    return false;
  }
  if (installed) info("app", "voice cancel shortcut registered", { accelerator: voiceConversationCancelAccelerator });
  else warn("app", "voice cancel shortcut unavailable", { accelerator: voiceConversationCancelAccelerator });
  return installed;
}

export function uninstallVoiceConversationShortcut(registrar: VoiceShortcutRegistrar = globalShortcut): void {
  if (!installed) return;
  try { registrar.unregister(voiceConversationCancelAccelerator); } catch { /* Electron also clears shortcuts on quit */ }
  installed = false;
}
