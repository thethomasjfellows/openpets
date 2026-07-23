import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import sharp from "sharp";

import { app, BrowserWindow, dialog, ipcMain, protocol, shell, type IpcMainInvokeEvent, type OpenDialogOptions } from "electron";

import { getAgentSetupSnapshot, launchCodexHookReview, runAgentSetupAction, updateAgentSetupCommandPaths } from "./agent-setup.js";
import { refreshAgentPetContent } from "./agent-pet-controller.js";
import { getAppStateSnapshot, getDesktopAnalyticsConsentState, normalizePetPoolOrder, petScaleOptions, setDesktopAnalyticsConsent, setPetPoolOrder, updateCodexReactionPreferences, updatePreferences, type OpenPetsStateV1 } from "./app-state.js";
import { applyRoamingToAllPets } from "./pet-roaming-controller.js";
import { classifyAnalyticsError, trackDesktopAnalyticsConsentChanged, trackDesktopEvent } from "./analytics.js";
import { createAppIcon } from "./assets.js";
import { clearCompanionMemory, getCompanionMemorySnapshot, removeCompanionMemoryForPet } from "./companion-memory.js";
import { companionCharacterFieldLimits, disableCompanion, enableCompanion, getCompanionSettings, removeCompanionCharacterSettings, updateCompanionCharacterSettings, updateCompanionSettings, type CompanionCharacterProfile } from "./companion-settings.js";
import { companionTargetIds, type CompanionTargetId } from "./companion-types.js";
import { getCodexAiBrain } from "./codex-ai-brain.js";
import { getCatalogPageUiState, getCatalogSearchUiState, getCatalogUiState } from "./catalog.js";
import { getCodexPetsUiState, importCodexPet, readCodexPetSpritesheet } from "./codex-pets.js";
import { setConfinementEnabled } from "./confinement-manager.js";
import { setCrossDisplayRoamingEnabled } from "./display.js";
import type { DesktopPermissionKind } from "./desktop-permissions.js";
import { getDesktopPermissionService, restartOpenPetsForPermissions } from "./desktop-permissions-electron.js";
import { getActiveLocale, getActiveMessages, LOCALE_LABELS, SUPPORTED_LOCALES, setLocaleFromPreference, t, type Locale, type LocalePreference } from "./i18n/index.js";
import { recoverDefaultPetMouseInterop, refreshDefaultPetContent, resetDefaultPetToInitialPosition } from "./default-pet-controller.js";
import { getLanStatusSnapshot } from "./lan-controller.js";
import { validatePreferencePatch } from "./preference-patch.js";
import { installPet, installPetFromFolder, installPetFromZipFile, removePet, setDefaultInstalledPet } from "./pet-installation.js";
import { assertSafePetId, getInstalledPetDir } from "./pet-paths.js";
import { debug, error as logError, warn } from "./logger.js";
import { getPluginService, type PluginConfigSoundPickResult, type PluginServiceResult } from "./plugin-service.js";
import { defaultPetSprite, reactionAnimationMetadata, selectableAnimationMetadata } from "./reaction-animation-mapping.js";
import { readSafePluginManifest } from "./plugin-manifest-reader.js";
import { registerPluginAssetProtocol } from "./plugin-asset-protocol.js";
import { checkForGitHubReleaseUpdate, getUpdateStatus, openUpdateReleasePage } from "./update-checker.js";
import { getVoicePlatform } from "./voice-platform.js";
import { getLocalTranscriptionService } from "./voice-local-transcription.js";
import { getVoiceSecretStatus, setVoiceSecret, type VoiceSecretProviderId } from "./voice-secrets.js";
import { getVoiceSettings, getVoiceSettingsSnapshot, updateVoiceSettings, voiceProviderIds, type VoiceProviderId } from "./voice-settings.js";
import { getVoiceTranscriptionSettings, updateVoiceTranscriptionSettings } from "./voice-transcription-settings.js";
import { getVisionSnapshot, invalidateVisionSummaryHealth, pauseVision, resumeVision, setVisionEnabled } from "./vision-service.js";

type InternalUiWindowKind = "control-center";
export type ControlCenterRoute = "dashboard" | "pets" | "settings" | "plugins" | "integrations";
export type ControlCenterSection = "companion";
export type ControlCenterRouteRequest = {
  readonly route: ControlCenterRoute;
  readonly petId?: string;
  readonly section?: ControlCenterSection;
  readonly notice?: "pet-unavailable";
};

const controlCenterRoutes = new Set<ControlCenterRoute>(["dashboard", "pets", "settings", "plugins", "integrations"]);
let controlCenterWindow: BrowserWindow | null = null;
let internalUiHandlersInstalled = false;
let pendingControlCenterRoute: ControlCenterRouteRequest | null = null;
let pendingDockTimer: NodeJS.Timeout | null = null;
let lastDockHideAt = 0;
const dockHideShowCooldownMs = 1100;

function validateVoiceProviderId(value: unknown): VoiceProviderId {
  if (!voiceProviderIds.includes(value as VoiceProviderId)) throw new Error("Invalid voice provider.");
  return value as VoiceProviderId;
}

function validateCompanionTargetId(value: unknown): CompanionTargetId {
  if (!companionTargetIds.includes(value as CompanionTargetId)) throw new Error("Invalid companion target.");
  return value as CompanionTargetId;
}

function validateDesktopPermissionKind(value: unknown): DesktopPermissionKind {
  if (value !== "microphone" && value !== "screen-recording") throw new Error("Invalid desktop permission.");
  return value;
}

function validateCompanionCharacterDraft(value: unknown): CompanionCharacterProfile {
  if (!isPlainObject(value)) throw new Error("Invalid character draft.");
  const field = (key: keyof CompanionCharacterProfile): string => {
    const text = value[key];
    if (typeof text !== "string") throw new Error(`Invalid character field: ${key}.`);
    return text.replace(/\0/g, "").trim().slice(0, companionCharacterFieldLimits[key]);
  };
  return {
    visibleName: field("visibleName"), species: field("species"), origin: field("origin"),
    appearance: field("appearance"), personality: field("personality"), quirks: field("quirks"), lifeStory: field("lifeStory"),
  };
}

async function validateCodexSettingsPatch(patch: unknown): Promise<unknown> {
  if (!isPlainObject(patch) || !isPlainObject(patch.codex)) return patch;
  const codexPatch = patch.codex;
  if (codexPatch.model !== undefined && typeof codexPatch.model !== "string") throw new Error("Invalid Codex model.");
  if (codexPatch.reasoningEffort !== undefined && typeof codexPatch.reasoningEffort !== "string") throw new Error("Invalid Codex reasoning effort.");
  const previous = getCompanionSettings().codex;
  const modelChanged = Object.prototype.hasOwnProperty.call(codexPatch, "model");
  const modelId = (typeof codexPatch.model === "string" ? codexPatch.model : previous.model).trim();
  const reasoningEffort = (typeof codexPatch.reasoningEffort === "string"
    ? codexPatch.reasoningEffort
    : modelChanged ? "" : previous.reasoningEffort).trim();
  const discovery = await getCodexAiBrain().discoverModels();
  if (discovery.status !== "ready") throw new Error(discovery.reason ?? "Codex models are unavailable.");
  const model = modelId
    ? discovery.models.find((entry) => entry.id === modelId || entry.model === modelId)
    : discovery.models.find((entry) => entry.isDefault) ?? discovery.models[0];
  if (!model) throw new Error("The selected Codex model is no longer available.");
  if (reasoningEffort && !model.supportedReasoningEfforts.some((entry) => entry.value === reasoningEffort)) {
    throw new Error(`${model.displayName} does not support the selected reasoning effort.`);
  }
  return { ...patch, codex: { ...codexPatch, model: modelId ? model.model : "", reasoningEffort } };
}

function requireVoicePlatform() {
  const platform = getVoicePlatform();
  if (!platform) throw new Error("Voice platform is still starting.");
  return platform;
}

async function syncWakeFromSettings(): Promise<void> {
  const wake = getVoicePlatform()?.wake;
  if (!wake) return;
  await wake.syncFromSettings();
}

function hasOpenInternalUiWindows(): boolean {
  if (controlCenterWindow && !controlCenterWindow.isDestroyed()) return true;
  return false;
}

function syncDockVisibilityForInternalUi(): void {
  if (process.platform !== "darwin") return;
  const dock = app.dock;
  if (!dock) return;

  if (pendingDockTimer) {
    clearTimeout(pendingDockTimer);
    pendingDockTimer = null;
  }

  if (hasOpenInternalUiWindows()) {
    const elapsedSinceHide = Date.now() - lastDockHideAt;
    const delayMs = elapsedSinceHide < dockHideShowCooldownMs ? dockHideShowCooldownMs - elapsedSinceHide : 0;
    pendingDockTimer = setTimeout(() => {
      pendingDockTimer = null;
      dock.setIcon(createAppIcon());
      dock.show();
    }, delayMs);
  } else {
    dock.hide();
    lastDockHideAt = Date.now();
  }
}

