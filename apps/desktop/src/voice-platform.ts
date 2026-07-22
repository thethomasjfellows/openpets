import { getAppStateSnapshot } from "./app-state.js";
import { CompanionOrchestrator } from "./companion-orchestrator.js";
import { CompanionProactiveService } from "./companion-proactive-service.js";
import { CodexCompanionTarget } from "./companion-target-codex.js";
import { getCodexAiBrain } from "./codex-ai-brain.js";
import { getPreferredCodexCommand } from "./codex-command.js";
import { getCompanionSettings } from "./companion-settings.js";
import { HostAiCompanionTarget } from "./companion-target-host-ai.js";
import { clearDefaultPetTransientDisplay, getDefaultPetPaused, getDefaultPetWindowForPlugins, isDefaultPetVisible } from "./default-pet-controller.js";
import { debug, info, warn } from "./logger.js";
import type { ElectronPluginHostCapabilities } from "./plugin-host-capabilities.js";
import { getPocketTtsService } from "./pockettts-service.js";
import { getLocalTranscriptionService } from "./voice-local-transcription.js";
import { showInstalledPetHostBubble } from "./plugin-pet-registry.js";
import { requestPetWindowSystemVoices, setPetVoiceListeningState } from "./pet-window.js";
import { VoiceCaptureService } from "./voice-capture.js";
import { CodexConversationTarget } from "./voice-conversation-codex.js";
import { VoiceListeningService } from "./voice-listening-service.js";
import { VoiceOutputService } from "./voice-output-service.js";
import { VoicePrivacyIndicator } from "./voice-privacy-indicator.js";
import { VoiceProviderRegistry } from "./voice-provider-registry.js";
import { VoiceTranscriptionService } from "./voice-transcription-service.js";
import { VoiceTranscriptionRouter } from "./voice-transcription-router.js";
import { VoiceWakeCalibrationService } from "./voice-wake-calibration-service.js";
import { createProductionOfficialVoiceWakeRuntime } from "./voice-wake-official-runtime.js";
import { VoiceWakeWordService } from "./voice-wake-word-service.js";
import { getVisionContextSummaries, getVisionProactiveOpportunities } from "./vision-service.js";
import { acquireDefaultPetConversationPresentation } from "./pet-presentation-ownership.js";

type VoicePlatform = {
  readonly providers: VoiceProviderRegistry;
  readonly output: VoiceOutputService;
  readonly capture: VoiceCaptureService;
  readonly listening: VoiceListeningService;
  readonly transcription: VoiceTranscriptionRouter;
  readonly companion: CompanionOrchestrator;
  readonly proactive: CompanionProactiveService;
  readonly wake: VoiceWakeWordService;
  readonly wakeCalibration: VoiceWakeCalibrationService;
  readonly privacyIndicator: VoicePrivacyIndicator;
};

let activeVoicePlatform: VoicePlatform | null = null;
let voicePlatformStopping = false;

