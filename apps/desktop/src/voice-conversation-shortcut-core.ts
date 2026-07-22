export const voiceConversationCancelAccelerator = "Control+`";

export type VoiceShortcutRegistrar = {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
};

export function registerVoiceConversationShortcut(registrar: VoiceShortcutRegistrar, onCancel: () => void): boolean {
  return registrar.register(voiceConversationCancelAccelerator, onCancel);
}