function getPetsStateSnapshot(): { preferences: { defaultPetId: string }; pets: ReturnType<typeof getAppStateSnapshot>["pets"] } {
  const state = getAppStateSnapshot();
  return { preferences: { defaultPetId: state.preferences.defaultPetId }, pets: state.pets };
}

function getSettingsStateSnapshot(): {
  preferences: Pick<ReturnType<typeof getAppStateSnapshot>["preferences"], "openDefaultPetOnLaunch" | "readSpeechBubblesAloud" | "petScale" | "reactionAnimationOverrides" | "petPoolOrder" | "petPoolEnabled" | "petConfinementEnabled" | "petCrossDisplayEnabled" | "petGravityEnabled">;
  petScaleOptions: typeof petScaleOptions;
  analytics: ReturnType<typeof getDesktopAnalyticsConsentState>;
  /** Non-broken, non-built-in installed pets available for pool selection. */
  petPoolCandidates: ReadonlyArray<{ readonly id: string; readonly displayName: string }>;
} {
  const state = getAppStateSnapshot();
  return {
    preferences: {
      openDefaultPetOnLaunch: state.preferences.openDefaultPetOnLaunch,
      readSpeechBubblesAloud: state.preferences.readSpeechBubblesAloud,
      petScale: state.preferences.petScale,
      reactionAnimationOverrides: state.preferences.reactionAnimationOverrides,
      petPoolOrder: state.preferences.petPoolOrder,
      petPoolEnabled: state.preferences.petPoolEnabled,
      petConfinementEnabled: state.preferences.petConfinementEnabled,
      petCrossDisplayEnabled: state.preferences.petCrossDisplayEnabled,
      petGravityEnabled: state.preferences.petGravityEnabled,
    },
    petScaleOptions,
    analytics: getDesktopAnalyticsConsentState(),
    petPoolCandidates: state.pets.installed
      .filter((p) => !p.builtIn && !p.broken && p.id !== state.preferences.defaultPetId)
      .map(({ id, displayName }) => ({ id, displayName })),
  };
}

function getI18nSnapshot(): {
  locale: Locale;
  localePreference: LocalePreference;
  availableLocales: { value: Locale; label: string }[];
  messages: ReturnType<typeof getActiveMessages>;
} {
  return {
    locale: getActiveLocale(),
    localePreference: getAppStateSnapshot().preferences.locale,
    availableLocales: SUPPORTED_LOCALES.map((value) => ({ value, label: LOCALE_LABELS[value] })),
    messages: getActiveMessages(),
  };
}

async function getDashboardSnapshot(): Promise<{
  readonly defaultPet: { readonly id: string; readonly displayName: string; readonly previewSpriteUrl: string };
  readonly installedPetCount: number;
  readonly catalog: { readonly source: string; readonly total?: number; readonly page?: number; readonly pageCount?: number; readonly error?: string };
  readonly plugins: { readonly installed: number; readonly enabled: number; readonly broken: number };
  readonly updateStatus: ReturnType<typeof getUpdateStatus>;
  readonly activity: Pick<ReturnType<typeof getAppStateSnapshot>["analytics"], "messagesSent" | "reactionsSent" | "reactionCounts" | "perPetActivityCounts" | "lastActivityAt">;
}> {
  const state = getAppStateSnapshot();
  const defaultPet = state.pets.installed.find((pet) => pet.id === state.preferences.defaultPetId && !pet.broken) ?? state.pets.installed[0];
  const preview = await getDefaultPetPreviewSpriteInfo();
  const catalog = await getCatalogUiState().catch((error: unknown) => ({ source: "error" as const, pets: [], total: undefined, page: undefined, pageCount: undefined, error: error instanceof Error ? error.message : "Catalog unavailable." }));
  const pluginSnapshot = await getPluginService().getSnapshot().catch((error: unknown) => {
    warn("ui", "dashboard plugin snapshot unavailable", { error: error instanceof Error ? error.message : String(error) });
    return { plugins: [] } as const;
  });
  const installedPlugins = pluginSnapshot.plugins.length;
  const brokenPlugins = pluginSnapshot.plugins.filter((plugin) => Boolean(plugin.brokenReason)).length;
  const enabledPlugins = pluginSnapshot.plugins.filter((plugin) => plugin.enabled && !plugin.brokenReason).length;

  return {
    defaultPet: {
      id: defaultPet?.id ?? state.preferences.defaultPetId,
      displayName: defaultPet?.displayName ?? "OpenPets",
      previewSpriteUrl: `openpets-pet-preview://spritesheet/default?v=${encodeURIComponent(preview.version)}`,
    },
    installedPetCount: state.pets.installed.length,
    catalog: {
      source: catalog.source,
      total: catalog.total,
      page: catalog.page,
      pageCount: catalog.pageCount,
      error: catalog.error,
    },
    plugins: {
      installed: installedPlugins,
      enabled: enabledPlugins,
      broken: brokenPlugins,
    },
    updateStatus: getUpdateStatus(),
    activity: {
      messagesSent: state.analytics.messagesSent,
      reactionsSent: state.analytics.reactionsSent,
      reactionCounts: state.analytics.reactionCounts,
      perPetActivityCounts: state.analytics.perPetActivityCounts,
      lastActivityAt: state.analytics.lastActivityAt,
    },
  };
}