export function initializeVoicePlatform(capabilities: ElectronPluginHostCapabilities): VoicePlatform {
  if (activeVoicePlatform) return activeVoicePlatform;
  if (voicePlatformStopping) throw new Error("Voice platform shutdown is still in progress.");
  const providers = new VoiceProviderRegistry({
    secrets: capabilities.secretsStore,
    getDefaultWindow: getDefaultPetWindowForPlugins,
    listSystemVoices: requestPetWindowSystemVoices,
    pocketTts: getPocketTtsService() ?? undefined,
  });
  const output = new VoiceOutputService(providers);
  const privacyIndicator = new VoicePrivacyIndicator();
  const capture = new VoiceCaptureService(privacyIndicator);
  const localTranscription = getLocalTranscriptionService();
  if (!localTranscription) throw new Error("Local speech recognition is still starting.");
  const transcriptionGateway = new VoiceTranscriptionRouter({ local: localTranscription, secrets: capabilities.secretsStore });
  const transcription = new VoiceTranscriptionService(transcriptionGateway);
  const contributions = capabilities.companionContributions;
  const companion = new CompanionOrchestrator({
    targets: [new CodexCompanionTarget(new CodexConversationTarget({
      command: getPreferredCodexCommand(),
      getModel: () => getCodexAiBrain().resolveSelectedExecutableModel(),
      getReasoningEffort: () => getCompanionSettings().codex.reasoningEffort,
    })), new HostAiCompanionTarget(capabilities.aiGateway)],
    output,
    getAppState: getAppStateSnapshot,
    showBubble: showInstalledPetHostBubble,
    log: (level, message, fields) => {
      if (level === "debug") debug("companion", message, fields);
      else if (level === "warn") warn("companion", message, fields);
      else info("companion", message, fields);
    },
    getVisionSummaries: getVisionContextSummaries,
    isProactiveTurnValid: ({ petId, proactive, now }) => {
      const appState = getAppStateSnapshot();
      if (appState.preferences.defaultPetId !== petId || !isDefaultPetVisible() || getDefaultPetPaused()) return false;
      if (proactive.source === "vision") {
        return getVisionProactiveOpportunities(petId, now).some((opportunity) => opportunity.id === proactive.candidateId);
      }
      if (proactive.source === "plugin") {
        return contributions.snapshot({ includeFutureOpportunities: true, now }).opportunities
          .some((opportunity) => opportunity.id === proactive.candidateId);
      }
      return true;
    },
    getPluginFacts: (petId) => {
      if (petId !== getAppStateSnapshot().preferences.defaultPetId) return [];
      return contributions.snapshot().facts.map((fact) => ({ id: fact.id, pluginId: fact.pluginId, sensitivity: fact.sensitivity, sourceLabel: fact.pluginId, text: fact.text, expiresAt: fact.expiresAt }));
    },
    getPluginFactsById: (petId, ids) => {
      if (petId !== getAppStateSnapshot().preferences.defaultPetId || ids.length === 0) return [];
      const requested = new Set(ids);
      const snapshot = contributions.snapshot({ includeFutureOpportunities: true });
      return [
        ...snapshot.facts.map((fact) => ({ id: fact.id, pluginId: fact.pluginId, sensitivity: fact.sensitivity, sourceLabel: fact.pluginId, text: fact.text, expiresAt: fact.expiresAt })),
        ...snapshot.opportunities.map((opportunity) => ({ id: opportunity.id, pluginId: opportunity.pluginId, sensitivity: opportunity.sensitivity, sourceLabel: opportunity.pluginId, text: opportunity.context, expiresAt: opportunity.expiresAt })),
      ].filter((fact) => requested.has(fact.id));
    },
  });
  const wakeRuntime = createProductionOfficialVoiceWakeRuntime({
    log: (level, message, fields) => {
      if (level === "debug") debug("app", message, fields);
      else if (level === "warn") warn("app", message, fields);
      else info("app", message, fields);
    },
  });
  let wake: VoiceWakeWordService;
  wake = new VoiceWakeWordService({
      runtime: wakeRuntime,
      capture,
      transcription,
      companion,
      output,
      acknowledgement: {
        showListening: ({ petId, followUp, completedText }) => {
          const window = getDefaultPetWindowForPlugins();
          if (window) setPetVoiceListeningState(window, "listening");
          showInstalledPetHostBubble(petId, completedText ?? "", {
            suppressNarration: true,
            durationMs: followUp ? 3_000 : 8_000,
            voiceIndicator: "listening",
            showCloseButton: true,
            onDismiss: () => { wake.cancelConversation("bubble-close"); },
          });
        },
        showThinking: ({ petId }) => {
          const window = getDefaultPetWindowForPlugins();
          if (window) setPetVoiceListeningState(window, "thinking");
          showInstalledPetHostBubble(petId, "Let me check…", {
            suppressNarration: true,
            reaction: "working",
            durationMs: 30_000,
            showCloseButton: true,
            onDismiss: () => { wake.cancelConversation("bubble-close"); },
          });
        },
        clearListening: ({ clearBubble }) => {
          const window = getDefaultPetWindowForPlugins();
          if (window) setPetVoiceListeningState(window, "idle");
          if (clearBubble) clearDefaultPetTransientDisplay();
        },
      },
      presentation: { acquire: acquireDefaultPetConversationPresentation },
      getDefaultPetId: () => getAppStateSnapshot().preferences.defaultPetId,
      log: (level, message, fields) => {
        if (level === "debug") debug("app", message, fields);
        else if (level === "warn") warn("app", message, fields);
        else info("app", message, fields);
      },
    });
  const listening = new VoiceListeningService({ capture, transcription, wake });
  const wakeCalibration = new VoiceWakeCalibrationService({
    capture,
    runtime: wakeRuntime,
    transcription: localTranscription,
    wake,
    log: (level, message, fields) => {
      if (level === "warn") warn("app", message, fields);
      else info("app", message, fields);
    },
  });
  const proactive = new CompanionProactiveService({
    orchestrator: companion,
    getListeningSnapshot: () => listening.getSnapshot(),
    getWakeSnapshot: () => wake.snapshot(),
    getOutputActivity: () => output.getActivitySnapshot(),
    getVisionOpportunities: getVisionProactiveOpportunities,
    getOpportunities: () => contributions.snapshot({ includeFutureOpportunities: true }).opportunities.map((opportunity) => ({
      id: opportunity.id,
      dedupeKey: `${opportunity.pluginId}:${opportunity.dedupeKey}`,
      source: "plugin" as const,
      pluginId: opportunity.pluginId,
      earliestAt: opportunity.earliestAt,
      expiresAt: opportunity.expiresAt,
      cooldownMs: opportunity.cooldownMs,
      text: "An approved plugin has offered a low-urgency conversation opportunity. Decide whether a brief, natural check-in would be welcome; do not repeat plugin wording.",
      fact: { id: opportunity.id, pluginId: opportunity.pluginId, sensitivity: opportunity.sensitivity, sourceLabel: opportunity.pluginId, text: opportunity.context, expiresAt: opportunity.expiresAt },
    })),
    consumeOpportunity: (id) => { contributions.consumeOpportunity(id); },
  });
  activeVoicePlatform = { providers, output, capture, listening, transcription: transcriptionGateway, companion, proactive, wake, wakeCalibration, privacyIndicator };
  void (async () => {
    const transcriptionHealth = await transcriptionGateway.health();
    if (getCompanionSettings().wake.enabled && !transcriptionHealth.ready) {
      warn("app", "wake listening is blocked until speech recognition is configured", { reason: transcriptionHealth.reason });
    }
    await wake.syncFromSettings();
  })().catch((error) => {
    warn("app", "wake settings could not be applied at startup", {
      reason: error instanceof Error ? error.message : "unknown",
    });
  });
  proactive.start();
  info("app", "voice platform initialized", { wakeReady: wakeRuntime.health().ready });
  return activeVoicePlatform;
}

export function getVoicePlatform(): VoicePlatform | null {
  return activeVoicePlatform;
}

export function getVoiceOutputService(): VoiceOutputService | null {
  return activeVoicePlatform?.output ?? null;
}

export function getVoiceListeningService(): VoiceListeningService | null {
  return activeVoicePlatform?.listening ?? null;
}

export async function shutdownVoicePlatform(): Promise<void> {
  const platform = activeVoicePlatform;
  activeVoicePlatform = null;
  if (!platform) return;
  voicePlatformStopping = true;
  try {
    try { platform.proactive.stop(); } catch { /* idempotent cleanup */ }
    try { await platform.wakeCalibration.dispose(); } catch (error) { warn("app", "wake phrase setup shutdown failed", { reason: error instanceof Error ? error.message : String(error) }); }
    try { await platform.wake.dispose(); } catch (error) { warn("app", "wake listening shutdown failed", { reason: error instanceof Error ? error.message : String(error) }); }
    try { await platform.listening.shutdown(); } catch (error) { warn("app", "voice listening shutdown failed", { reason: error instanceof Error ? error.message : String(error) }); }
    try { await platform.capture.shutdown(); } catch (error) { warn("app", "voice capture shutdown failed", { reason: error instanceof Error ? error.message : String(error) }); }
    try { platform.output.cancelAll(); } catch (error) { warn("app", "voice output shutdown failed", { reason: error instanceof Error ? error.message : String(error) }); }
    try { platform.privacyIndicator.shutdown(); } catch { /* idempotent cleanup */ }
    try { platform.companion.dispose(); } catch { /* idempotent cleanup */ }
    try { platform.providers.dispose(); } catch { /* idempotent cleanup */ }
    info("app", "voice platform stopped");
  } finally {
    voicePlatformStopping = false;
  }
}