export function installInternalUiHandlers(): void {
  if (internalUiHandlersInstalled) {
    return;
  }

  internalUiHandlersInstalled = true;

  // Apply the persisted petConfinementEnabled preference as the initial value
  // for the confinement-manager flag. This runs once after app-state is loaded.
  setConfinementEnabled(getAppStateSnapshot().preferences.petConfinementEnabled);
  setCrossDisplayRoamingEnabled(getAppStateSnapshot().preferences.petCrossDisplayEnabled);
  // Apply the persisted petGravityEnabled preference on startup.
  applyRoamingToAllPets();

  ipcMain.handle("openpets:get-pets-state", (event) => {
    assertAllowedSender(event, ["control-center"]);
    return getPetsStateSnapshot();
  });

  ipcMain.handle("openpets:get-settings-state", (event) => {
    assertAllowedSender(event, ["control-center"]);
    return getSettingsStateSnapshot();
  });

  ipcMain.handle("openpets:companion-settings-get", (event) => {
    assertAllowedSender(event, ["control-center"]);
    return getCompanionSettings();
  });

  ipcMain.handle("openpets:companion-enable", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    const settings = enableCompanion();
    await syncWakeFromSettings();
    trackDesktopEvent("desktop_companion_enabled", { frequency: settings.proactivity.frequency, target: settings.target });
    return settings;
  });

  ipcMain.handle("openpets:companion-disable", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    const settings = disableCompanion();
    getVoicePlatform()?.companion.cancelAll();
    await syncWakeFromSettings();
    trackDesktopEvent("desktop_companion_disabled");
    return settings;
  });

  ipcMain.handle("openpets:companion-settings-update", async (event, patch: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    const previous = getCompanionSettings();
    const wakePatch = isPlainObject(patch) && isPlainObject(patch.wake) ? patch.wake : null;
    const wakeChanged = typeof wakePatch?.enabled === "boolean" && wakePatch.enabled !== previous.wake.enabled;
    const enablingWake = wakeChanged && wakePatch?.enabled === true;
    if (enablingWake) {
      if (!previous.enabled) throw new Error("Enable Companion before wake listening.");
      if (!getVoiceSettings().wake.phrase.trim()) throw new Error("Choose a wake phrase first.");
      const health = requireVoicePlatform().wake.health();
      if (!health.ready) throw new Error(health.reason ?? "Wake listening is unavailable.");
      const transcription = await requireVoicePlatform().transcription.health();
      if (!transcription.ready) throw new Error(transcription.reason ?? "Configure speech recognition before enabling wake listening.");
    }

    const validatedPatch = await validateCodexSettingsPatch(patch);
    const settings = updateCompanionSettings(validatedPatch);
    const codexChanged = settings.codex.model !== previous.codex.model || settings.codex.reasoningEffort !== previous.codex.reasoningEffort;
    if (settings.target !== previous.target) getVoicePlatform()?.companion.cancelAll();
    if (settings.target !== previous.target || codexChanged) {
      getCodexAiBrain().invalidateImageSummaryHealth();
      invalidateVisionSummaryHealth();
    }
    if (wakeChanged) {
      try {
        await syncWakeFromSettings();
      } catch (error) {
        if (enablingWake) {
          updateCompanionSettings({ wake: { enabled: false } });
          await syncWakeFromSettings().catch(() => undefined);
        }
        warn("companion", "wake settings could not be applied", {
          reason: error instanceof Error ? error.message : "unknown",
        });
        throw error;
      }
    }
    debug("companion", "settings updated", { enabled: settings.enabled, target: settings.target, memoryEnabled: settings.memory.enabled, proactivityEnabled: settings.proactivity.enabled, frequency: settings.proactivity.frequency, wakeEnabled: settings.wake.enabled });
    return settings;
  });

  ipcMain.handle("openpets:companion-character-settings-update", (event, petId: unknown, patch: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof petId !== "string" || !getAppStateSnapshot().pets.installed.some((pet) => pet.id === petId && !pet.broken && !pet.brokenReason)) throw new Error("The selected pet is unavailable.");
    return updateCompanionCharacterSettings(petId, patch);
  });

  ipcMain.handle("openpets:companion-memory-status", (event) => {
    assertAllowedSender(event, ["control-center"]);
    const snapshot = getCompanionMemorySnapshot();
    return { entryCount: snapshot.entries.length, oldestCreatedAt: snapshot.entries[0]?.createdAt ?? null };
  });

  ipcMain.handle("openpets:companion-text-import", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: OpenDialogOptions = {
      title: "Import text notes",
      buttonLabel: "Import",
      properties: ["openFile"],
      filters: [{ name: "Text or Markdown", extensions: ["txt", "md", "markdown"] }],
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return { canceled: true } as const;
    const path = result.filePaths[0];
    if (!/\.(?:txt|md|markdown)$/i.test(path)) throw new Error("Choose a .txt or .md file.");
    const link = await lstat(path);
    if (link.isSymbolicLink()) throw new Error("Choose the original text file instead of a symbolic link.");
    const file = await stat(path);
    if (!file.isFile() || file.size > 64 * 1_024) throw new Error("That file is too large. Choose a text file under 64 KB.");
    const text = (await readFile(path, "utf8")).replace(/\0/g, "").trim();
    if (!text) throw new Error("That file is empty.");
    debug("companion", "text notes imported", { bytes: file.size });
    return { canceled: false, text } as const;
  });

  ipcMain.handle("openpets:companion-character-generate", async (event, request: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (!isPlainObject(request)
      || typeof request.petId !== "string"
      || (request.mode !== "complete" && request.mode !== "reimagine")) throw new Error("Invalid character generation request.");
    const sourceText = typeof request.sourceText === "string" ? request.sourceText.replace(/\0/g, "").trim() : undefined;
    if (sourceText && sourceText.length > 8_000) throw new Error("Character source notes must be 8,000 characters or fewer.");
    const result = await requireVoicePlatform().companion.generateCharacterDraft({
      petId: request.petId,
      mode: request.mode,
      draft: validateCompanionCharacterDraft(request.draft),
      ...(sourceText ? { sourceText } : {}),
    });
    debug("companion", "character draft generated", { petId: request.petId, mode: request.mode, targetId: result.targetId });
    return result;
  });

  ipcMain.handle("openpets:companion-memory-clear", (event, petId: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (petId !== undefined && typeof petId !== "string") throw new Error("Invalid pet id.");
    clearCompanionMemory(petId);
    debug("companion", "recent memory cleared", { petId: typeof petId === "string" ? petId : undefined });
    return { ok: true } as const;
  });

  ipcMain.handle("openpets:companion-target-health", async (event, targetId: unknown, force: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    const selected = targetId === undefined ? getCompanionSettings().target : validateCompanionTargetId(targetId);
    return requireVoicePlatform().companion.health(selected, force === true);
  });

  ipcMain.handle("openpets:codex-models", async (event, force: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    const snapshot = await getCodexAiBrain().discoverModels(force === true);
    debug("ui", "Codex model catalog checked", {
      status: snapshot.status,
      models: snapshot.models.length,
      force: force === true,
      ...(snapshot.status === "ready" ? {} : { reason: snapshot.reason }),
    });
    return snapshot;
  });

  ipcMain.handle("openpets:permissions-snapshot", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    return getDesktopPermissionService().refresh();
  });

  ipcMain.handle("openpets:permissions-request", async (event, kind: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    const permission = validateDesktopPermissionKind(kind);
    const snapshot = await getDesktopPermissionService().request(permission);
    debug("ui", "desktop permission requested", { permission, status: snapshot.permissions[permission].status, appLocation: snapshot.appLocation });
    return snapshot;
  });

  ipcMain.handle("openpets:permissions-open-settings", async (event, kind: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    return getDesktopPermissionService().openSettings(validateDesktopPermissionKind(kind));
  });

  ipcMain.handle("openpets:permissions-restart", (event) => {
    assertAllowedSender(event, ["control-center"]);
    restartOpenPetsForPermissions();
  });

  ipcMain.handle("openpets:vision-snapshot", async (event, forceHealth: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    return getVisionSnapshot(forceHealth === true);
  });

  ipcMain.handle("openpets:vision-set-enabled", async (event, enabled: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof enabled !== "boolean") throw new Error("Invalid Vision setting.");
    return setVisionEnabled(enabled);
  });

  ipcMain.handle("openpets:vision-pause", async (event, minutes: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (minutes !== 30 && minutes !== 60 && minutes !== 90) throw new Error("Vision pause must be 30, 60, or 90 minutes.");
    return pauseVision(minutes);
  });

  ipcMain.handle("openpets:vision-resume", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    return resumeVision();
  });

  ipcMain.handle("openpets:vision-model-preference-set", async (event, value: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    const companion = getCompanionSettings();
    const { getHostAiSettings } = await import("./host-ai-settings.js");
    const { setVisionModelPreference } = await import("./vision-settings.js");
    if (value === null || value === undefined) {
      setVisionModelPreference(undefined);
    } else {
      if (!isPlainObject(value) || typeof value.model !== "string" || !value.model.trim()) throw new Error("Choose a valid Vision model.");
      const model = value.model.trim().slice(0, 160);
      if (companion.target === "codex") {
        if (value.owner !== "codex") throw new Error("PetVision can only override the active AI Brain.");
        setVisionModelPreference({ owner: "codex", model });
      } else {
        const provider = getHostAiSettings().provider;
        if (provider === "none" || value.owner !== "host-ai" || value.provider !== provider) {
          throw new Error("PetVision can only override the active AI provider.");
        }
        setVisionModelPreference({ owner: "host-ai", provider, model });
      }
    }
    invalidateVisionSummaryHealth();
    return getVisionSnapshot(true);
  });

  ipcMain.handle("openpets:vision-image-health", async (event, request: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (!isPlainObject(request) || (request.kind !== "codex" && request.kind !== "host-ai")) throw new Error("Invalid Vision health request.");
    const model = typeof request.model === "string" ? request.model.trim().slice(0, 160) : "";
    if (request.kind === "codex") {
      return getCodexAiBrain().probeImageSummary({ force: request.force === true, ...(model ? { model } : {}) });
    }
    const { isHostAiProviderId } = await import("./host-ai-settings.js");
    if (!isHostAiProviderId(request.provider)) throw new Error("Unknown AI provider.");
    const { getPluginHostCapabilitiesForUi } = await import("./plugin-host-capabilities.js");
    const capabilities = getPluginHostCapabilitiesForUi();
    if (!capabilities) throw new Error("AI Brain is still starting.");
    return capabilities.aiGateway.probeImageSummary({
      provider: request.provider,
      force: request.force === true,
      ...(model ? { model } : {}),
    });
  });

  ipcMain.handle("openpets:vision-open-storage-folder", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    const snapshot = await getVisionSnapshot(false);
    const failure = await shell.openPath(snapshot.storage.dir);
    if (failure) throw new Error(`OpenPets could not open the Vision storage folder: ${failure}`);
    return { ok: true } as const;
  });

  ipcMain.handle("openpets:get-lan-status", (event) => {
    assertAllowedSender(event, ["control-center"]);
    return getLanStatusSnapshot();
  });

  ipcMain.handle("openpets:set-desktop-analytics-consent", (event, consent: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (consent !== "granted" && consent !== "denied" && consent !== "unset") throw new Error("Invalid analytics consent value.");
    setDesktopAnalyticsConsent(consent);
    trackDesktopAnalyticsConsentChanged(consent);
    return getSettingsStateSnapshot();
  });

  ipcMain.handle("openpets:get-i18n", (event) => {
    assertAllowedSender(event, ["control-center"]);
    return getI18nSnapshot();
  });

  ipcMain.handle("openpets:get-dashboard-snapshot", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    return getDashboardSnapshot();
  });

  ipcMain.handle("openpets:get-reaction-animation-settings", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    return getReactionAnimationSettingsSnapshot();
  });

  ipcMain.handle("openpets:plugins-snapshot", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    return getPluginService().getSnapshot();
  });

  ipcMain.handle("openpets:plugins-set-enabled", async (event, id: unknown, enabled: unknown): Promise<PluginServiceResult> => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/.test(id) || typeof enabled !== "boolean") return pluginUiError("Invalid plugin enable request.");
    const result = await getPluginService().setEnabled(id, enabled);
    if (result.ok) trackDesktopEvent(enabled ? "desktop_plugin_enabled" : "desktop_plugin_disabled", pluginTelemetryForSnapshot(result.snapshot, id));
    return result;
  });

  ipcMain.handle("openpets:plugins-save-config", async (event, id: unknown, config: unknown): Promise<PluginServiceResult> => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/.test(id) || !isPlainObject(config)) return pluginUiError("Invalid plugin config request.");
    return getPluginService().saveConfig(id, config);
  });

  ipcMain.handle("openpets:plugins-pick-config-sound", async (event, id: unknown): Promise<PluginConfigSoundPickResult> => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/.test(id)) {
      warn("ui", "Plugin sound pick invalid request.", { ok: false, reason: "invalid-plugin-id" });
      return pluginUiSoundError("Invalid plugin sound request.");
    }
    debug("ui", "Plugin sound pick requested.", { pluginId: id });
    try {
      const result = await getPluginService().pickConfigSound(id);
      if (result.ok && "sound" in result && result.sound.id) debug("ui", "Plugin sound pick succeeded.", { pluginId: id, ok: true, soundId: result.sound.id });
      else if (result.ok) debug("ui", "Plugin sound pick canceled.", { pluginId: id, ok: true, canceled: true });
      else warn("ui", "Plugin sound pick failed.", { pluginId: id, ok: false, reason: result.error });
      return result;
    } catch (error) {
      logError("ui", "Plugin sound pick errored.", { pluginId: id, ok: false, reason: error instanceof Error ? error.message : "unknown" });
      throw error;
    }
  });

  ipcMain.handle("openpets:plugins-reload", async (event, id: unknown): Promise<PluginServiceResult> => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/.test(id)) return pluginUiError("Invalid plugin reload request.");
    return getPluginService().reload(id);
  });

  ipcMain.handle("openpets:plugins-refresh-local", async (event, id: unknown): Promise<PluginServiceResult> => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/.test(id)) return pluginUiError("Invalid plugin refresh request.");
    return getPluginService().refreshLocal(id);
  });

  ipcMain.handle("openpets:plugins-execute-command", async (event, id: unknown, commandId: unknown, args: unknown): Promise<PluginServiceResult> => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/.test(id) || typeof commandId !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(commandId) || (args !== undefined && !isPlainObject(args))) return pluginUiError("Invalid plugin command request.");
    const result = await getPluginService().executeCommand(id, commandId, isPlainObject(args) ? args as Record<string, unknown> : undefined);
    if (result.ok) trackDesktopEvent("desktop_plugin_command_run", { ...pluginTelemetryForSnapshot(result.snapshot, id), command_known: true });
    return result;
  });

  ipcMain.handle("openpets:plugins-load-local", async (event): Promise<PluginServiceResult> => {
    assertAllowedSender(event, ["control-center"]);
    return getPluginService().loadLocal();
  });

  ipcMain.handle("openpets:plugins-catalog-snapshot", async (event, refresh: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    trackDesktopEvent("desktop_plugin_catalog_opened", { refresh: refresh === true });
    const snapshot = await getPluginService().getCatalogSnapshot(refresh === true);
    if (snapshot.error) trackDesktopEvent("desktop_catalog_fetch_failed", { catalog_kind: "plugin", error_code: classifyAnalyticsError(snapshot.error, "plugin_catalog_fetch_failed") });
    return snapshot;
  });

  ipcMain.handle("openpets:plugins-install-catalog", async (event, id: unknown): Promise<PluginServiceResult> => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/.test(id)) return pluginUiError("Invalid plugin install request.");
    trackDesktopEvent("desktop_plugin_install_started", { plugin_source: "catalog" });
    try {
      const result = await getPluginService().installCatalog(id);
      if (result.ok && isCatalogPluginInstalled(result.snapshot, id)) trackDesktopEvent("desktop_plugin_installed", { ...pluginTelemetryForSnapshot(result.snapshot, id), plugin_source: "catalog" });
      else if (!result.ok) trackDesktopEvent("desktop_plugin_install_failed", { plugin_source: "catalog", error_code: classifyAnalyticsError(result.error, "plugin_install_failed") });
      return result;
    } catch (error) {
      trackDesktopEvent("desktop_plugin_install_failed", { plugin_source: "catalog", error_code: classifyAnalyticsError(error, "plugin_install_failed") });
      throw error;
    }
  });

  ipcMain.handle("openpets:plugins-update-catalog", async (event, id: unknown): Promise<PluginServiceResult> => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/.test(id)) return pluginUiError("Invalid plugin update request.");
    return getPluginService().updateCatalog(id);
  });

  ipcMain.handle("openpets:plugins-uninstall", async (event, id: unknown): Promise<PluginServiceResult> => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/.test(id)) return pluginUiError("Invalid plugin uninstall request.");
    return getPluginService().uninstall(id);
  });

  ipcMain.handle("openpets:plugins-inspector", async (event, id: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/.test(id)) throw new Error("Invalid plugin inspector request.");
    return getPluginService().runtime.getInspectorState(id);
  });

  ipcMain.handle("openpets:plugin-platform-settings-get", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    const { getPluginPlatformSettings } = await import("./plugin-platform-settings.js");
    return getPluginPlatformSettings();
  });

  ipcMain.handle("openpets:plugin-platform-settings-update", async (event, patch: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (!isPlainObject(patch)) throw new Error("Invalid plugin platform settings patch.");
    const { updatePluginPlatformSettings } = await import("./plugin-platform-settings.js");
    const next = updatePluginPlatformSettings(patch as never);
    invalidateVisionSummaryHealth();
    return next;
  });

  ipcMain.handle("openpets:host-ai-settings-get", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    const { getHostAiSettings } = await import("./host-ai-settings.js");
    return getHostAiSettings();
  });

  ipcMain.handle("openpets:host-ai-provider-update", async (event, provider: unknown, patch: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    const { updateHostAiProviderConfig } = await import("./host-ai-settings.js");
    const { getPluginHostCapabilitiesForUi } = await import("./plugin-host-capabilities.js");
    const next = updateHostAiProviderConfig(provider, patch);
    getPluginHostCapabilitiesForUi()?.aiGateway.invalidateHealth();
    invalidateVisionSummaryHealth();
    debug("ui", "AI Brain provider settings updated", { provider, model: typeof provider === "string" && provider in next.providers ? next.providers[provider as keyof typeof next.providers].model : undefined });
    return next;
  });

  ipcMain.handle("openpets:host-ai-provider-select", async (event, provider: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    const { setActiveHostAiProvider } = await import("./host-ai-settings.js");
    const { getPluginHostCapabilitiesForUi } = await import("./plugin-host-capabilities.js");
    const next = setActiveHostAiProvider(provider);
    getPluginHostCapabilitiesForUi()?.aiGateway.invalidateHealth();
    invalidateVisionSummaryHealth();
    debug("ui", "active direct AI Brain selected", { provider });
    return next;
  });

  ipcMain.handle("openpets:host-ai-health", async (event, provider: unknown, force: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    const { isHostAiProviderId } = await import("./host-ai-settings.js");
    if (!isHostAiProviderId(provider)) throw new Error("Unknown AI provider.");
    const { getPluginHostCapabilitiesForUi } = await import("./plugin-host-capabilities.js");
    const capabilities = getPluginHostCapabilitiesForUi();
    if (!capabilities) throw new Error("AI Brain is still starting.");
    return capabilities.aiGateway.probeHealth({ provider, force: force === true });
  });

  ipcMain.handle("openpets:host-ai-models", async (event, provider: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    const { isHostAiProviderId } = await import("./host-ai-settings.js");
    if (!isHostAiProviderId(provider)) throw new Error("Unknown AI provider.");
    const { getPluginHostCapabilitiesForUi } = await import("./plugin-host-capabilities.js");
    const capabilities = getPluginHostCapabilitiesForUi();
    if (!capabilities) throw new Error("AI Brain is still starting.");
    return capabilities.aiGateway.listModels(provider);
  });

  ipcMain.handle("openpets:host-ai-key-set", async (event, provider: unknown, key: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    const { getPluginHostCapabilitiesForUi } = await import("./plugin-host-capabilities.js");
    const { isHostAiProviderId } = await import("./host-ai-settings.js");
    const { hostSecretsOwner, hostAiApiKeySecretForProvider } = await import("./host-ai-gateway.js");
    if (!isHostAiProviderId(provider) || provider === "ollama") throw new Error("This AI provider does not use an OpenPets API key.");
    const capabilities = getPluginHostCapabilitiesForUi();
    if (!capabilities) throw new Error("AI Brain is still starting.");
    const secretKey = hostAiApiKeySecretForProvider(provider);
    if (key === null || key === "") {
      await capabilities.secretsStore.delete(hostSecretsOwner, secretKey);
      capabilities.aiGateway.invalidateHealth();
      invalidateVisionSummaryHealth();
      return { provider, hasKey: false };
    }
    if (typeof key !== "string" || !key.trim() || key.length > 4096) throw new Error("Invalid AI API key.");
    await capabilities.secretsStore.set(hostSecretsOwner, secretKey, key.trim());
    capabilities.aiGateway.invalidateHealth();
    invalidateVisionSummaryHealth();
    return { provider, hasKey: true };
  });

  ipcMain.handle("openpets:host-ai-key-status", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    const { getPluginHostCapabilitiesForUi } = await import("./plugin-host-capabilities.js");
    const { hostAiProviderIds } = await import("./host-ai-settings.js");
    const { hostSecretsOwner, hostAiApiKeySecretForProvider } = await import("./host-ai-gateway.js");
    const capabilities = getPluginHostCapabilitiesForUi();
    const result: Record<string, { hasKey: boolean }> = {};
    for (const provider of hostAiProviderIds) {
      result[provider] = { hasKey: capabilities ? await capabilities.secretsStore.has(hostSecretsOwner, hostAiApiKeySecretForProvider(provider)) : false };
    }
    return result;
  });

  ipcMain.handle("openpets:voice-settings-get", (event) => {
    assertAllowedSender(event, ["control-center"]);
    const appState = getAppStateSnapshot();
    return getVoiceSettingsSnapshot(appState.pets.installed.filter((pet) => pet.id === appState.preferences.defaultPetId));
  });

  ipcMain.handle("openpets:voice-transcription-settings-get", (event) => {
    assertAllowedSender(event, ["control-center"]);
    return getVoiceTranscriptionSettings();
  });

  ipcMain.handle("openpets:voice-transcription-settings-update", async (event, patch: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    const settings = updateVoiceTranscriptionSettings(patch);
    debug("ui", "speech recognition settings updated", { providerId: settings.providerId, model: settings.model });
    await syncWakeFromSettings().catch((error) => {
      debug("ui", "wake listening is waiting for speech recognition", { reason: error instanceof Error ? error.message : "unknown" });
    });
    return settings;
  });

  ipcMain.handle("openpets:voice-transcription-health", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    return requireVoicePlatform().transcription.health();
  });

  ipcMain.handle("openpets:local-transcription-snapshot", (event) => {
    assertAllowedSender(event, ["control-center"]);
    const service = getLocalTranscriptionService();
    if (!service) throw new Error("Built-in speech recognition is still starting.");
    return service.snapshot();
  });

  ipcMain.handle("openpets:local-transcription-install", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    const service = getLocalTranscriptionService();
    if (!service) throw new Error("Built-in speech recognition is still starting.");
    const snapshot = await service.install();
    if (snapshot.status === "ready") {
      await syncWakeFromSettings().catch(() => undefined);
    }
    return snapshot;
  });

  ipcMain.handle("openpets:pockettts-snapshot", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    const { getPocketTtsService } = await import("./pockettts-service.js");
    const service = getPocketTtsService();
    if (!service) throw new Error("PocketTTS is still starting.");
    return service.snapshot();
  });

  ipcMain.handle("openpets:pockettts-install-enable", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    const { getPocketTtsService } = await import("./pockettts-service.js");
    const service = getPocketTtsService();
    if (!service) throw new Error("PocketTTS is still starting.");
    const voiceId = getVoiceSettings().providers.pockettts.voiceId;
    const snapshot = await service.installAndEnable(voiceId);
    if (snapshot.status !== "ready") return snapshot;
    updateVoiceSettings({
      providers: { pockettts: { baseUrl: snapshot.baseUrl, voiceId } },
      output: { providerId: "pockettts" },
    });
    getVoicePlatform()?.providers.invalidate("pockettts");
    return service.snapshot();
  });

  ipcMain.handle("openpets:pockettts-start", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    const { getPocketTtsService } = await import("./pockettts-service.js");
    const service = getPocketTtsService();
    if (!service) throw new Error("PocketTTS is still starting.");
    const snapshot = await service.start(getVoiceSettings().providers.pockettts.voiceId);
    getVoicePlatform()?.providers.invalidate("pockettts");
    return snapshot;
  });

  ipcMain.handle("openpets:pockettts-stop", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    const { getPocketTtsService } = await import("./pockettts-service.js");
    const service = getPocketTtsService();
    if (!service) throw new Error("PocketTTS is still starting.");
    const snapshot = await service.stop();
    if (getVoiceSettings().output.providerId === "pockettts") updateVoiceSettings({ output: { providerId: "system" } });
    getVoicePlatform()?.providers.invalidate("pockettts");
    return snapshot;
  });

  ipcMain.handle("openpets:pockettts-voices", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    const { getPocketTtsService } = await import("./pockettts-service.js");
    return getPocketTtsService()?.listVoices() ?? [];
  });

  ipcMain.handle("openpets:voice-settings-update", async (event, patch: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (!isPlainObject(patch)) throw new Error("Invalid voice settings patch.");
    const settings = updateVoiceSettings(patch);
    if (isPlainObject(patch.wake) && ("phrase" in patch.wake || "microphone" in patch.wake)) await syncWakeFromSettings();
    debug("ui", "voice settings updated", {
      providerId: settings.output.providerId,
      wakeMicrophone: settings.wake.microphone ? "saved-device" : "system-default",
    });
    const appState = getAppStateSnapshot();
    return getVoiceSettingsSnapshot(appState.pets.installed.filter((pet) => pet.id === appState.preferences.defaultPetId));
  });

  ipcMain.handle("openpets:voice-secret-status", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    const { getPluginHostCapabilitiesForUi } = await import("./plugin-host-capabilities.js");
    const capabilities = getPluginHostCapabilitiesForUi();
    return capabilities ? getVoiceSecretStatus(capabilities.secretsStore) : { "openai-compatible": { hasKey: false }, elevenlabs: { hasKey: false } };
  });

  ipcMain.handle("openpets:voice-secret-set", async (event, providerId: unknown, key: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (providerId !== "openai-compatible" && providerId !== "elevenlabs") throw new Error("Invalid voice secret provider.");
    if (key !== null && typeof key !== "string") throw new Error("Invalid voice API key.");
    const { getPluginHostCapabilitiesForUi } = await import("./plugin-host-capabilities.js");
    const capabilities = getPluginHostCapabilitiesForUi();
    if (!capabilities) throw new Error("Voice secret storage is unavailable.");
    await setVoiceSecret(capabilities.secretsStore, providerId as VoiceSecretProviderId, key as string | null);
    getVoicePlatform()?.providers.invalidate(providerId as VoiceProviderId);
    return getVoiceSecretStatus(capabilities.secretsStore);
  });

  ipcMain.handle("openpets:voice-provider-health", async (event, providerId: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    const provider = validateVoiceProviderId(providerId);
    const platform = requireVoicePlatform();
    return platform.providers.health(provider);
  });

  ipcMain.handle("openpets:voice-provider-voices", async (event, providerId: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    const provider = validateVoiceProviderId(providerId);
    return requireVoicePlatform().providers.listVoices(provider);
  });

  ipcMain.handle("openpets:voice-test-speech", async (event, request: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (!isPlainObject(request)) throw new Error("Invalid voice test request.");
    const text = typeof request.text === "string" ? request.text.trim() : "";
    if (!text || text.length > 300 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) throw new Error("Voice test text must contain 1–300 printable characters.");
    const providerId = request.providerId === undefined ? undefined : validateVoiceProviderId(request.providerId);
    const petId = typeof request.petId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(request.petId) ? request.petId : getAppStateSnapshot().preferences.defaultPetId;
    const voiceId = typeof request.voiceId === "string" ? request.voiceId.trim().slice(0, 200) || undefined : undefined;
    const model = typeof request.model === "string" ? request.model.trim().slice(0, 200) || undefined : undefined;
    const result = await requireVoicePlatform().output.speak({ text, reason: "settings-test", target: { kind: "installed-pet", petId }, requestedProviderId: providerId, requestedVoiceId: voiceId, requestedModel: model, overlapPolicy: "interrupt" });
    debug("ui", "voice speech test finished", { ok: result.ok, providerId: providerId ?? "configured", petId, attempts: result.attempts.length });
    return result;
  });

  ipcMain.handle("openpets:voice-stop-speech", (event, petId: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    const id = typeof petId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(petId) ? petId : getAppStateSnapshot().preferences.defaultPetId;
    requireVoicePlatform().output.cancel({ kind: "installed-pet", petId: id });
    return { ok: true };
  });

  ipcMain.handle("openpets:voice-conversation-health", async (event, force: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    return requireVoicePlatform().companion.health("codex", force === true);
  });

  ipcMain.handle("openpets:voice-wake-health", (event) => {
    assertAllowedSender(event, ["control-center"]);
    return requireVoicePlatform().wake.health();
  });

  ipcMain.handle("openpets:voice-wake-snapshot", (event) => {
    assertAllowedSender(event, ["control-center"]);
    return requireVoicePlatform().wake.snapshot();
  });

  ipcMain.handle("openpets:voice-wake-calibration-snapshot", (event) => {
    assertAllowedSender(event, ["control-center"]);
    return requireVoicePlatform().wakeCalibration.snapshot();
  });

  ipcMain.handle("openpets:voice-wake-calibration-start", async (event, phrase: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    return requireVoicePlatform().wakeCalibration.start(phrase);
  });

  ipcMain.handle("openpets:voice-wake-calibration-cancel", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    return requireVoicePlatform().wakeCalibration.cancel();
  });

  ipcMain.handle("openpets:voice-wake-calibration-save", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    return requireVoicePlatform().wakeCalibration.save();
  });

  ipcMain.handle("openpets:voice-wake-calibration-delete-interpretation", async (event, value: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    return requireVoicePlatform().wakeCalibration.deleteInterpretation(value);
  });

  ipcMain.handle("openpets:voice-wake-calibration-reset", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    return requireVoicePlatform().wakeCalibration.reset();
  });

  ipcMain.handle("openpets:get-catalog", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    trackDesktopEvent("desktop_pet_catalog_opened", { source: "catalog" });
    try {
      const state = await getCatalogUiState();
      if (state.source !== "remote" || state.fallbackReason) trackDesktopEvent("desktop_catalog_fetch_failed", { catalog_kind: "pet", source: state.source, fallback_reason: state.fallbackReason, error_code: classifyAnalyticsError(state.error, "catalog_fetch_failed") });
      return state;
    } catch (error) {
      trackDesktopEvent("desktop_catalog_fetch_failed", { catalog_kind: "pet", source: "catalog", error_code: classifyAnalyticsError(error, "catalog_fetch_failed") });
      throw error;
    }
  });

  ipcMain.handle("openpets:get-catalog-page", async (event, page: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof page !== "number" || !Number.isInteger(page) || page < 0) throw new Error("Invalid catalog page.");
    trackDesktopEvent("desktop_pet_catalog_opened", { source: "catalog_page", page });
    try {
      const state = await getCatalogPageUiState(page);
      if (state.source !== "remote" || state.fallbackReason) trackDesktopEvent("desktop_catalog_fetch_failed", { catalog_kind: "pet", source: state.source, fallback_reason: state.fallbackReason, page, error_code: classifyAnalyticsError(state.error, "catalog_page_fetch_failed") });
      return state;
    } catch (error) {
      trackDesktopEvent("desktop_catalog_fetch_failed", { catalog_kind: "pet", source: "catalog_page", page, error_code: classifyAnalyticsError(error, "catalog_page_fetch_failed") });
      throw error;
    }
  });

  ipcMain.handle("openpets:get-catalog-search", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    const state = await getCatalogSearchUiState();
    if (state.source === "error") trackDesktopEvent("desktop_catalog_fetch_failed", { catalog_kind: "pet", source: "search", error_code: classifyAnalyticsError(state.error, "catalog_search_fetch_failed") });
    return state;
  });

  ipcMain.handle("openpets:get-codex-pets", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    return getCodexPetsUiState();
  });

  ipcMain.handle("openpets:update-preferences", (event, patch: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    const previousScale = getAppStateSnapshot().preferences.petScale;
    const previousOverrides = JSON.stringify(getAppStateSnapshot().preferences.reactionAnimationOverrides ?? {});
    const previousLocale = getActiveLocale();
    const previousPoolEnabled = getAppStateSnapshot().preferences.petPoolEnabled;
    const state = updatePreferences(validatePreferencePatch(patch));
    const nextOverrides = JSON.stringify(state.preferences.reactionAnimationOverrides ?? {});
    if (state.preferences.petScale !== previousScale || nextOverrides !== previousOverrides) {
      refreshDefaultPetContent();
      refreshAgentPetContent();
    }
    if (setLocaleFromPreference(state.preferences.locale) !== previousLocale) {
      // Tray labels are rendered eagerly, so rebuild the menu in the new language.
      void import("./tray.js").then(({ refreshTrayMenu }) => refreshTrayMenu());
      // Control Center plugin labels are resolved at display time; nudge it to re-fetch the
      // SafePluginRecords so manifest/config labels re-render in the new language.
      broadcastPluginRecordsRefresh();
    }
    // Propagate petConfinementEnabled into the confinement-manager flag on every pref update.
    setConfinementEnabled(state.preferences.petConfinementEnabled);
    // Propagate petCrossDisplayEnabled into the display-module flag on every pref update.
    setCrossDisplayRoamingEnabled(state.preferences.petCrossDisplayEnabled);
    // Propagate petGravityEnabled to all live pets on every pref update.
    applyRoamingToAllPets();
    // Propagate petPoolEnabled — despawn on disable, respawn on enable.
    if (state.preferences.petPoolEnabled !== previousPoolEnabled) {
      void import("./local-ipc.js").then(({ dispatchPoolToggle }) => dispatchPoolToggle(state.preferences.petPoolEnabled));
    }
    return getInternalUiWindowKindForWebContents(event.sender.id) === "control-center" ? getSettingsStateSnapshot() : state;
  });

  ipcMain.handle("openpets:get-launch-at-login", (event) => {
    assertAllowedSender(event, ["control-center"]);
    return getLaunchAtLoginState();
  });

  ipcMain.handle("openpets:set-launch-at-login", (event, enabled: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof enabled !== "boolean") throw new Error("Invalid launch-at-login value.");
    if (!isLaunchAtLoginSupported()) return getLaunchAtLoginState();
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
    return getLaunchAtLoginState();
  });

  ipcMain.handle("openpets:get-update-status", (event) => {
    assertAllowedSender(event, ["control-center"]);
    return getUpdateStatus();
  });

  ipcMain.handle("openpets:check-for-updates", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    const status = await checkForGitHubReleaseUpdate();
    const { refreshTrayMenu } = await import("./tray.js");
    refreshTrayMenu();
    return status;
  });

  ipcMain.handle("openpets:open-update-release-page", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    await openUpdateReleasePage();
  });

  ipcMain.handle("openpets:set-default-pet", async (event, petId: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof petId !== "string") {
      throw new Error("Invalid pet id.");
    }

    const state = await setDefaultInstalledPet(petId);
    trackDesktopEvent("desktop_default_pet_changed", petTelemetryForId(petId));
    refreshDefaultPetContent();
    recoverDefaultPetMouseInterop("default-pet-changed");
    setTimeout(() => recoverDefaultPetMouseInterop("default-pet-changed+500ms"), 500).unref?.();
    return getInternalUiWindowKindForWebContents(event.sender.id) === "control-center" ? getPetsStateSnapshot() : state;
  });

  ipcMain.handle("openpets:set-pet-pool-order", (event, ids: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (!Array.isArray(ids)) throw new Error("Invalid pet pool order: expected an array.");
    const normalized = normalizePetPoolOrder(ids);
    setPetPoolOrder(normalized ?? []);
    return getSettingsStateSnapshot();
  });

  ipcMain.handle("openpets:install-pet", async (event, petId: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof petId !== "string") {
      throw new Error("Invalid pet id.");
    }

    trackDesktopEvent("desktop_pet_install_started", { source: "catalog" });
    let state;
    try {
      state = await installPet(petId);
      trackDesktopEvent("desktop_pet_install_completed", { source: "catalog" });
    } catch (error) {
      trackDesktopEvent("desktop_pet_install_failed", { source: "catalog", error_code: classifyAnalyticsError(error, "pet_install_failed") });
      throw error;
    }
    return getInternalUiWindowKindForWebContents(event.sender.id) === "control-center" ? getPetsStateSnapshot() : state;
  });

  ipcMain.handle("openpets:install-local-pet", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const importKind = await chooseLocalPetImportKind(owner);
    if (!importKind) return getPetsStateSnapshot();
    const options: OpenDialogOptions = importKind === "zip" ? {
      title: "Install pet from ZIP",
      buttonLabel: "Install Pet",
      properties: ["openFile"],
      filters: [{ name: "OpenPets ZIP", extensions: ["zip"] }],
    } : {
      title: "Install pet from folder",
      buttonLabel: "Install Pet",
      properties: ["openDirectory"],
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return getPetsStateSnapshot();
    const selectedPath = result.filePaths[0];
    let source: "local_folder" | "local_zip" = "local_zip";
    try {
      const selectedStats = await stat(selectedPath);
      source = selectedStats.isDirectory() ? "local_folder" : "local_zip";
      trackDesktopEvent("desktop_pet_local_import_started", { source });
      const state = selectedStats.isDirectory() ? await installPetFromFolder(selectedPath) : await installPetFromZipFile(selectedPath);
      trackDesktopEvent("desktop_pet_local_import_completed", { source });
      debug("ui", "local pet import succeeded", { kind: selectedStats.isDirectory() ? "folder" : "zip" });
      refreshDefaultPetContent();
      return getInternalUiWindowKindForWebContents(event.sender.id) === "control-center" ? getPetsStateSnapshot() : state;
    } catch (error) {
      trackDesktopEvent("desktop_pet_local_import_failed", { source, error_code: classifyAnalyticsError(error, "local_pet_import_failed") });
      logError("ui", "local pet import failed", { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });

  ipcMain.handle("openpets:open-gallery", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    await shell.openExternal("https://openpets.dev/gallery");
  });

  ipcMain.handle("openpets:import-codex-pet", async (event, petId: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof petId !== "string") {
      throw new Error("Invalid pet id.");
    }

    trackDesktopEvent("desktop_pet_local_import_started", { source: "codex" });
    let state;
    try {
      state = await importCodexPet(petId);
      trackDesktopEvent("desktop_pet_local_import_completed", { source: "codex" });
    } catch (error) {
      trackDesktopEvent("desktop_pet_local_import_failed", { source: "codex", error_code: classifyAnalyticsError(error, "codex_pet_import_failed") });
      throw error;
    }
    return getInternalUiWindowKindForWebContents(event.sender.id) === "control-center" ? getPetsStateSnapshot() : state;
  });

  ipcMain.handle("openpets:remove-pet", async (event, petId: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof petId !== "string") {
      throw new Error("Invalid pet id.");
    }

    const state = await removePet(petId);
    removeCompanionCharacterSettings(petId);
    removeCompanionMemoryForPet(petId);
    getVoicePlatform()?.companion.cancel(petId);
    refreshDefaultPetContent();
    return getInternalUiWindowKindForWebContents(event.sender.id) === "control-center" ? getPetsStateSnapshot() : state;
  });

  ipcMain.handle("openpets:reset-default-pet-position", (event) => {
    assertAllowedSender(event, ["control-center"]);
    resetDefaultPetToInitialPosition();
    return getInternalUiWindowKindForWebContents(event.sender.id) === "control-center" ? getSettingsStateSnapshot() : getAppStateSnapshot();
  });

  ipcMain.handle("openpets:agent-setup-snapshot", async (event, selectedPetId: unknown, commandMode: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    return getAgentSetupSnapshot(selectedPetId, commandMode);
  });

  ipcMain.handle("openpets:agent-setup-action", async (event, action: unknown, selectedPetId: unknown, commandMode: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (action !== "configure" && action !== "replace" && action !== "remove" && action !== "install-memory" && action !== "doctor-hooks" && action !== "install-hooks" && action !== "uninstall-hooks" && action !== "opencode-install" && action !== "opencode-remove" && action !== "cursor-install" && action !== "cursor-replace" && action !== "cursor-remove" && action !== "codex-install" && action !== "codex-repair" && action !== "codex-disconnect" && action !== "codex-refresh") {
      throw new Error("Invalid agent setup action.");
    }

    trackDesktopEvent("desktop_agent_setup_started", { action, integration_type: integrationTypeForSetupAction(action), command_mode: typeof commandMode === "string" ? commandMode : undefined });
    const snapshot = await runAgentSetupAction(action, selectedPetId, commandMode);
    const eventName = snapshot.lastAction?.ok ? "desktop_agent_setup_completed" : "desktop_agent_setup_failed";
    trackDesktopEvent(eventName, { action, integration_type: integrationTypeForSetupAction(action), changed: snapshot.lastAction?.changed ?? false, command_mode: snapshot.commandMode });
    return snapshot;
  });

  ipcMain.handle("openpets:agent-setup-command-paths", (event, patch: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    return updateAgentSetupCommandPaths(patch);
  });

  ipcMain.handle("openpets:codex-reaction-preferences-update", async (event, patch: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new Error("Invalid Codex reaction preferences.");
    const record = patch as Record<string, unknown>;
    const allowedKeys = ["taskStarted", "taskWorking", "taskCompleted"] as const;
    const nextPatch: Partial<OpenPetsStateV1["integrations"]["codex"]["reactionPreferences"]> = {};
    for (const key of allowedKeys) {
      if (record[key] !== undefined) {
        if (typeof record[key] !== "boolean") throw new Error("Invalid Codex reaction preference value.");
        (nextPatch as Record<string, boolean>)[key] = record[key];
      }
    }
    updateCodexReactionPreferences(nextPatch);
    return getAgentSetupSnapshot();
  });

  ipcMain.handle("openpets:codex-review-hooks", async (event) => {
    assertAllowedSender(event, ["control-center"]);
    return launchCodexHookReview();
  });

  ipcMain.handle("openpets:codex-review-complete", (event) => {
    assertAllowedSender(event, ["control-center"]);
    focusOpenTaskWindows();
    return { ok: true };
  });
}

async function chooseLocalPetImportKind(owner: BrowserWindow | undefined): Promise<"zip" | "folder" | null> {
  const options = {
    type: "question" as const,
    title: "Install pet",
    message: "Install pet from ZIP or folder?",
    detail: "Choose the source type before selecting the pet package.",
    buttons: ["ZIP", "Folder", "Cancel"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  };
  const result = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
  if (result.response === 0) return "zip";
  if (result.response === 1) return "folder";
  return null;
}

function integrationTypeForSetupAction(action: string): string {
  if (action.startsWith("codex-")) return "codex";
  if (action.startsWith("opencode-")) return "opencode";
  if (action.startsWith("cursor-")) return "cursor";
  if (action.includes("hook") || action === "install-memory") return "claude";
  return "claude";
}

function pluginTelemetryForSnapshot(snapshot: PluginServiceResult["snapshot"], pluginId: string): Record<string, string | number | boolean | undefined> {
  const plugin = snapshot.plugins.find((candidate) => candidate.id === pluginId);
  return {
    plugin_source: plugin?.bundled ? "bundled" : plugin?.source,
    plugin_bundled: plugin?.bundled === true,
    plugin_runtime: plugin?.runtime,
    permission_count: plugin?.approvedPermissions.length,
  };
}

function isCatalogPluginInstalled(snapshot: PluginServiceResult["snapshot"], pluginId: string): boolean {
  const plugin = snapshot.plugins.find((candidate) => candidate.id === pluginId);
  return plugin?.source === "catalog" || plugin?.bundled === true;
}

function petTelemetryForId(petId: string): Record<string, string | boolean | undefined> {
  const pet = getAppStateSnapshot().pets.installed.find((candidate) => candidate.id === petId);
  return {
    pet_source: pet?.builtIn ? "built_in" : pet?.source?.kind === "catalog" ? "catalog" : pet?.source?.kind === "codex" ? "codex" : "local",
    pet_built_in: pet?.builtIn === true,
    pet_public_catalog: pet?.source?.kind === "catalog",
  };
}

export function installInternalUiProtocol(): void {
  registerPluginAssetProtocol(protocol, getPluginService);
  protocol.handle("openpets-codex", async (request) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
      const url = new URL(request.url);
      if (url.hostname !== "spritesheet" || url.search || url.hash) return new Response(null, { status: 404 });
      const petId = decodeURIComponent(url.pathname.replace(/^\//, ""));
      const spritesheet = await readCodexPetSpritesheet(petId);
      return new Response(spritesheet, {
        headers: {
          "Content-Type": "image/webp",
          "Cache-Control": "private, max-age=60",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });

  protocol.handle("openpets-installed", async (request) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
      const url = new URL(request.url);
      if (url.hostname !== "spritesheet" || url.search || url.hash) return new Response(null, { status: 404 });
      const petId = decodeURIComponent(url.pathname.replace(/^\//, ""));
      assertSafePetId(petId);
      const pet = getAppStateSnapshot().pets.installed.find((candidate) => candidate.id === petId && !candidate.broken);
      if (!pet) return new Response(null, { status: 404 });
      const spritesheetPath = join(getInstalledPetDir(petId), "spritesheet.webp");
      const spritesheet = await stat(spritesheetPath);
      if (!spritesheet.isFile() || spritesheet.size <= 0 || spritesheet.size > 100 * 1024 * 1024) return new Response(null, { status: 404 });
      return new Response(await readFile(spritesheetPath), {
        headers: {
          "Content-Type": "image/webp",
          "Cache-Control": "private, max-age=60",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });

  protocol.handle("openpets-pet-preview", async (request) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
      const url = new URL(request.url);
      if (url.hostname !== "spritesheet" || url.pathname !== "/default" || url.hash) return new Response(null, { status: 404 });
      const version = url.searchParams.get("v");
      if ([...url.searchParams.keys()].some((key) => key !== "v") || (version !== null && !/^[a-z0-9_-]+-\d+-\d+$/.test(version))) return new Response(null, { status: 404 });
      const { path } = await getDefaultPetPreviewSpriteInfo();
      const spritesheet = await stat(path);
      if (!spritesheet.isFile() || spritesheet.size <= 0 || spritesheet.size > 100 * 1024 * 1024) return new Response(null, { status: 404 });
      return new Response(await readFile(path), {
        headers: {
          "Content-Type": "image/webp",
          "Cache-Control": "no-store",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}

export function openControlCenterWindow(route: ControlCenterRoute | ControlCenterRouteRequest = "dashboard"): void {
  const safeRoute = normalizeControlCenterRoute(route);
  if (controlCenterWindow && !controlCenterWindow.isDestroyed()) {
    trackDesktopEvent("desktop_control_center_opened", { route: safeRoute.route, section: safeRoute.section, entrypoint: "focus_existing" });
    syncDockVisibilityForInternalUi();
    if (controlCenterWindow.isMinimized()) controlCenterWindow.restore();
    controlCenterWindow.show();
    controlCenterWindow.focus();
    routeControlCenterWindow(controlCenterWindow, safeRoute);
    return;
  }

  trackDesktopEvent("desktop_control_center_opened", { route: safeRoute.route, section: safeRoute.section, entrypoint: "create_window" });

  const window = new BrowserWindow({
    title: "OpenPets — Control Center",
    width: 1180,
    height: 820,
    minWidth: 820,
    minHeight: 620,
    show: false,
    icon: createAppIcon(),
    backgroundColor: "#f8fbff",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: getControlCenterPreloadPath(),
    },
  });

  controlCenterWindow = window;
  syncDockVisibilityForInternalUi();
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-redirect", (event) => event.preventDefault());
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    trackDesktopEvent("desktop_renderer_error", { surface_kind: "control_center", error_code: classifyRendererLoadError(errorCode) });
    console.error("Failed to load Control Center renderer.", { errorCode, errorDescription });
    logError("ui", "control center load failed", { errorCode, errorDescription });
  });
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    const fields = { level, line, sourceId, message };
    if (level >= 3) logError("ui", "control center console", fields);
    else if (level === 2) warn("ui", "control center console", fields);
    else debug("ui", "control center console", fields);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    trackDesktopEvent("desktop_renderer_error", { surface_kind: "control_center", error_code: classifyRendererGoneReason(details.reason) });
    console.error("Control Center renderer process gone.", details);
    logError("ui", "control center renderer gone", details);
  });
  window.on("closed", () => { controlCenterWindow = null; syncDockVisibilityForInternalUi(); });
  window.once("ready-to-show", () => { window.show(); window.focus(); });
  pendingControlCenterRoute = safeRoute;
  window.webContents.on("did-finish-load", () => flushPendingControlCenterRoute(window));

  const devUrl = getSafeControlCenterDevUrl();
  const load = devUrl ? window.loadURL(withControlCenterRoute(devUrl, safeRoute)) : window.loadFile(join(app.getAppPath(), "dist", "renderer", "index.html"), { query: controlCenterRouteQuery(safeRoute) });
  load.catch((error: unknown) => {
    trackDesktopEvent("desktop_renderer_error", { surface_kind: "control_center", error_code: classifyAnalyticsError(error, "renderer_load_failed") });
    console.error("Failed to load Control Center.", error);
  });
}

function classifyRendererLoadError(errorCode: number): string {
  if (errorCode === -3) return "load_aborted";
  if (errorCode === -6 || errorCode === -105 || errorCode === -106) return "network_error";
  if (errorCode === -102 || errorCode === -109) return "connection_error";
  if (errorCode === -300 || errorCode === -301 || errorCode === -302) return "file_load_error";
  return "renderer_load_failed";
}

function classifyRendererGoneReason(reason: string): string {
  if (reason === "crashed" || reason === "oom" || reason === "killed" || reason === "integrity-failure") return `renderer_${reason.replace(/-/g, "_")}`;
  return "renderer_gone";
}

export function focusOpenTaskWindows(): void {
  syncDockVisibilityForInternalUi();
  if (controlCenterWindow && !controlCenterWindow.isDestroyed()) {
    if (controlCenterWindow.isMinimized()) controlCenterWindow.restore();
    controlCenterWindow.show();
    controlCenterWindow.focus();
  }
}

export function normalizeControlCenterRoute(route: unknown): ControlCenterRouteRequest {
  const requested = typeof route === "string" ? { route } : isPlainObject(route) ? route : {};
  const safeRoute = typeof requested.route === "string" && controlCenterRoutes.has(requested.route as ControlCenterRoute)
    ? requested.route as ControlCenterRoute
    : "dashboard";
  if (safeRoute !== "pets") return { route: safeRoute };

  const wantsCompanion = requested.section === "companion";
  const hasRequestedPet = typeof requested.petId === "string";
  const petId = hasRequestedPet && /^[A-Za-z0-9._:-]{1,200}$/.test(requested.petId as string) ? requested.petId as string : undefined;
  if (hasRequestedPet && !petId) return { route: "pets", ...(wantsCompanion ? { section: "companion" as const } : {}), notice: "pet-unavailable" };
  if (!petId) return { route: "pets", ...(wantsCompanion ? { section: "companion" as const } : {}) };
  const available = getAppStateSnapshot().pets.installed.some((pet) => pet.id === petId && !pet.broken && !pet.brokenReason);
  if (!available) return { route: "pets", ...(wantsCompanion ? { section: "companion" as const } : {}), notice: "pet-unavailable" };
  return { route: "pets", petId, ...(wantsCompanion ? { section: "companion" as const } : {}) };
}

function sendControlCenterRoute(window: BrowserWindow, route: ControlCenterRouteRequest): void {
  if (window.isDestroyed()) return;
  window.webContents.send("openpets:control-center-route", route);
}

/** Tell the open Control Center to re-fetch the plugin snapshot (e.g. after a locale change). */
function broadcastPluginRecordsRefresh(): void {
  if (controlCenterWindow && !controlCenterWindow.isDestroyed()) {
    controlCenterWindow.webContents.send("openpets:plugins-refresh");
  }
}

function routeControlCenterWindow(window: BrowserWindow, route: ControlCenterRouteRequest): void {
  pendingControlCenterRoute = route;
  if (window.webContents.isLoading()) return;
  flushPendingControlCenterRoute(window);
}

function flushPendingControlCenterRoute(window: BrowserWindow): void {
  if (window.isDestroyed() || !pendingControlCenterRoute) return;
  const route = pendingControlCenterRoute;
  pendingControlCenterRoute = null;
  sendControlCenterRoute(window, route);
}

function withControlCenterRoute(rawUrl: string, route: ControlCenterRouteRequest): string {
  const url = new URL(rawUrl);
  for (const [key, value] of Object.entries(controlCenterRouteQuery(route))) url.searchParams.set(key, value);
  return url.toString();
}

function controlCenterRouteQuery(route: ControlCenterRouteRequest): Record<string, string> {
  return {
    route: route.route,
    ...(route.petId ? { petId: route.petId } : {}),
    ...(route.section ? { section: route.section } : {}),
    ...(route.notice ? { notice: route.notice } : {}),
  };
}

function pluginUiError(error: string): PluginServiceResult {
  return { ok: false, error, snapshot: { plugins: [] } };
}

function pluginUiSoundError(error: string): PluginConfigSoundPickResult {
  return { ok: false, error, snapshot: { plugins: [] } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function getControlCenterPreloadPath(): string {
  return join(app.getAppPath(), "control-center-preload.cjs");
}

function getSafeControlCenterDevUrl(): string | null {
  if (app.isPackaged) return null;
  const raw = process.env.OPENPETS_RENDERER_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if ((url.protocol === "http:" || url.protocol === "https:") && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
      return url.toString();
    }
  } catch {
    return null;
  }
  return null;
}

function assertAllowedSender(event: IpcMainInvokeEvent, allowedKinds: readonly InternalUiWindowKind[]): void {
  const actualKind = getInternalUiWindowKindForWebContents(event.sender.id);

  if (!actualKind || !allowedKinds.includes(actualKind)) {
    throw new Error("OpenPets internal UI request came from an unexpected window.");
  }
}

function getInternalUiWindowKindForWebContents(webContentsId: number): InternalUiWindowKind | null {
  if (controlCenterWindow && !controlCenterWindow.isDestroyed() && controlCenterWindow.webContents.id === webContentsId) {
    return "control-center";
  }
  return null;
}

async function getReactionAnimationSettingsSnapshot(): Promise<unknown> {
  const state = getAppStateSnapshot();
  const preview = await getDefaultPetPreviewSpriteInfo();
  return {
    reactions: reactionAnimationMetadata.map((reaction) => ({
      ...reaction,
      label: t(`settings.reaction.${reaction.id}.label`),
      description: t(`settings.reaction.${reaction.id}.description`),
    })),
    animations: selectableAnimationMetadata.map((animation) => ({
      ...animation,
      label: t(`settings.animation.${animation.id}.label`),
      description: t(`settings.animation.${animation.id}.description`),
    })),
    sprite: defaultPetSprite,
    overrides: state.preferences.reactionAnimationOverrides ?? {},
    previewSpriteUrl: `openpets-pet-preview://spritesheet/default?v=${encodeURIComponent(preview.version)}`,
  };
}

async function getDefaultPetPreviewSpriteInfo(): Promise<{ readonly path: string; readonly version: string }> {
  const state = getAppStateSnapshot();
  const selected = state.pets.installed.find((pet) => pet.id === state.preferences.defaultPetId);
  const builtInPath = join(app.getAppPath(), "assets", defaultPetSprite.fileName);
  const candidatePath = selected && !selected.broken && !selected.builtIn
    ? join(getInstalledPetDir(selected.id), "spritesheet.webp")
    : builtInPath;
  try {
    const spritesheet = await stat(candidatePath);
    if (spritesheet.isFile() && spritesheet.size > 0 && spritesheet.size <= 100 * 1024 * 1024) {
      return { path: candidatePath, version: `${selected?.id ?? "builtin"}-${Math.round(spritesheet.mtimeMs)}-${spritesheet.size}` };
    }
  } catch {
    // Fall back to the bundled pet if an installed default disappears while Settings is open.
  }
  const fallback = await stat(builtInPath);
  return { path: builtInPath, version: `builtin-${Math.round(fallback.mtimeMs)}-${fallback.size}` };
}

function getLaunchAtLoginState(): { supported: boolean; enabled: boolean } {
  if (!isLaunchAtLoginSupported()) return { supported: false, enabled: false };
  return { supported: true, enabled: app.getLoginItemSettings().openAtLogin };
}

function isLaunchAtLoginSupported(): boolean {
  return process.platform === "darwin" || process.platform === "win32";
}
