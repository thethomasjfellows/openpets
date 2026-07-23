import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider, useI18n, type I18nSnapshot } from "./i18n";
import "./styles.css";
import openPetsLogoUrl from "../../../assets/openpets.webp";
import defaultThumbUrl from "../../../assets/default-pet-thumbnail.png";
import { getPetVisionStatus } from "../vision-status.js";

import claudeLogoUrl from "../../../assets/integrations/claude.svg";
import codexLogoUrl from "../../../assets/integrations/codex.png";
import opencodeLogoUrl from "../../../assets/integrations/opencode.svg";
import cursorLogoUrl from "../../../assets/integrations/cursor.svg";
import piLogoUrl from "../../../assets/integrations/pi.svg";
import vscodeLogoUrl from "../../../assets/integrations/vscode.svg";
import windsurfLogoUrl from "../../../assets/integrations/windsurf.svg";
import zedLogoUrl from "../../../assets/integrations/zed.svg";

type Filter = "all" | "installed" | "featured" | "originals" | "codex";
type InstalledPet = { id: string; displayName: string; description?: string; builtIn: boolean; protected: boolean; installed: boolean; broken?: boolean; brokenReason?: string; source?: { kind?: "catalog"; preview?: string } | { kind: "codex"; path: string } };
type PetEntry = { id: string; displayName: string; description?: string; searchText?: string; preview?: string; thumbnail?: string; spritesheet?: string; category?: "western" | "asian"; original?: boolean; featured?: boolean; catalogPage?: number; sourceKind?: "installed" | "catalog" | "codex"; installed?: boolean; builtIn?: boolean; protected?: boolean; broken?: boolean; brokenReason?: string };
type SearchPetEntry = Pick<PetEntry, "id" | "displayName" | "category" | "original" | "featured"> & { searchText?: string; catalogPage?: number };
type StateSnapshot = { preferences: { defaultPetId: string }; pets: { installed: InstalledPet[] } };
type CatalogState = { pets: PetEntry[]; source: string; error?: string; page?: number; pageCount?: number; total?: number; categories?: { id: "western" | "asian"; label: string; count: number }[]; originalsCount?: number; featuredCount?: number };
type CodexState = { pets: PetEntry[]; error?: string };
type PetScaleOption = { label: string; value: number };
type UserSelectableAnimationState = "idle" | "review" | "running" | "waiting" | "waving" | "jumping" | "failed";
type ReactionAnimationOverrides = Record<string, UserSelectableAnimationState>;
type AnalyticsConsent = "unset" | "granted" | "denied";
type PetPoolCandidate = { id: string; displayName: string };
type SettingsState = { preferences: { openDefaultPetOnLaunch: boolean; readSpeechBubblesAloud: boolean; locale?: "system" | string; petScale: number; reactionAnimationOverrides?: ReactionAnimationOverrides; petPoolEnabled: boolean; petPoolOrder?: readonly string[]; petConfinementEnabled: boolean; petCrossDisplayEnabled: boolean; petGravityEnabled: boolean }; petScaleOptions: PetScaleOption[]; analytics: { consent: AnalyticsConsent; enabled: boolean }; petPoolCandidates: ReadonlyArray<PetPoolCandidate> };
type LaunchAtLoginState = { supported: boolean; enabled: boolean };
type LanTopologyIssue = { code: "self_reference" | "missing_reverse"; host: string; edge: "left" | "right" | "up" | "down"; neighbor: string };
type LanStatusSnapshot = { mode: "off" | "server" | "client"; localHost: string; serverUrl: string; port: number; auth: "token" | "none"; authSource: "env" | "stored" | "generated" | "none"; authInsecure: boolean; tokenHint: string | null; topologyHosts: number; topologyLinks: number; topologyIssues: LanTopologyIssue[]; currentHost: string | null; clients: Array<{ host: string; lastSeen: number; position?: { x: number; y: number } }>; updatedAt: number; persistedCurrentHost: string | null; persistedUpdatedAt: number | null };
type UpdateStatus = { state: "idle" | "checking" | "available" | "current" | "error"; currentVersion: string; latestVersion?: string; releaseUrl?: string; checkedAt?: number; error?: string };
type DashboardActivity = { messagesSent: number; reactionsSent: number; reactionCounts: Record<string, number>; perPetActivityCounts: Record<string, number>; lastActivityAt?: number };
type DashboardSnapshot = { defaultPet: { id: string; displayName: string; previewSpriteUrl: string }; installedPetCount: number; catalog: { source: string; total?: number; page?: number; pageCount?: number; error?: string }; plugins: { installed: number; enabled: number; broken: number }; updateStatus: UpdateStatus; activity: DashboardActivity };
type ReactionAnimationSettings = { reactions: { id: string; label: string; description: string; defaultAnimation: UserSelectableAnimationState }[]; animations: { id: UserSelectableAnimationState; label: string; description: string }[]; sprite: { frameWidth: number; frameHeight: number; columns: number; rows: number; states: Record<UserSelectableAnimationState, { row: number; frames: number; durationMs: number; iterations?: number | "infinite" }> }; overrides: ReactionAnimationOverrides; previewSpriteUrl: string };
type PluginFilter = "all" | "installed" | "catalog" | "local" | "broken";
type PluginPermission =
  | "pet:speak" | "pet:reaction" | "pet:move" | "timer" | "schedule" | "storage" | "status" | "commands" | "network"
  | "pet:interact" | "pet:pin" | "pet:animate" | "pet:speak:dynamic" | "pet:drop" | "pets:read" | "pets:manage"
  | "audio" | "events" | "ui:toast" | "ui:panel" | "ui:delivery" | "notify" | "bus" | "ai" | "secrets" | "voice:speak" | "voice:listen" | "companion:context"
  | "auth" | "files" | "system:openExternal" | "system:metrics" | "clipboard" | "network:write";
type HostAiProfileId = "anthropic" | "openai" | "openrouter" | "ollama" | "custom";
type HostAiProviderConfig = { model: string; baseUrl: string; requiresApiKey: boolean };
type HostAiSettingsSnapshot = { version: 2; provider: "none" | HostAiProfileId; providers: Record<HostAiProfileId, HostAiProviderConfig> };
type HostAiSecretStatus = Record<HostAiProfileId, { hasKey: boolean }>;
type HostAiModelCatalog = { provider: HostAiProfileId; models: Array<{ id: string; name: string }> };
type PluginPlatformSettings = {
  allowPluginAudio: boolean;
  allowDynamicSpeech: boolean;
  allowPluginVoice: boolean;
  allowMicrophone: boolean;
  quietHours: { enabled: boolean; start: string; end: string };
  ai: HostAiSettingsSnapshot;
};
type VoiceProviderId = "system" | "pockettts" | "openai-compatible" | "elevenlabs";
type VoiceOverlapPolicy = "interrupt" | "queue" | "ignore";
type VoiceSettingsSnapshot = {
  version: 4;
  output: { providerId: VoiceProviderId; voiceId?: string; model?: string; overlapPolicy: VoiceOverlapPolicy; providerFallback: "system" | "fail"; voiceFallback: "provider-default" | "fail" };
  providers: {
    system: { voiceId?: string; rate: number };
    pockettts: { baseUrl: string; voiceId: string };
    "openai-compatible": { baseUrl: string; voiceId: string; model: string };
    elevenlabs: { baseUrl: string; voiceId: string; model: string; outputFormat: string };
  };
  wake: { engine: "official-livekit" | "custom-sherpa"; phraseId: "openpets.hey-pedra.v1"; phrase: string; sensitivity: "strict" | "balanced" | "easy"; microphone?: { deviceId: string; label?: string }; calibration?: { phrase: string; variants: readonly string[]; updatedAt: number } };
  installedPets: Array<{ id: string; displayName: string; available: boolean }>;
};
type HostAiHealthSnapshot = { status: "unconfigured" | "configured-unverified" | "probing" | "ready" | "error"; configured: boolean; ready: boolean; provider: HostAiSettingsSnapshot["provider"]; model: string; baseUrl?: string; checkedAt?: number; stale: boolean; evidence?: string; error?: string };
type AiImageHealthSnapshot = { status: "unconfigured" | "configured-unverified" | "probing" | "ready" | "unsupported" | "error"; configured: boolean; ready: boolean; provider: "none" | HostAiProfileId | "codex"; model: string; checkedAt?: number; stale: boolean; error?: string };
type VisionModelPreference = { owner: "codex"; model: string } | { owner: "host-ai"; provider: HostAiProfileId; model: string };
type PocketTtsSnapshot = { enabled: boolean; status: "not-installed" | "uv-missing" | "installing" | "starting" | "warming" | "ready" | "stopped" | "error"; packageVersion: string; baseUrl: string; host: string; port: number; uvCommand?: string; pid?: number; progress?: string; error?: string; voices: VoiceInfo[] };
type VoiceSecretStatus = { "openai-compatible": { hasKey: boolean }; elevenlabs: { hasKey: boolean } };
type VoiceCapabilityEvidence = { providerId: VoiceProviderId; checkedAt: number; expiresAt: number; configured: boolean; reachable: boolean; authenticated?: boolean; discoverySupported: boolean; discoveryOk?: boolean; synthesisTested: boolean; ready: boolean; method: string; version?: string; reason?: string };
type VoiceInfo = { id: string; label: string; language?: string };
type VoiceSpeakResult = { ok: boolean; attempts: Array<{ providerId: VoiceProviderId; voiceId?: string; started: boolean; fallbackReason?: string; errorType?: string; message?: string }> };
type VoiceConversationHealth = { targetId: "codex"; checkedAt: number; ready: boolean; method: string; version?: string; reason?: string };
type VoiceTranscriptionSettings = { version: 2; providerId: "local" | "openai" | "none"; baseUrl: string; model: string };
type VoiceTranscriptionHealth = { checkedAt: number; configured: boolean; ready: boolean; providerId: VoiceTranscriptionSettings["providerId"]; model: string; baseUrl: string; reason?: string };
type LocalTranscriptionSnapshot = { status: "not-installed" | "downloading" | "ready" | "error"; modelId: string; modelLabel: string; downloadBytes: number; downloadedBytes: number; storageLocation: string; offlineAfterInstall: true; progress?: string; error?: string };
type VoiceWakeHealth = { checkedAt: number; ready: boolean; enabled: boolean; method: string; reason?: string };
type VoiceWakeSnapshot = { checkedAt: number; enabled: boolean; armed: boolean; captureState: string; turnState: string; phraseConfigured: boolean; activePetId?: string; reason?: string; diagnostics?: { captureStartedAt?: number; helperStartedAt?: number; lastPcmFrameAt?: number; pcmFramesReceived: number; lastPcmRms?: number; lastHelperEventAt?: number; lastKeywordAt?: number; lastVadAt?: number; lastVadState?: "speech-start" | "speech-end"; lastFinalizedUtteranceMs?: number; lastTranscriptionAt?: number; lastCompanionTurnAt?: number; lastError?: string; lastFailureStage?: "transcription" | "companion" } };
type VoiceWakeCalibrationSnapshot = { state: "idle" | "preparing" | "listening" | "transcribing" | "review" | "saving" | "complete" | "error"; phrase: string; completedSamples: number; requiredSamples: 10; attempts: number; maximumAttempts: 40; detectedSamples: number; calibrated: boolean; batchInterpretations?: readonly string[]; savedInterpretations?: readonly string[]; activeRuntimeInterpretations?: readonly string[]; lastPcmRms?: number; lastPcmFrameAt?: number; skippedInterpretations?: number; reason?: string };
type VoiceMicrophoneDevice = { deviceId: string; label: string; stableLabel?: string };
type VisionSnapshot = {
  version: 1;
  enabled: boolean;
  pausedUntil?: number;
  state: "off" | "paused" | "checking" | "ready" | "capturing" | "summarizing" | "blocked" | "error";
  storage: { dir: string; entries: number; screenshotsBytes: number; oldestAt?: number; newestAt?: number; lastPurgeAt?: number; deleteError: boolean; persisted: boolean };
  capture: { ready: boolean; status: "unknown" | "ready" | "permission-denied" | "unavailable" | "error"; checkedAt?: number; reason?: string };
  summary: { ready: boolean; status: "unconfigured" | "configured-unverified" | "probing" | "ready" | "unsupported" | "error"; provider: "none" | HostAiProfileId | "codex"; model: string; checkedAt?: number; reason?: string };
  modelPreference?: VisionModelPreference;
  lastCaptureAt?: number;
  lastSummaryAt?: number;
  nextCaptureAt?: number;
};
type CompanionFrequency = "rarely" | "sometimes" | "often";
type CompanionTargetId = "codex" | "host-ai";
type CompanionCharacterProfile = { visibleName: string; species: string; origin: string; appearance: string; personality: string; quirks: string; lifeStory: string };
type CompanionSettings = {
  version: 2;
  consentVersion: 0 | 1;
  enabled: boolean;
  target: CompanionTargetId;
  codex: { model: string; reasoningEffort: string };
  profile: { name: string; preferredAddress: string; aboutYou: string };
  characters: Readonly<Record<string, CompanionCharacterProfile>>;
  memory: { enabled: boolean };
  proactivity: { enabled: boolean; frequency: CompanionFrequency };
  wake: { enabled: boolean; followUpEnabled: boolean };
};
type CompanionMemoryStatus = { entryCount: number; oldestCreatedAt: number | null };
type CompanionTargetHealth = { targetId: CompanionTargetId; checkedAt: number; configured: boolean; ready: boolean; method: string; provider?: string; model?: string; version?: string; reason?: string };
type CodexModelInfo = { id: string; model: string; displayName: string; description: string; hidden: boolean; isDefault: boolean; inputModalities: string[]; defaultReasoningEffort: string; supportedReasoningEfforts: Array<{ value: string; description: string }> };
type CodexModelDiscoverySnapshot = { checkedAt: number; status: "ready" | "not_detected" | "unsupported" | "error"; models: CodexModelInfo[]; defaultModelId?: string; reason?: string };
type DesktopPermissionKind = "microphone" | "screen-recording";
type DesktopPermissionStatus = "granted" | "denied" | "restricted" | "not-determined" | "unknown" | "unsupported";
type DesktopPermissionSnapshot = { platform: string; appLocation: "applications" | "development" | "other"; permissions: Record<DesktopPermissionKind, { status: DesktopPermissionStatus; canRequest: boolean; canOpenSettings: boolean; requiresRestartAfterGrant: boolean }> };
type PluginInspectorState = { schedules: Array<{ id: string; type: string; nextRunMs: number }>; commands: PluginCommand[]; menuItems: Array<{ id: string; title: string }>; status?: PluginStatus; activeBubbles: number; activePanels: number; eventSubscriptions: number; lastError?: string; quotaCounters: Record<string, number> };
type PluginIconName = "plugin" | "bell" | "timer" | "github" | "heart" | "sparkles" | "coffee" | "focus" | "droplet";
type PluginConfigField = { type: "text" | "textarea" | "number" | "boolean" | "select" | "time" | "date" | "multiSelect" | "list" | "secret" | "sound"; label?: string; description?: string; default?: string | number | boolean | string[] | Array<Record<string, unknown>>; options?: Array<{ label: string; value: string; previewSprite?: string }>; presentation?: "sprite-grid" | string; min?: number; max?: number; step?: number; maxLength?: number; maxItems?: number; itemSchema?: Record<string, PluginConfigField> };
type PluginConfigSchema = Record<string, PluginConfigField>;
type PluginConfig = Record<string, unknown>;
type PluginCommandFormField = { id: string; type: "text" | "textarea" | "number" | "boolean" | "select" | "multiSelect" | "time" | "date" | "list"; label: string; default?: string | number | boolean | string[]; options?: Array<{ label: string; value: string }>; min?: number; max?: number; maxLength?: number; required?: boolean };
type PluginCommandForm = { fields: PluginCommandFormField[]; submitLabel?: string };
type PluginCommand = { id: string; title: string; description?: string; form?: PluginCommandForm };
type PluginStatus = { text: string; tone?: "info" | "success" | "warning" | "error" };
type PluginConfigError = { path?: string; code?: string; message?: string };
type PluginCategory = "Companion" | "Wellness" | "Focus" | "Developer" | "Advanced";
type SafePluginRecord = { id: string; name?: string; description?: string; version: string; icon?: PluginIconName; iconDataUrl?: string; source: "catalog" | "local"; sourcePath?: string; bundled?: boolean; category?: PluginCategory; enabled: boolean; brokenReason?: string; approvedPermissions: PluginPermission[]; runtime?: "declarative" | "javascript"; sdkVersion?: string; catalogDisabled?: boolean; catalogDeprecated?: boolean; catalogStatusReason?: string; configSchema?: PluginConfigSchema; effectiveConfig?: PluginConfig; configErrors?: PluginConfigError[]; spritePreviews?: Record<string, { url: string; frameWidth: number; frameHeight: number; frames: number; durationMs: number }>; commands?: PluginCommand[]; status?: PluginStatus };
type SafeCatalogPluginRecord = { id: string; name: string; version: string; description: string; runtime: "declarative" | "javascript"; icon?: PluginIconName; iconDataUrl?: string; sdkVersion?: string; permissions: PluginPermission[]; installed: boolean; bundled?: boolean; category?: PluginCategory; deprecated?: boolean; statusReason?: string; publisherType?: "official" | "community" };
type PluginServiceSnapshot = { plugins: SafePluginRecord[] };
type PluginCatalogSnapshot = { plugins: SafeCatalogPluginRecord[] };
type PluginServiceResult = { ok: true; snapshot: PluginServiceSnapshot } | { ok: false; error: string; snapshot: PluginServiceSnapshot };
type PluginConfigSoundPickResult = { ok: true; sound: { kind: "user-sound"; id: string; name?: string }; snapshot: PluginServiceSnapshot } | { ok: false; error: string; snapshot: PluginServiceSnapshot };
type PluginEntry = { id: string; installed?: SafePluginRecord; catalog?: SafeCatalogPluginRecord };
type ControlCenterApi = {
  getPetsState(): Promise<StateSnapshot>;
  getDashboardSnapshot(): Promise<DashboardSnapshot>;
  getSettingsState(): Promise<SettingsState>;
  getLanStatus(): Promise<LanStatusSnapshot>;
  setDesktopAnalyticsConsent(consent: AnalyticsConsent): Promise<SettingsState>;
  getI18n(): Promise<I18nSnapshot>;
  updatePreferences(patch: Partial<SettingsState["preferences"]>): Promise<SettingsState>;
  getReactionAnimationSettings(): Promise<ReactionAnimationSettings>;
  getLaunchAtLogin(): Promise<LaunchAtLoginState>;
  setLaunchAtLogin(enabled: boolean): Promise<LaunchAtLoginState>;
  getUpdateStatus(): Promise<UpdateStatus>;
  checkForUpdates(): Promise<UpdateStatus>;
  openUpdateReleasePage(): Promise<void>;
  resetDefaultPetPosition(): Promise<SettingsState>;
  setPetPoolOrder(ids: string[]): Promise<SettingsState>;
  getPluginsSnapshot(): Promise<PluginServiceSnapshot>;
  getPluginCatalogSnapshot(refresh?: boolean): Promise<PluginCatalogSnapshot>;
  setPluginEnabled(id: string, enabled: boolean): Promise<PluginServiceResult>;
  savePluginConfig(id: string, config: PluginConfig): Promise<PluginServiceResult>;
  pickPluginConfigSound(id: string): Promise<PluginConfigSoundPickResult>;
  reloadPlugin(id: string): Promise<PluginServiceResult>;
  refreshLocalPlugin(id: string): Promise<PluginServiceResult>;
  executePluginCommand(id: string, commandId: string, args?: Record<string, unknown>): Promise<PluginServiceResult>;
  loadLocalPlugin(): Promise<PluginServiceResult>;
  installCatalogPlugin(id: string): Promise<PluginServiceResult>;
  updateCatalogPlugin(id: string): Promise<PluginServiceResult>;
  uninstallPlugin(id: string): Promise<PluginServiceResult>;
  getPluginInspector(id: string): Promise<PluginInspectorState>;
  getPluginPlatformSettings(): Promise<PluginPlatformSettings>;
  updatePluginPlatformSettings(patch: Partial<PluginPlatformSettings>): Promise<PluginPlatformSettings>;
  getHostAiSettings(): Promise<HostAiSettingsSnapshot>;
  updateHostAiProvider(provider: HostAiProfileId, patch: Partial<HostAiProviderConfig>): Promise<HostAiSettingsSnapshot>;
  selectHostAiProvider(provider: HostAiProfileId): Promise<HostAiSettingsSnapshot>;
  getHostAiApiKeyStatus(): Promise<HostAiSecretStatus>;
  setHostAiApiKey(provider: HostAiProfileId, key: string | null): Promise<{ provider: HostAiProfileId; hasKey: boolean }>;
  getHostAiHealth(provider: HostAiProfileId, force?: boolean): Promise<HostAiHealthSnapshot>;
  getHostAiModels(provider: HostAiProfileId): Promise<HostAiModelCatalog>;
  getVoiceSettings(): Promise<VoiceSettingsSnapshot>;
  getVoiceTranscriptionSettings(): Promise<VoiceTranscriptionSettings>;
  updateVoiceTranscriptionSettings(patch: Partial<VoiceTranscriptionSettings>): Promise<VoiceTranscriptionSettings>;
  getVoiceTranscriptionHealth(): Promise<VoiceTranscriptionHealth>;
  getLocalTranscriptionSnapshot(): Promise<LocalTranscriptionSnapshot>;
  installLocalTranscription(): Promise<LocalTranscriptionSnapshot>;
  getPocketTtsSnapshot(): Promise<PocketTtsSnapshot>;
  installAndEnablePocketTts(): Promise<PocketTtsSnapshot>;
  startPocketTts(): Promise<PocketTtsSnapshot>;
  stopPocketTts(): Promise<PocketTtsSnapshot>;
  getPocketTtsVoices(): Promise<VoiceInfo[]>;
  updateVoiceSettings(patch: Record<string, unknown>): Promise<VoiceSettingsSnapshot>;
  getVoiceSecretStatus(): Promise<VoiceSecretStatus>;
  setVoiceSecret(providerId: "openai-compatible" | "elevenlabs", key: string | null): Promise<VoiceSecretStatus>;
  checkVoiceProviderHealth(providerId: VoiceProviderId): Promise<VoiceCapabilityEvidence>;
  discoverVoiceProviderVoices(providerId: VoiceProviderId): Promise<{ supported: boolean; voices: VoiceInfo[]; evidence: VoiceCapabilityEvidence }>;
  testVoiceSpeech(request: { text: string; providerId?: VoiceProviderId; voiceId?: string; model?: string; petId?: string }): Promise<VoiceSpeakResult>;
  stopVoiceSpeech(petId?: string): Promise<{ ok: boolean }>;
  getVoiceConversationHealth(force?: boolean): Promise<VoiceConversationHealth>;
  getVoiceWakeHealth(): Promise<VoiceWakeHealth>;
  getVoiceWakeSnapshot(): Promise<VoiceWakeSnapshot>;
  getVoiceWakeCalibrationSnapshot(): Promise<VoiceWakeCalibrationSnapshot>;
  startVoiceWakeCalibration(phrase: string): Promise<VoiceWakeCalibrationSnapshot>;
  cancelVoiceWakeCalibration(): Promise<VoiceWakeCalibrationSnapshot>;
  saveVoiceWakeCalibration(): Promise<VoiceWakeCalibrationSnapshot>;
  deleteVoiceWakeCalibrationInterpretation(value: string): Promise<VoiceWakeCalibrationSnapshot>;
  resetVoiceWakeCalibration(): Promise<VoiceWakeCalibrationSnapshot>;
  getVisionSnapshot(forceHealth?: boolean): Promise<VisionSnapshot>;
  setVisionEnabled(enabled: boolean): Promise<VisionSnapshot>;
  pauseVision(minutes: 30 | 60 | 90): Promise<VisionSnapshot>;
  resumeVision(): Promise<VisionSnapshot>;
  setVisionModelPreference(preference: VisionModelPreference | null): Promise<VisionSnapshot>;
  checkVisionImageHealth(request: { kind: "codex"; model?: string; force?: boolean } | { kind: "host-ai"; provider: HostAiProfileId; model?: string; force?: boolean }): Promise<AiImageHealthSnapshot>;
  openVisionStorageFolder(): Promise<{ ok: true }>;
  getCompanionSettings(): Promise<CompanionSettings>;
  enableCompanion(): Promise<CompanionSettings>;
  disableCompanion(): Promise<CompanionSettings>;
  updateCompanionSettings(patch: Record<string, unknown>): Promise<CompanionSettings>;
  updateCompanionCharacterSettings(petId: string, patch: Partial<CompanionCharacterProfile>): Promise<CompanionSettings>;
  getCompanionMemoryStatus(): Promise<CompanionMemoryStatus>;
  importCompanionText(): Promise<{ canceled: true } | { canceled: false; text: string }>;
  generateCompanionCharacter(request: { petId: string; mode: "complete" | "reimagine"; draft: CompanionCharacterProfile; sourceText?: string }): Promise<{ draft: CompanionCharacterProfile; targetId: CompanionTargetId }>;
  clearCompanionMemory(petId?: string): Promise<{ ok: true }>;
  getCompanionTargetHealth(targetId?: CompanionTargetId, force?: boolean): Promise<CompanionTargetHealth>;
  getCodexModels(force?: boolean): Promise<CodexModelDiscoverySnapshot>;
  getDesktopPermissions(): Promise<DesktopPermissionSnapshot>;
  requestDesktopPermission(kind: DesktopPermissionKind): Promise<DesktopPermissionSnapshot>;
  openDesktopPermissionSettings(kind: DesktopPermissionKind): Promise<DesktopPermissionSnapshot>;
  restartForDesktopPermissions(): Promise<void>;
  getCatalog(): Promise<CatalogState>;
  getCatalogPage(page: number): Promise<CatalogState>;
  getCatalogSearch(): Promise<{ pets: SearchPetEntry[]; error?: string }>;
  getCodexPets(): Promise<CodexState>;
  setDefaultPet(petId: string): Promise<StateSnapshot>;
  installPet(petId: string): Promise<unknown>;
  installLocalPet(): Promise<unknown>;
  importCodexPet(petId: string): Promise<unknown>;
  openGallery(): Promise<void>;
  removePet(petId: string): Promise<StateSnapshot>;
  onRouteChange(callback: (route: Route | ControlCenterRouteRequest) => void): () => void;
  onPluginsRefresh(callback: () => void): () => void;
  getIntegrationsState(selectedPetId?: string, commandMode?: "published" | "local" | "bundled"): Promise<AgentSetupSnapshot>;
  runIntegrationAction(action: AgentSetupAction, selectedPetId?: string, commandMode?: "published" | "local" | "bundled"): Promise<AgentSetupSnapshot>;
  launchCodexHookReview(): Promise<{ ok: boolean; message: string }>;
  completeCodexHookReview(): Promise<{ ok: boolean }>;
  updateIntegrationCommandPaths(patch: Partial<AgentSetupCommandPaths>): Promise<AgentSetupCommandPaths>;
  updateCodexReactionPreferences(patch: Partial<CodexReactionPreferences>): Promise<AgentSetupSnapshot>;
};


type AgentSetupAction = "configure" | "replace" | "remove" | "install-memory" | "doctor-hooks" | "install-hooks" | "uninstall-hooks" | "opencode-install" | "opencode-remove" | "cursor-install" | "cursor-replace" | "cursor-remove" | "codex-install" | "codex-repair" | "codex-disconnect" | "codex-refresh";
type AgentSetupPetOption = { id: string; displayName: string; default: boolean };
type ClaudeCodeStatus = { state: "detected" | "not_detected" | "configured" | "needs_setup" | "error"; label: string; details: string; claudeCommand?: string; version?: string; mcpListWorks: boolean; openPetsEntry: { present: boolean; verified: boolean; matchesExpected: boolean }; canConfigure: boolean; canReplace: boolean; canRemove: boolean };
type ClaudeHookDoctorResult = { status: "installed" | "needs_setup" | "error" | "custom" | "conflict"; settingsPath: string; exists: boolean; valid: boolean; message: string; preview: Record<string, unknown>; asyncSupported: boolean; backupPath?: string };
type ClaudeOpenPetsMemoryStatus = { state: "installed" | "needs_setup" | "error"; label: string; details: string; claudeMdPath: string; openPetsMemoryPath: string; canInstall: boolean };
type OpenCodeSetupStatus = { state: "configured" | "needs_setup" | "not_detected" | "error"; label: string; details: string; configDir: string; canInstall: boolean; canRemove: boolean };
type OpenCodeSetupPreview = { global: true; configDir: string; configPath: string; cleanupConfigPaths: string[]; mcpCommand: string[]; plugin: unknown[] | string; instructionPath: string; configPreview: Record<string, unknown> };
type CursorSetupStatus = { state: "configured" | "needs_setup" | "not_detected" | "error" | "conflict" | "needs_update"; label: string; details: string; configPath: string; canInstall: boolean; canReplace: boolean; canRemove: boolean };
type CursorSetupPreview = { global: true; configPath: string; mcpEntry: Record<string, unknown>; rulesPath: string; rulesContent: string; commandMode: "published" | "local" | "bundled" };
type CodexIntegrationState = "not_detected" | "installable" | "installing" | "waiting_for_trust" | "connected" | "needs_repair" | "conflict" | "unsupported";
type CodexIntegrationSnapshot = { state: CodexIntegrationState; message: string; detected: boolean; command: string; version?: string; location?: string; supported: boolean; hooks: { state: string; trust: "missing" | "waiting" | "trusted" | "modified" | "unsupported"; path: string; installedEvents: string[]; changedEvents?: string[] }; mcp: { state: string; serverName: "openpets"; command?: string; args?: string[]; message?: string }; legacy: { detected: boolean; removable: boolean; details: string[] }; checks: Array<{ id: "cli" | "version" | "hooks" | "hook-trust" | "mcp" | "legacy"; state: "ok" | "needs_action" | "waiting" | "conflict" | "unsupported" | "error"; message: string; detail?: string }>; managedChanges: Array<{ id: string; path: string; title: string; detail: string; ownership: "managed" | "read_only" | "legacy"; present: boolean }>; canInstall: boolean; canRepair: boolean; canDisconnect: boolean; canRefresh: true };
type CodexReactionPreferences = { taskStarted: boolean; taskWorking: boolean; taskCompleted: boolean };
type AgentSetupCommandPaths = { claude: string; codex: string; node: string; opencode: string };
type AgentSetupActionResult = { ok: boolean; action: AgentSetupAction; message: string; changed: boolean };
type AgentSetupSnapshot = { selectedPetId?: string; commandMode: "published" | "local" | "bundled"; localDevAvailable: boolean; petOptions: AgentSetupPetOption[]; preview: { displayCommand: string; mcpJson: Record<string, unknown> }; status: ClaudeCodeStatus; hookStatus: ClaudeHookDoctorResult; memoryStatus: ClaudeOpenPetsMemoryStatus; opencodeStatus: OpenCodeSetupStatus; opencodePreview: OpenCodeSetupPreview; cursorStatus: CursorSetupStatus; cursorPreview: CursorSetupPreview; codexStatus: CodexIntegrationSnapshot; codexLastEvent?: { lifecycle: string; occurredAt: number; receivedAt: number }; codexReactionPreferences: CodexReactionPreferences; commandPaths: AgentSetupCommandPaths; busy: boolean; lastAction?: AgentSetupActionResult };
type StatusTone = keyof typeof statusPillToneClass;

const api = (window as unknown as { openPetsControlCenter: ControlCenterApi }).openPetsControlCenter;

function userFacingError(error: unknown): string {
  const raw = String((error as Error)?.message ?? error);
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim() || "OpenPets could not complete that action.";
}


// Inline SVG Icons for actions, pagination, and filters
const InstallIcon = () => (
  <svg className="btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

const ImportIcon = () => (
  <svg className="btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <path d="M12 18v-6" />
    <path d="m9 15 3 3 3-3" />
  </svg>
);

const SetDefaultIcon = () => (
  <svg className="btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
);

const ReplaceIcon = () => (
  <svg className="btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
    <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
    <path d="M21 21v-5h-5" />
  </svg>
);

const HookIcon = () => (
  <svg className="btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m18 15-6-6-6 6" />
  </svg>
);

const MemoryIcon = () => (
  <svg className="btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 10v6" />
    <path d="M9 13h6" />
    <rect width="18" height="18" x="3" y="3" rx="2" />
  </svg>
);

const RemoveIcon = () => (
  <svg className="btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18" />
    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
  </svg>
);

const RefreshIcon = () => (
  <svg className="btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M3 21v-5h5" />
  </svg>
);

const ConfigureIcon = () => (
  <svg className="btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="21" x2="14" y1="4" y2="4" />
    <line x1="10" x2="3" y1="4" y2="4" />
    <line x1="21" x2="12" y1="12" y2="12" />
    <line x1="8" x2="3" y1="12" y2="12" />
    <line x1="21" x2="16" y1="20" y2="20" />
    <line x1="12" x2="3" y1="20" y2="20" />
    <line x1="14" x2="14" y1="2" y2="6" />
    <line x1="8" x2="8" y1="10" y2="14" />
    <line x1="16" x2="16" y1="18" y2="22" />
  </svg>
);

const EyeIcon = () => (
  <svg className="btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const FolderPlusIcon = () => (
  <svg className="btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 10v6" />
    <path d="M9 13h6" />
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </svg>
);

const SaveIcon = () => (
  <svg className="btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8A2 2 0 0 1 21 8.8V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
    <path d="M17 21v-7H7v7" />
    <path d="M7 3v5h8" />
  </svg>
);

const CloseIcon = () => (
  <svg className="btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);

const PrevIcon = () => (
  <svg className="btn-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <path d="m15 18-6-6 6-6" />
  </svg>
);

const NextIcon = () => (
  <svg className="btn-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <path d="m9 18 6-6-6-6" />
  </svg>
);

const FilterAllIcon = () => (
  <svg className="filter-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <rect width="7" height="7" x="3" y="3" rx="1" />
    <rect width="7" height="7" x="14" y="3" rx="1" />
    <rect width="7" height="7" x="14" y="14" rx="1" />
    <rect width="7" height="7" x="3" y="14" rx="1" />
  </svg>
);

const FilterInstalledIcon = () => (
  <svg className="filter-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);

const FilterFeaturedIcon = () => (
  <svg className="filter-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3q1 4 4 6.5t3 5.5a7 7 0 0 1-14 0 5 5 0 0 1 1-3 3 3 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4" />
  </svg>
);

const FilterOriginalIcon = () => (
  <svg className="filter-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275Z" />
  </svg>
);

const FilterWesternIcon = () => (
  <svg className="filter-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
    <path d="M2 12h20" />
  </svg>
);

const FilterAsianIcon = () => (
  <svg className="filter-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2" />
    <path d="M12 20v2" />
    <path d="m4.93 4.93 1.41 1.41" />
    <path d="m17.66 17.66 1.41 1.41" />
    <path d="M2 12h2" />
    <path d="M20 12h2" />
    <path d="m6.34 17.66-1.41 1.41" />
    <path d="m19.07 4.93-1.41 1.41" />
  </svg>
);

const FilterCodexIcon = () => (
  <svg className="filter-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
  </svg>
);

const MessageIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);

const HeartIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
  </svg>
);

const StarIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
);

const ZapIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </svg>
);

const ActivityIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
  </svg>
);

const BoxIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
    <path d="m3.3 7 8.7 5 8.7-5" />
    <path d="M12 22V12" />
  </svg>
);

const ShieldIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1Z" />
  </svg>
);

// Navigation Shell Types and Icons
type Route = "dashboard" | "pets" | "settings" | "plugins" | "integrations";
type ControlCenterRouteRequest = { route: Route; petId?: string; section?: "companion"; notice?: "pet-unavailable" };

const DashboardIcon = () => (
  <svg className="nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect fill="currentColor" width="7" height="9" x="3" y="3" rx="1" />
    <rect fill="currentColor" width="7" height="5" x="14" y="3" rx="1" />
    <rect fill="currentColor" width="7" height="9" x="14" y="12" rx="1" />
    <rect fill="currentColor" width="7" height="5" x="3" y="16" rx="1" />
  </svg>
);

const PetsIcon = () => (
  <svg className="nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle fill="currentColor" cx="11" cy="4" r="2" />
    <circle fill="currentColor" cx="18" cy="8" r="2" />
    <circle fill="currentColor" cx="20" cy="16" r="2" />
    <path fill="currentColor" d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045q-.64-2.065-2.7-2.705A3.5 3.5 0 0 1 5.5 10Z" />
  </svg>
);

const SettingsIcon = () => (
  <svg className="nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="21" x2="14" y1="4" y2="4" />
    <line x1="10" x2="3" y1="4" y2="4" />
    <line x1="21" x2="12" y1="12" y2="12" />
    <line x1="8" x2="3" y1="12" y2="12" />
    <line x1="21" x2="16" y1="20" y2="20" />
    <line x1="12" x2="3" y1="20" y2="20" />
    <line x1="14" x2="14" y1="2" y2="6" />
    <line x1="8" x2="8" y1="10" y2="14" />
    <line x1="16" x2="16" y1="18" y2="22" />
  </svg>
);

const PluginsIcon = () => (
  <svg className="nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path fill="currentColor" d="M10 22V7a1 1 0 0 0-1-1H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5a1 1 0 0 0-1-1H2" />
    <rect fill="currentColor" width="8" height="8" x="14" y="2" rx="1" />
  </svg>
);

const IntegrationsIcon = () => (
  <svg className="nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="6" cy="6" r="3" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="12" cy="18" r="3" />
    <path d="M8.6 7.5 10.8 15" />
    <path d="M15.4 7.5 13.2 15" />
    <path d="M9 6h6" />
  </svg>
);

const VolumeIcon = () => (
  <svg className="nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11 5 6 9H2v6h4l5 4z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    <path d="M18.5 5.5a9 9 0 0 1 0 13" />
  </svg>
);

const navTabs = [
  { id: "dashboard" as const, labelKey: "nav.dashboard", icon: <DashboardIcon /> },
  { id: "pets" as const, labelKey: "nav.pets", icon: <PetsIcon /> },
  { id: "settings" as const, labelKey: "nav.settings", icon: <SettingsIcon /> },
  { id: "plugins" as const, labelKey: "nav.plugins", icon: <PluginsIcon /> },
  { id: "integrations" as const, labelKey: "nav.integrations", icon: <IntegrationsIcon /> },
];

const routeMetadata: Record<Route, { titleKey: string; descKey: string }> = {
  dashboard: {
    titleKey: "route.dashboard.title",
    descKey: "route.dashboard.description",
  },
  pets: {
    titleKey: "route.pets.title",
    descKey: "route.pets.description",
  },
  settings: {
    titleKey: "route.settings.title",
    descKey: "route.settings.description",
  },
  plugins: {
    titleKey: "route.plugins.title",
    descKey: "route.plugins.description",
  },
  integrations: {
    titleKey: "route.integrations.title",
    descKey: "route.integrations.description",
  },
};

function DashboardView({ onNavigate }: { onNavigate: (route: Route) => void }) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [error, setError] = useState("");

  const load = async () => {
    try {
      const next = await api.getDashboardSnapshot();
      setSnapshot(next);
      setError("");
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    }
  };

  useEffect(() => { void load(); }, []);

  if (!snapshot) {
    return (
      <div className="flex flex-col gap-6 h-full">
        <GlassCard className="flex h-full flex-col items-center justify-center gap-4 text-center py-16">
          <p className="text-sm font-semibold text-slatecopy">{error || t("dashboard.loading")}</p>
          {error && <Button variant="secondary" size="compact" icon={<RefreshIcon />} onClick={() => void load()}>{t("common.retry")}</Button>}
        </GlassCard>
      </div>
    );
  }

  const { activity, defaultPet, plugins, installedPetCount, updateStatus, catalog } = snapshot;

  // Find top pet by activity or fallback to default
  const topPetId = Object.entries(activity.perPetActivityCounts).sort(([, a], [, b]) => b - a)[0]?.[0];
  const topPetName = topPetId === defaultPet.id ? defaultPet.displayName : (topPetId || defaultPet.displayName);

  // Find top reaction
  const reactionEntries = Object.entries(activity.reactionCounts)
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a);
  const reactionTotal = reactionEntries.reduce((total, [, count]) => total + count, 0);
  const reactionColors = ["#3b82f6", "#a855f7", "#f97316", "#14b8a6"];
  const reactionDonutSegments = reactionEntries.slice(0, 4).map(([label, count], index) => ({
    label,
    count,
    color: reactionColors[index] ?? "#64748b",
  }));
  const topCompanionEntries = Object.entries(activity.perPetActivityCounts)
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 4);
  const maxCompanionActivity = Math.max(...topCompanionEntries.map(([, count]) => count), 1);
  const lastActiveLabel = activity.lastActivityAt ? new Date(activity.lastActivityAt).toLocaleString() : t("dashboard.lastActive.none");
  const updateLabel = updateStatus.state === "available" ? t("dashboard.update.available") : updateStatus.state === "error" ? t("dashboard.update.error") : updateStatus.state === "checking" ? t("dashboard.update.checking") : updateStatus.state === "current" ? t("dashboard.update.current") : t("dashboard.update.notChecked");

  return (
    <div className="dashboard-layout">
      {error && <div className="error">{error}</div>}

      <section className="dashboard-hero">
        <div className="dashboard-hero-content">
          <p className="eyebrow !text-blue-100 opacity-80">{t("dashboard.hero.eyebrow")}</p>
          <h2 className="dashboard-hero-title">{defaultPet.displayName}</h2>
          <p className="dashboard-hero-desc">
            {t("dashboard.hero.desc")}
          </p>
          <div className="flex gap-3 mt-3">
            <Button variant="secondary" size="compact" onClick={() => onNavigate("pets")}>{t("dashboard.hero.changePet")}</Button>
          </div>
        </div>
        <div className="dashboard-hero-pet">
          <SpriteFrame src={defaultPet.previewSpriteUrl} label={defaultPet.displayName} state="idle" size="detail" />
        </div>
      </section>

      <div className="dashboard-grid">
        <article className="dashboard-stat-card">
          <div className="dashboard-stat-header">
            <div className="dashboard-stat-icon"><MessageIcon /></div>
            <span className="dashboard-stat-label">{t("dashboard.stat.messages")}</span>
          </div>
          <div className="dashboard-stat-value">{activity.messagesSent.toLocaleString()}</div>
          <div className="dashboard-stat-footer">{t("dashboard.stat.messages.footer")}</div>
        </article>

        <article className="dashboard-stat-card">
          <div className="dashboard-stat-header">
            <div className="dashboard-stat-icon"><HeartIcon /></div>
            <span className="dashboard-stat-label">{t("dashboard.stat.reactions")}</span>
          </div>
          <div className="dashboard-stat-value">{activity.reactionsSent.toLocaleString()}</div>
          <div className="dashboard-stat-footer">{t("dashboard.stat.reactions.footer")}</div>
        </article>

        <article className="dashboard-stat-card">
          <div className="dashboard-stat-header">
            <div className="dashboard-stat-icon"><StarIcon /></div>
            <span className="dashboard-stat-label">{t("dashboard.stat.topCompanion")}</span>
          </div>
          <div className="dashboard-stat-value truncate text-2xl">{topPetName}</div>
          <div className="dashboard-stat-footer">{t("dashboard.stat.topCompanion.footer")}</div>
        </article>
      </div>

      <div className="dashboard-row">
        <GlassCard className="dashboard-activity-card">
          <div className="dashboard-section-title"><ActivityIcon /> {t("dashboard.activity.title")}</div>
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-3">
              <span className="text-[10px] font-bold text-slatecopy uppercase tracking-wider">{t("dashboard.activity.topReactions")}</span>
              <div className="dashboard-reaction-list">
                {reactionEntries.length > 0 ? (
                  reactionEntries.slice(0, 6)
                    .map(([label, count]) => (
                      <div key={label} className="dashboard-reaction-item">
                        <span className="dashboard-reaction-count">{count}</span>
                        <span className="dashboard-reaction-label">{label}</span>
                      </div>
                    ))
                ) : (
                  <div className="text-xs text-slatecopy italic py-2">{t("dashboard.activity.noReactions")}</div>
                )}
              </div>
            </div>

            <div className="dashboard-activity-charts">
              <section className="dashboard-chart-panel dashboard-reaction-mix">
                <div className="dashboard-chart-heading">
                  <span>{t("dashboard.reactionMix.title")}</span>
                  <small>{reactionTotal ? t("dashboard.reactionMix.total", { count: reactionTotal.toLocaleString() }) : t("dashboard.reactionMix.waiting")}</small>
                </div>
                <div className="dashboard-donut-row">
                  <div className="dashboard-donut" aria-label={t("dashboard.reactionMix.chartLabel")}>
                    <svg viewBox="0 0 100 100" role="img">
                      <circle className="dashboard-donut-track" cx="50" cy="50" r="40" />
                      {reactionTotal > 0 && reactionDonutSegments.map((segment, index) => {
                        const circumference = 251.327;
                        const previousTotal = reactionDonutSegments.slice(0, index).reduce((total, item) => total + item.count, 0);
                        const dash = (segment.count / reactionTotal) * circumference;
                        const offset = -(previousTotal / reactionTotal) * circumference;
                        return <circle key={segment.label} className="dashboard-donut-segment" cx="50" cy="50" r="40" stroke={segment.color} strokeDasharray={`${dash} ${circumference - dash}`} strokeDashoffset={offset} />;
                      })}
                    </svg>
                    <div className="dashboard-donut-center">
                      <strong>{reactionTotal.toLocaleString()}</strong>
                      <span>{t("dashboard.reactionMix.reactions")}</span>
                    </div>
                  </div>
                  <div className="dashboard-donut-legend">
                    {reactionDonutSegments.length ? reactionDonutSegments.map((segment) => (
                      <div key={segment.label} className="dashboard-donut-legend-item">
                        <span className="dashboard-donut-dot" style={{ background: segment.color }} />
                        <span>{segment.label}</span>
                        <strong>{segment.count}</strong>
                      </div>
                    )) : <p>{t("dashboard.reactionMix.empty")}</p>}
                  </div>
                </div>
              </section>

              <section className="dashboard-chart-panel dashboard-companion-bars">
                <div className="dashboard-chart-heading">
                  <span>{t("dashboard.companions.title")}</span>
                  <small>{t("dashboard.companions.subtitle")}</small>
                </div>
                <div className="dashboard-bars-list">
                  {topCompanionEntries.length ? topCompanionEntries.map(([petId, count]) => {
                    const label = petId === defaultPet.id ? defaultPet.displayName : petId.replace(/[-_]/g, " ");
                    return (
                      <div key={petId} className="dashboard-bar-item">
                        <div className="dashboard-bar-labels">
                          <span>{label}</span>
                          <strong>{count}</strong>
                        </div>
                        <div className="dashboard-bar-track"><span style={{ width: `${Math.max(8, Math.round((count / maxCompanionActivity) * 100))}%` }} /></div>
                      </div>
                    );
                  }) : <p className="dashboard-empty-note">{t("dashboard.companions.empty")}</p>}
                </div>
              </section>

              <div className="dashboard-last-active-pill">{t("dashboard.lastActive.label")}<strong>{lastActiveLabel}</strong></div>
            </div>
          </div>
        </GlassCard>

        <GlassCard className="dashboard-system-card">
          <div className="dashboard-section-title"><ZapIcon /> {t("dashboard.system.title")}</div>
          <div className="dashboard-system-list">
            <div className="dashboard-system-item">
              <div className="dashboard-system-info">
                <div className="dashboard-system-icon"><BoxIcon /></div>
                <span className="dashboard-system-label">{t("dashboard.system.pets")}</span>
              </div>
              <span className="dashboard-system-value">{t("dashboard.system.pets.value", { count: installedPetCount })}</span>
            </div>

            <div className="dashboard-system-item">
              <div className="dashboard-system-info">
                <div className="dashboard-system-icon"><PluginGlyph className="w-4 h-4" /></div>
                <span className="dashboard-system-label">{t("dashboard.system.plugins")}</span>
              </div>
              <div className="flex gap-1.5">
                <StatusPill tone="green">{t("dashboard.system.plugins.enabled", { count: plugins.enabled })}</StatusPill>
                {plugins.broken > 0 && <StatusPill tone="red">{plugins.broken}</StatusPill>}
              </div>
            </div>

            <div className="dashboard-system-item">
              <div className="dashboard-system-info">
                <div className="dashboard-system-icon"><StarIcon /></div>
                <span className="dashboard-system-label">{t("dashboard.system.catalog")}</span>
              </div>
              <span className="dashboard-system-value">{catalog.error ? t("dashboard.system.catalog.offline") : catalog.total ? t("dashboard.system.catalog.pets", { count: catalog.total }) : t("dashboard.system.catalog.ready")}</span>
            </div>

            <div className="dashboard-system-item">
              <div className="dashboard-system-info">
                <div className="dashboard-system-icon"><ShieldIcon /></div>
                <span className="dashboard-system-label">{t("dashboard.system.updates")}</span>
              </div>
              <StatusPill tone={updateStatus.state === "available" ? "orange" : "blue"}>
                {updateLabel}
              </StatusPill>
            </div>
          </div>

          <div className="mt-auto pt-4 border-t border-blue-100/30">
             <div className="flex items-center justify-between text-[10px] font-bold text-slatecopy uppercase tracking-wider">
               <span>{t("dashboard.system.version")}</span>
               <span className="font-mono">{updateStatus.currentVersion}</span>
             </div>
          </div>
        </GlassCard>
      </div>
    </div>
  );
}

function PlaceholderView({ route }: { route: "dashboard" }) {
  const { t } = useI18n();
  const meta = routeMetadata[route];
  return (
    <div className="grid grid-cols-1 w-full">
      <GlassCard className="flex flex-col items-center justify-center text-center py-16 px-8 h-full min-h-[420px]">
        <div className="p-4 rounded-3xl bg-blue-50/80 border border-blue-100/50 mb-6 text-brand">
          {route === "dashboard" && <DashboardIcon />}
        </div>
        <h2 className="font-monoDisplay text-2xl font-black mb-2 text-navy">{t(meta.titleKey)}</h2>
        <p className="text-sm text-slatecopy max-w-md mb-6">{t(meta.descKey)}</p>
        <span className="inline-flex items-center rounded-full bg-blue-50/80 px-4 py-1.5 text-xs font-bold text-brand border border-blue-200/50">
          {t("placeholder.comingSoon")}
        </span>
      </GlassCard>
    </div>
  );
}

const filterIcons: Record<Filter, React.ReactNode> = {
  all: <FilterAllIcon />,
  installed: <FilterInstalledIcon />,
  featured: <FilterFeaturedIcon />,
  originals: <FilterOriginalIcon />,
  codex: <FilterCodexIcon />,
};

const filterLabelKeys: Record<Filter, string> = {
  all: "pets.filter.all",
  installed: "pets.filter.installed",
  featured: "pets.filter.featured",
  originals: "pets.filter.originals",
  codex: "pets.filter.codex",
};

const buttonVariantClass = {
  primary: "btn-primary",
  secondary: "btn-secondary",
  danger: "btn-danger",
  success: "btn-success",
  warning: "btn-warning",
} as const;

const statusPillToneClass = {
  blue: "pill-blue",
  green: "pill-green",
  orange: "pill-orange",
  purple: "pill-purple",
  yellow: "pill-yellow",
  red: "pill-red",
  slate: "pill-slate",
} as const;

function isRoute(value: string | null | undefined): value is Route {
  return value === "dashboard" || value === "pets" || value === "settings" || value === "plugins" || value === "integrations";
}

function normalizeControlCenterRouteRequest(value: unknown): ControlCenterRouteRequest {
  if (typeof value === "string") return { route: isRoute(value) ? value : "dashboard" };
  if (!value || typeof value !== "object") return { route: "dashboard" };
  const candidate = value as Partial<ControlCenterRouteRequest>;
  const route = isRoute(candidate.route) ? candidate.route : "dashboard";
  if (route !== "pets") return { route };
  return {
    route,
    ...(typeof candidate.petId === "string" ? { petId: candidate.petId } : {}),
    ...(candidate.section === "companion" ? { section: "companion" as const } : {}),
    ...(candidate.notice === "pet-unavailable" ? { notice: "pet-unavailable" as const } : {}),
  };
}

function initialControlCenterRoute(): ControlCenterRouteRequest {
  try {
    const params = new URLSearchParams(window.location.search);
    const route = params.get("route");
    return normalizeControlCenterRouteRequest({
      route,
      petId: params.get("petId") ?? undefined,
      section: params.get("section") ?? undefined,
      notice: params.get("notice") ?? undefined,
    });
  } catch {
    return { route: "dashboard" };
  }
}

const commandModeLabelKeys: Record<AgentSetupSnapshot["commandMode"], string> = {
  published: "integrations.commandMode.published",
  bundled: "integrations.commandMode.bundled",
  local: "integrations.commandMode.local",
};

function Button({
  children,
  variant = "primary",
  size = "normal",
  onClick,
  disabled,
  icon,
  iconPosition = "left",
  fullWidth,
  ariaLabel,
}: {
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "danger" | "success" | "warning";
  size?: "normal" | "compact";
  onClick?: () => void;
  disabled?: boolean;
  icon?: React.ReactNode;
  iconPosition?: "left" | "right";
  fullWidth?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      className={`btn ${buttonVariantClass[variant]} ${size === "compact" ? "btn-compact" : ""} ${fullWidth ? "w-full" : ""} ${icon ? "has-icon" : ""}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
    >
      {icon && iconPosition === "left" && <span className="btn-icon-wrapper mr-1.5 inline-flex items-center justify-center">{icon}</span>}
      <span className="btn-text">{children}</span>
      {icon && iconPosition === "right" && <span className="btn-icon-wrapper ml-1.5 inline-flex items-center justify-center">{icon}</span>}
    </button>
  );
}
function GlassCard({ children, className = "" }: { children: React.ReactNode; className?: string }) { return <section className={`glass ${className}`}>{children}</section>; }
function StatusPill({ children, tone = "blue" }: { children: React.ReactNode; tone?: keyof typeof statusPillToneClass }) { return <span className={`pill ${statusPillToneClass[tone]}`}>{children}</span>; }
function SearchInput(props: React.InputHTMLAttributes<HTMLInputElement>) { const { t } = useI18n(); return <input className="search" placeholder={t("pets.search.placeholder")} {...props} />; }

function isAllowedCatalogPreview(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "openpets.dev" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname.startsWith("/pets/") &&
      url.pathname.endsWith(".webp");
  } catch {
    return false;
  }
}

function isAllowedCodexPreview(value: string | undefined): value is string {
  return typeof value === "string" && /^openpets-codex:\/\/spritesheet\/[a-zA-Z0-9%][a-zA-Z0-9%_-]{0,128}$/u.test(value);
}

function isAllowedInstalledPetPreview(value: string | undefined): value is string {
  return typeof value === "string" && /^openpets-installed:\/\/spritesheet\/[a-zA-Z0-9%][a-zA-Z0-9%_-]{0,128}$/u.test(value);
}

function isAllowedDefaultPetPreview(value: string | undefined): value is string {
  return typeof value === "string" && /^openpets-pet-preview:\/\/spritesheet\/default\?v=[a-z0-9_-]+-\d+-\d+$/u.test(value);
}

function isAllowedDataUrl(value: string | undefined): value is string {
  return typeof value === "string" && /^data:image\/(?:png|webp|jpeg|jpg);base64,[a-z0-9+/=]+$/iu.test(value);
}

function safePetImage(value: string | undefined): string | undefined {
  return isAllowedCatalogPreview(value) || isAllowedCodexPreview(value) || isAllowedInstalledPetPreview(value) || isAllowedDefaultPetPreview(value) || isAllowedDataUrl(value) ? value : undefined;
}

function installedPetSpritesheetUrl(petId: string): string {
  return `openpets-installed://spritesheet/${encodeURIComponent(petId)}`;
}

function imageDebug(value: string | undefined): string {
  if (!value) return "missing";
  if (value.startsWith("data:image/")) return `data:${value.slice(5, 16)}`;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}${url.pathname}`;
  } catch {
    return "invalid-url";
  }
}

function logPetsEvent(event: string, fields: Record<string, unknown>): void {
  console.info(`[ControlCenterPets] ${JSON.stringify({ event, ...fields })}`);
}

function logPetsError(event: string, fields: Record<string, unknown>): void {
  console.error(`[ControlCenterPets] ${JSON.stringify({ event, ...fields })}`);
}

const spriteFrameSizes = {
  thumb: { width: 54, height: 58 },
  detail: { width: 144, height: 156 },
  mini: { width: 56, height: 61 },
} as const;

const spriteStates = {
  idle: { row: 0, frames: 6, duration: "1.65s" },
  thinking: { row: 8, frames: 6, duration: "1.55s" },
  wave: { row: 3, frames: 4, duration: "1.25s" },
  happy: { row: 4, frames: 5, duration: "1.35s" },
} as const;

function SpriteFrame({ src, label, state = "idle", size = "detail" }: { src?: string; label: string; state?: "idle" | "thinking" | "happy" | "wave"; size?: "thumb" | "detail" | "mini" }) {
  const safeSrc = safePetImage(src);
  if (!safeSrc) return <img src={defaultThumbUrl} alt="" />;
  const frame = spriteFrameSizes[size];
  const sprite = spriteStates[state];
  const xValues = Array.from({ length: sprite.frames }, (_, index) => String(-index * frame.width)).join(";");
  const y = -sprite.row * frame.height;
  return <svg className={`sprite-frame sprite-${state} sprite-${size}`} width={frame.width} height={frame.height} viewBox={`0 0 ${frame.width} ${frame.height}`} role="img" aria-label={label}>
    <image href={safeSrc} x="0" y={y} width={frame.width * 8} height={frame.height * 9} preserveAspectRatio="none" onError={() => logPetsError("sprite-failed", { label, state, size, src: imageDebug(safeSrc) })}>
      <animate attributeName="x" values={xValues} dur={sprite.duration} repeatCount="indefinite" calcMode="discrete" />
    </image>
  </svg>;
}

function PetImage({ src, alt = "", debugLabel }: { src?: string; alt?: string; debugLabel: string }) {
  const safeSrc = safePetImage(src) || defaultThumbUrl;
  return <img src={safeSrc} alt={alt} draggable="false" onError={() => logPetsError("image-failed", { label: debugLabel, src: imageDebug(safeSrc) })} />;
}

function PetPoolOrderList({
  order,
  candidates,
  disabled,
  onChangeOrder,
}: {
  order: readonly string[];
  candidates: ReadonlyArray<PetPoolCandidate>;
  disabled: boolean;
  onChangeOrder: (newOrder: string[]) => void;
}) {
  const [addValue, setAddValue] = useState("");
  const nameFor = (id: string) => candidates.find((c) => c.id === id)?.displayName ?? id;
  const available = candidates.filter((c) => !order.includes(c.id));

  function handleAdd() {
    const val = addValue || available[0]?.id;
    if (!val) return;
    onChangeOrder([...order, val]);
    setAddValue("");
  }

  function handleRemove(idx: number) {
    onChangeOrder([...order.slice(0, idx), ...order.slice(idx + 1)]);
  }

  function handleMoveUp(idx: number) {
    if (idx === 0) return;
    const next = [...order];
    const above = next[idx - 1] as string;
    const current = next[idx] as string;
    next[idx - 1] = current;
    next[idx] = above;
    onChangeOrder(next);
  }

  function handleMoveDown(idx: number) {
    if (idx === order.length - 1) return;
    const next = [...order];
    const below = next[idx + 1] as string;
    const current = next[idx] as string;
    next[idx + 1] = current;
    next[idx] = below;
    onChangeOrder(next);
  }

  return (
    <div className="flex flex-col border-t border-blue-50">
      {order.length === 0 && (
        <p className="px-5 py-4 text-xs text-slatecopy">No pets in the pool yet. Add one below.</p>
      )}
      {order.map((id, idx) => (
        <div
          key={id}
          className="flex items-center gap-3 border-b border-blue-50 px-5 py-3 transition-colors hover:bg-white/80 last:border-b-0"
        >
          <span className="w-14 shrink-0 font-mono text-xs font-bold text-slatecopy">
            {`Slot ${idx + 1}`}
          </span>
          <span className="flex-1 truncate text-sm font-semibold text-navy">{nameFor(id)}</span>
          <div className="flex shrink-0 items-center gap-1">
            <button
              className="btn btn-compact btn-secondary"
              disabled={disabled || idx === 0}
              onClick={() => handleMoveUp(idx)}
              aria-label="Move up"
            >
              ↑
            </button>
            <button
              className="btn btn-compact btn-secondary"
              disabled={disabled || idx === order.length - 1}
              onClick={() => handleMoveDown(idx)}
              aria-label="Move down"
            >
              ↓
            </button>
            <button
              className="btn btn-compact btn-danger"
              disabled={disabled}
              onClick={() => handleRemove(idx)}
              aria-label="Remove from pool"
            >
              Remove
            </button>
          </div>
        </div>
      ))}
      <div className="flex items-center gap-3 px-5 py-3">
        {candidates.length === 0 ? (
          <p className="text-xs text-slatecopy">No additional pets installed. Install pets from the catalog to add them here.</p>
        ) : available.length === 0 ? (
          <p className="text-xs text-slatecopy">All installed pets are already in the pool.</p>
        ) : (
          <>
            <select
              className="settings-select flex-1"
              value={addValue || (available[0]?.id ?? "")}
              disabled={disabled}
              onChange={(e) => setAddValue(e.target.value)}
            >
              {available.map((c) => (
                <option key={c.id} value={c.id}>{c.displayName}</option>
              ))}
            </select>
            <Button
              variant="secondary"
              size="compact"
              disabled={disabled || available.length === 0}
              onClick={handleAdd}
            >
              Add to pool
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function ToggleRow({ title, description, checked, disabled, onChange, testId }: { title: string; description: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void; testId?: string }) {
  return <label className={`settings-row ${disabled ? "opacity-60" : ""}`}>
    <div className="settings-row-info"><strong>{title}</strong><small>{description}</small></div>
    <input className="settings-toggle" type="checkbox" checked={checked} disabled={disabled} data-testid={testId} onChange={(event) => { const next = event.target.checked; onChange(next); }} />
  </label>;
}

function formatUpdateStatus(status: UpdateStatus | null, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (!status) return t("settings.update.notLoaded");
  if (status.state === "checking") return t("settings.update.checking");
  if (status.state === "available") return t("settings.update.available", { version: status.latestVersion ?? t("common.latest") });
  if (status.state === "current") return t("settings.update.current");
  if (status.state === "error") return status.error || t("settings.update.failed");
  return t("settings.update.version", { version: status.currentVersion });
}

function ReactionPreviewSprite({ settings, state }: { settings: ReactionAnimationSettings; state: UserSelectableAnimationState }) {
  const { t } = useI18n();
  const frame = { width: settings.sprite.frameWidth, height: settings.sprite.frameHeight };
  const sprite = settings.sprite.states[state] ?? settings.sprite.states.idle;
  const xValues = Array.from({ length: sprite.frames }, (_, index) => String(-index * frame.width)).join(";");
  const y = -sprite.row * frame.height;

  return (
    <div className="reaction-preview-sprite-shell">
      <svg className="reaction-preview-sprite" width={frame.width} height={frame.height} viewBox={`0 0 ${frame.width} ${frame.height}`} role="img" aria-label={t("settings.reactions.previewAria", { state })}>
        <image href={settings.previewSpriteUrl} x="0" y={y} width={frame.width * settings.sprite.columns} height={frame.height * settings.sprite.rows} preserveAspectRatio="none">
          <animate attributeName="x" values={xValues} dur={`${sprite.durationMs}ms`} repeatCount="indefinite" calcMode="discrete" />
        </image>
      </svg>
    </div>
  );
}

function MemorySettingsPanel({ busy, run, setMessage, onDirtyChange }: { busy: boolean; run: (label: string, fn: () => Promise<void>) => Promise<void>; setMessage: (message: string) => void; onDirtyChange: (dirty: boolean) => void }) {
  const { t } = useI18n();
  const [companion, setCompanion] = useState<CompanionSettings | null>(null);
  const [memoryStatus, setMemoryStatus] = useState<CompanionMemoryStatus | null>(null);
  const [name, setName] = useState("");
  const [preferredAddress, setPreferredAddress] = useState("");
  const [aboutYou, setAboutYou] = useState("");

  const apply = React.useCallback((next: CompanionSettings) => {
    setCompanion(next);
    setName(next.profile.name);
    setPreferredAddress(next.profile.preferredAddress);
    setAboutYou(next.profile.aboutYou);
  }, []);

  useEffect(() => {
    void Promise.all([api.getCompanionSettings(), api.getCompanionMemoryStatus()]).then(([next, status]) => {
      apply(next); setMemoryStatus(status);
    });
  }, [apply]);

  const dirty = companion !== null && (name !== companion.profile.name || preferredAddress !== companion.profile.preferredAddress || aboutYou !== companion.profile.aboutYou);
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  const frequency = companion?.proactivity.enabled ? companion.proactivity.frequency : "off";
  const memoryAge = memoryStatus?.oldestCreatedAt ? Math.max(1, Math.ceil((Date.now() - memoryStatus.oldestCreatedAt) / 3_600_000)) : 0;

  return <div className="settings-section">
    <p className="eyebrow">{t("settings.memory.eyebrow")}</p>
    <h2 className="settings-section-title">{t("settings.memory.title")}</h2>
    <p className="text-sm text-slatecopy -mt-2 mb-2">{t("settings.memory.description")}</p>

    {!companion ? <div className="settings-group"><div className="settings-row"><div className="settings-row-info"><strong>{t("common.loading")}</strong></div></div></div> : <>
      {!companion.enabled && <div className="companion-disclosure">
        <strong>{t("settings.memory.enableTitle")}</strong><p>{t("settings.memory.enableDescription")}</p>
        <Button variant="primary" disabled={busy} onClick={() => void run(t("settings.busy.saving"), async () => { apply(await api.enableCompanion()); setMessage(t("pets.companion.enabled")); })}>{t("pets.companion.enable")}</Button>
      </div>}

      <div className="settings-group companion-memory-form">
        <div className="settings-row settings-row-stack">
          <div className="settings-row-info"><strong>{t("settings.memory.aboutTitle")}</strong><small>{t("settings.memory.aboutDescription")}</small></div>
          <div className="companion-profile-grid w-full">
            <label className="companion-field"><span>{t("pets.companion.yourName")}</span><input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} placeholder={t("settings.memory.namePlaceholder")} /></label>
            <label className="companion-field"><span>{t("pets.companion.addressYouAs")}</span><input value={preferredAddress} maxLength={120} onChange={(event) => setPreferredAddress(event.target.value)} placeholder={t("settings.memory.addressPlaceholder")} /></label>
          </div>
          <label className="companion-field w-full"><span>{t("settings.memory.aboutYou")}</span><small>{t("settings.memory.aboutYouDescription")}</small><textarea value={aboutYou} maxLength={4000} rows={7} onChange={(event) => setAboutYou(event.target.value)} placeholder={t("settings.memory.aboutYouPlaceholder")} /></label>
          <div className="companion-field-actions w-full"><span>{aboutYou.length}/4000</span><div className="flex gap-2"><Button variant="secondary" size="compact" disabled={busy} onClick={() => void run(t("settings.memory.importing"), async () => { const result = await api.importCompanionText(); if (result.canceled) return; if (result.text.length > 4000) throw new Error(t("settings.memory.importTooLong")); setAboutYou(result.text); })}>{t("settings.memory.import")}</Button><Button variant="primary" size="compact" disabled={busy || !dirty} onClick={() => void run(t("settings.busy.saving"), async () => { apply(await api.updateCompanionSettings({ profile: { name, preferredAddress, aboutYou } })); setMessage(t("pets.companion.profileSaved")); })}>{dirty ? t("settings.memory.saveDraft") : t("common.saved")}</Button></div></div>
          {dirty && <div className="companion-unsaved">{t("settings.memory.unsaved")}</div>}
        </div>
      </div>

      <div className="settings-group">
        <ToggleRow title={t("settings.memory.recentTitle")} description={t("settings.memory.recentDescription")} checked={companion.memory.enabled} disabled={busy || !companion.enabled} onChange={(checked) => void run(t("settings.busy.saving"), async () => { apply(await api.updateCompanionSettings({ memory: { enabled: checked } })); setMessage(t("pets.companion.preferencesSaved")); })} />
        <div className="settings-row"><div className="settings-row-info"><strong>{t("settings.memory.statusTitle")}</strong><small>{memoryStatus?.entryCount ? t("settings.memory.statusEntries", { count: memoryStatus.entryCount, hours: memoryAge }) : t("settings.memory.statusEmpty")}</small></div><Button variant="secondary" size="compact" disabled={busy || !memoryStatus?.entryCount} onClick={() => void run(t("settings.busy.saving"), async () => { await api.clearCompanionMemory(); setMemoryStatus(await api.getCompanionMemoryStatus()); setMessage(t("pets.companion.memoryCleared")); })}>{t("settings.memory.clear")}</Button></div>
        <div className="settings-row"><div className="settings-row-info"><strong>{t("settings.memory.checkIns")}</strong><small>{t("settings.memory.checkInsDescription")}</small></div><select className="settings-select" value={frequency} disabled={busy || !companion.enabled} onChange={(event) => void run(t("settings.busy.saving"), async () => { const value = event.target.value; apply(await api.updateCompanionSettings({ proactivity: value === "off" ? { enabled: false } : { enabled: true, frequency: value } })); setMessage(t("pets.companion.frequencySaved")); })}><option value="off">{t("settings.memory.off")}</option><option value="rarely">{t("pets.companion.frequency.rarely")}</option><option value="sometimes">{t("pets.companion.frequency.sometimes")}</option><option value="often">{t("pets.companion.frequency.often")}</option></select></div>
      </div>
    </>}
  </div>;
}

function SettingsView({ onNavigate }: { onNavigate: (route: Route) => void }) {
  const { t, localePreference, availableLocales, reload: reloadI18n } = useI18n();
  const [settings, setSettings] = useState<SettingsState | null>(null);
  const [reactionSettings, setReactionSettings] = useState<ReactionAnimationSettings | null>(null);
  const [launchAtLogin, setLaunchAtLogin] = useState<LaunchAtLoginState | null>(null);
  const [lanStatus, setLanStatus] = useState<LanStatusSnapshot | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [activeTab, setActiveTab] = useState<"general" | "reactions" | "memory" | "plugins" | "lan" | "listen" | "speak" | "vision" | "ai-brain">("general");
  const [pluginsSnapshot, setPluginsSnapshot] = useState<PluginServiceSnapshot | null>(null);
  const [platformSettings, setPlatformSettings] = useState<PluginPlatformSettings | null>(null);
  const [hostAiSettings, setHostAiSettings] = useState<HostAiSettingsSnapshot | null>(null);
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettingsSnapshot | null>(null);
  const [voiceSecrets, setVoiceSecrets] = useState<VoiceSecretStatus>({ "openai-compatible": { hasKey: false }, elevenlabs: { hasKey: false } });
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [memoryDirty, setMemoryDirty] = useState(false);
  const reactionSaveQueue = useRef(Promise.resolve());
  const settingsContentRef = useRef<HTMLElement | null>(null);
  const switchSettingsTab = (next: typeof activeTab) => {
    if (activeTab === "memory" && memoryDirty && !window.confirm(t("settings.memory.discardConfirm"))) return;
    setActiveTab(next);
  };

  async function loadSettings() {
    setError("");
    const [nextSettings, nextReactions, nextLaunch, nextUpdate, nextPlatform, nextAiSettings, nextLanStatus, nextPluginsSnapshot, nextVoiceSettings, nextVoiceSecrets] = await Promise.all([
      api.getSettingsState(),
      api.getReactionAnimationSettings(),
      api.getLaunchAtLogin(),
      api.getUpdateStatus(),
      api.getPluginPlatformSettings().catch(() => null),
      api.getHostAiSettings().catch(() => null),
      api.getLanStatus().catch(() => null),
      api.getPluginsSnapshot().catch(() => null),
      api.getVoiceSettings().catch(() => null),
      api.getVoiceSecretStatus().catch(() => ({ "openai-compatible": { hasKey: false }, elevenlabs: { hasKey: false } })),
    ]);
    setSettings(nextSettings);
    setReactionSettings(nextReactions);
    setLaunchAtLogin(nextLaunch);
    setUpdateStatus(nextUpdate);
    setPlatformSettings(nextPlatform);
    setHostAiSettings(nextAiSettings);
    setLanStatus(nextLanStatus);
    setPluginsSnapshot(nextPluginsSnapshot);
    setVoiceSettings(nextVoiceSettings);
    setVoiceSecrets(nextVoiceSecrets);
    if (nextUpdate.state === "checking") {
      void api.checkForUpdates().then(setUpdateStatus).catch((err) => setError(String(err?.message ?? err)));
    }
  }

  useEffect(() => { void loadSettings().catch((err) => setError(String(err?.message ?? err))); }, []);

  useEffect(() => {
    settingsContentRef.current?.scrollTo({ top: 0 });
  }, [activeTab]);

  useEffect(() => api.onPluginsRefresh(() => {
    void api.getPluginsSnapshot().then(setPluginsSnapshot).catch((err) => setError(String(err?.message ?? err)));
  }), []);

  useEffect(() => {
    if (!message) return;
    const timeout = window.setTimeout(() => setMessage(""), 2200);
    return () => window.clearTimeout(timeout);
  }, [message]);

  async function run(label: string, fn: () => Promise<void>) {
    try { setBusy(label); setError(""); setMessage(""); await fn(); }
    catch (err) { setError(userFacingError(err)); }
    finally { setBusy(""); }
  }

  function patchPreferences(patch: Partial<SettingsState["preferences"]>, success: string) {
    void run(t("settings.busy.saving"), async () => {
      const next = await api.updatePreferences(patch);
      setSettings(next);
      if ("reactionAnimationOverrides" in patch) {
        setReactionSettings((current) => current ? { ...current, overrides: next.preferences.reactionAnimationOverrides ?? {} } : current);
      }
      setMessage(success);
    });
  }

  function setAnalyticsConsent(enabled: boolean) {
    void run(t("settings.busy.saving"), async () => {
      setSettings(await api.setDesktopAnalyticsConsent(enabled ? "granted" : "denied"));
      setMessage(t("settings.toast.analyticsSaved"));
    });
  }

  function changeLocale(value: string) {
    void run(t("settings.busy.saving"), async () => {
      await api.updatePreferences({ locale: value });
      reloadI18n();
      setMessage(t("settings.language.title"));
    });
  }

  function updateReactionOverride(reaction: ReactionAnimationSettings["reactions"][number], value: UserSelectableAnimationState) {
    const queuedSave = reactionSaveQueue.current.catch(() => undefined).then(() => run(t("settings.busy.saving"), async () => {
      const latestReactions = await api.getReactionAnimationSettings();
      const nextOverrides = { ...(latestReactions.overrides ?? {}) };
      if (value === reaction.defaultAnimation) delete nextOverrides[reaction.id];
      else nextOverrides[reaction.id] = value;
      const nextSettings = await api.updatePreferences({ reactionAnimationOverrides: nextOverrides });
      setSettings(nextSettings);
      setReactionSettings({ ...latestReactions, overrides: nextSettings.preferences.reactionAnimationOverrides ?? {} });
      setMessage(t("settings.toast.reactionSaved"));
    }));
    reactionSaveQueue.current = queuedSave;
    void queuedSave;
  }

  const overrides = settings?.preferences.reactionAnimationOverrides ?? {};

  function patchPlatformSettings(patch: Partial<PluginPlatformSettings>, success: string) {
    void run(t("settings.busy.saving"), async () => {
      setPlatformSettings(await api.updatePluginPlatformSettings(patch));
      setMessage(success);
    });
  }

  function updatePetPoolOrder(ids: string[]) {
    void run(t("settings.busy.saving"), async () => {
      const next = await api.setPetPoolOrder(ids);
      setSettings(next);
      setMessage("Saved");
    });
  }

  const isMoverActive = (pluginsSnapshot?.plugins ?? []).some(
    (p) => p.enabled && p.approvedPermissions.includes("pet:move")
  );

  return <div className="settings-layout">
    {error && <div className="error settings-message">{error}</div>}
    {message && <div className="settings-success settings-message">{message}</div>}

    <div className="settings-container">
      <aside className="settings-sidebar">
        <button className={`settings-nav-item ${activeTab === "general" ? "active" : ""}`} onClick={() => switchSettingsTab("general")}>
          <SettingsIcon />
          <span>{t("settings.nav.general")}</span>
        </button>
        <button className={`settings-nav-item ${activeTab === "reactions" ? "active" : ""}`} onClick={() => switchSettingsTab("reactions")}>
          <PetsIcon />
          <span>{t("settings.nav.reactions")}</span>
        </button>
        <button className={`settings-nav-item ${activeTab === "ai-brain" ? "active" : ""}`} onClick={() => switchSettingsTab("ai-brain")}>
          <SettingsIcon />
          <span>{t("settings.nav.aiBrain")}</span>
        </button>
        <button className={`settings-nav-item ${activeTab === "memory" ? "active" : ""}`} onClick={() => switchSettingsTab("memory")}>
          <PetsIcon />
          <span>{t("settings.nav.memory")}</span>
        </button>
        <button className={`settings-nav-item ${activeTab === "listen" ? "active" : ""}`} onClick={() => switchSettingsTab("listen")}>
          <VolumeIcon />
          <span>{t("settings.nav.listen")}</span>
        </button>
        <button className={`settings-nav-item ${activeTab === "speak" ? "active" : ""}`} onClick={() => switchSettingsTab("speak")}>
          <VolumeIcon />
          <span>{t("settings.nav.speak")}</span>
        </button>
        <button className={`settings-nav-item ${activeTab === "vision" ? "active" : ""}`} onClick={() => switchSettingsTab("vision")}>
          <IntegrationsIcon />
          <span>{t("settings.nav.vision")}</span>
        </button>
        <button className={`settings-nav-item ${activeTab === "plugins" ? "active" : ""}`} onClick={() => switchSettingsTab("plugins")}>
          <PluginsIcon />
          <span>{t("settings.nav.plugins")}</span>
        </button>
        <button className={`settings-nav-item ${activeTab === "lan" ? "active" : ""}`} onClick={() => switchSettingsTab("lan")}>
          <IntegrationsIcon />
          <span>{t("settings.nav.lan")}</span>
        </button>
      </aside>

      <main className="settings-content" ref={settingsContentRef}>
        {activeTab === "general" && (
          <>
            <div className="settings-section">
              <p className="eyebrow">{t("settings.general.eyebrow")}</p>
              <h2 className="settings-section-title">{t("settings.general.title")}</h2>

              <div className="settings-group">
                <ToggleRow
                  title={t("settings.general.showOnLaunch.title")}
                  description={t("settings.general.showOnLaunch.description")}
                  checked={settings?.preferences.openDefaultPetOnLaunch ?? false}
                  disabled={!settings || !!busy}
                  onChange={(checked) => patchPreferences({ openDefaultPetOnLaunch: checked }, t("settings.toast.startupSaved"))}
                />
                <ToggleRow
                  title={t("settings.general.launchAtLogin.title")}
                  description={launchAtLogin?.supported ? t("settings.general.launchAtLogin.supported") : t("settings.general.launchAtLogin.unsupported")}
                  checked={launchAtLogin?.enabled ?? false}
                  disabled={!launchAtLogin?.supported || !!busy}
                  onChange={(checked) => void run(t("settings.busy.saving"), async () => { setLaunchAtLogin(await api.setLaunchAtLogin(checked)); setMessage(t("settings.toast.loginStartupSaved")); })}
                />
                <ToggleRow
                  title={t("settings.general.readSpeechBubblesAloud.title")}
                  description={t("settings.general.readSpeechBubblesAloud.description")}
                  checked={settings?.preferences.readSpeechBubblesAloud ?? false}
                  disabled={!settings || !!busy}
                  onChange={(checked) => patchPreferences({ readSpeechBubblesAloud: checked }, t("settings.toast.readSpeechBubblesAloudSaved"))}
                />
                <ToggleRow
                  title={t("settings.general.analytics.title")}
                  description={t("settings.general.analytics.description")}
                  checked={settings?.analytics.enabled ?? false}
                  disabled={!settings || !!busy}
                  onChange={setAnalyticsConsent}
                />
                <div className="settings-row">
                  <div className="settings-row-info">
                    <strong>{t("settings.general.petScale.title")}</strong>
                    <small>{t("settings.general.petScale.description")}</small>
                  </div>
                  <select className="settings-select" value={settings?.preferences.petScale ?? ""} disabled={!settings || !!busy} onChange={(event) => patchPreferences({ petScale: Number(event.target.value) }, t("settings.toast.petScaleSaved"))}>
                    {(settings?.petScaleOptions ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </div>
                <div className="settings-row">
                  <div className="settings-row-info">
                    <strong>{t("settings.language.title")}</strong>
                    <small>{t("settings.language.description")}</small>
                  </div>
                  <select className="settings-select" value={localePreference} disabled={!!busy} onChange={(event) => changeLocale(event.target.value)}>
                    <option value="system">{t("settings.language.system")}</option>
                    {availableLocales.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </div>
              </div>

              <div className="settings-group">
                <ToggleRow
                  title={t("settings.petPool.label")}
                  description={t("settings.petPool.description")}
                  checked={settings?.preferences.petPoolEnabled ?? false}
                  disabled={!settings || !!busy}
                  onChange={(checked) => patchPreferences({ petPoolEnabled: checked }, t("settings.toast.petPoolSaved"))}
                />
                <div className={settings?.preferences.petPoolEnabled ? "" : "opacity-50 pointer-events-none"}>
                  <PetPoolOrderList
                    order={settings?.preferences.petPoolOrder ?? []}
                    candidates={settings?.petPoolCandidates ?? []}
                    disabled={!settings || !!busy || !(settings?.preferences.petPoolEnabled)}
                    onChangeOrder={updatePetPoolOrder}
                  />
                </div>
              </div>

              <div className="settings-actions">
                <Button variant="secondary" size="compact" disabled={!!busy} onClick={() => void run(t("settings.busy.resetting"), async () => { setSettings(await api.resetDefaultPetPosition()); setMessage(t("settings.toast.positionReset")); })}>{t("settings.general.resetPosition")}</Button>
              </div>

              <div className="settings-system-footer">
                <div className="settings-system-info">
                  <RefreshIcon />
                  <span>{t("settings.general.systemStatus")}</span>
                  <span className="settings-system-version">{updateStatus?.currentVersion}</span>
                  <span className="opacity-60">{formatUpdateStatus(updateStatus, t)}</span>
                </div>
                <div className="flex gap-2">
                  {updateStatus?.state === "available" && (
                    <Button variant="primary" size="compact" disabled={!!busy} onClick={() => void run(t("settings.busy.opening"), async () => { await api.openUpdateReleasePage(); })}>{t("settings.general.updateAvailable")}</Button>
                  )}
                  <Button variant="secondary" size="compact" disabled={!!busy || updateStatus?.state === "checking"} onClick={() => void run(t("settings.busy.checking"), async () => { setUpdateStatus(await api.checkForUpdates()); })}>
                    {busy === t("settings.busy.checking") ? t("settings.general.checking") : t("settings.general.checkForUpdates")}
                  </Button>
                </div>
              </div>
            </div>

            <div className="settings-section">
              <h2 className="settings-section-title">{t("settings.movement.title")}</h2>

              <div className="settings-group">
                <ToggleRow
                  title={t("settings.petConfinement.label")}
                  description={t("settings.petConfinement.description")}
                  checked={settings?.preferences.petConfinementEnabled ?? false}
                  disabled={!settings || !!busy}
                  testId="setting-pet-confinement-toggle"
                  onChange={(checked) => patchPreferences({ petConfinementEnabled: checked }, t("settings.toast.confinementSaved"))}
                />
                <ToggleRow
                  title={t("settings.petCrossDisplay.label")}
                  description={isMoverActive ? t("settings.petCrossDisplay.description") : t("settings.petCrossDisplay.helperNoMover")}
                  checked={settings?.preferences.petCrossDisplayEnabled ?? false}
                  disabled={!settings || !!busy || !isMoverActive}
                  testId="setting-pet-cross-display-toggle"
                  onChange={(checked) => patchPreferences({ petCrossDisplayEnabled: checked }, t("settings.toast.crossDisplaySaved"))}
                />
                <ToggleRow
                  title={t("settings.petGravity.label")}
                  description={t("settings.petGravity.description")}
                  checked={settings?.preferences.petGravityEnabled ?? false}
                  disabled={!settings || !!busy}
                  testId="setting-pet-gravity-toggle"
                  onChange={(checked) => patchPreferences({ petGravityEnabled: checked }, t("settings.toast.gravitySaved"))}
                />
              </div>
            </div>
          </>
        )}

        {activeTab === "reactions" && (
          <div className="settings-section">
            <div className="flex items-center justify-between">
              <div>
                <p className="eyebrow">{t("settings.reactions.eyebrow")}</p>
                <h2 className="settings-section-title">{t("settings.reactions.title")}</h2>
              </div>
              <Button variant="secondary" size="compact" disabled={!settings || !!busy || !Object.keys(overrides).length} onClick={() => patchPreferences({ reactionAnimationOverrides: {} }, t("settings.toast.reactionsReset"))}>{t("settings.reactions.resetDefaults")}</Button>
            </div>
            <p className="text-sm text-slatecopy -mt-2 mb-2">{t("settings.reactions.description")}</p>

            <div className="settings-group">
              <div className="reaction-grid">
                {(reactionSettings?.reactions ?? []).map((reaction) => {
                  const currentAnimation = overrides[reaction.id] ?? reaction.defaultAnimation;
                  return (
                    <div className="reaction-row" key={reaction.id}>
                      <div className="reaction-preview-box">
                        {reactionSettings?.previewSpriteUrl && (
                          <ReactionPreviewSprite settings={reactionSettings} state={currentAnimation} />
                        )}
                      </div>
                      <div className="reaction-info">
                        <strong>{reaction.label}</strong>
                        <small>{reaction.description}</small>
                      </div>
                      <select
                        className="settings-select"
                        value={currentAnimation}
                        disabled={!reactionSettings || !settings || !!busy}
                        onChange={(event) => {
                          const value = event.target.value as UserSelectableAnimationState;
                          updateReactionOverride(reaction, value);
                        }}
                      >
                        {(reactionSettings?.animations ?? []).map((animation) => (
                          <option key={animation.id} value={animation.id}>{animation.label}</option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}


        {activeTab === "lan" && (
          <LanSettingsPanel status={lanStatus} onRefresh={() => void run(t("settings.busy.checking"), async () => { setLanStatus(await api.getLanStatus()); })} busy={!!busy} />
        )}

        {(activeTab === "listen" || activeTab === "speak" || activeTab === "vision") && (
          <AbilitiesSettingsPanel
            section={activeTab}
            settings={voiceSettings}
            secrets={voiceSecrets}
            busy={!!busy}
            onSettings={setVoiceSettings}
            onSecrets={setVoiceSecrets}
            run={run}
            setMessage={setMessage}
          />
        )}

        {activeTab === "ai-brain" && (
          <AiBrainSettingsPanel
            settings={hostAiSettings}
            busy={!!busy}
            onSettings={setHostAiSettings}
            onNavigate={onNavigate}
            onOpenVision={() => switchSettingsTab("vision")}
            run={run}
            setMessage={setMessage}
          />
        )}

        {activeTab === "memory" && <MemorySettingsPanel busy={!!busy} run={run} setMessage={setMessage} onDirtyChange={setMemoryDirty} />}

        {activeTab === "plugins" && (
          <div className="settings-section">
            <p className="eyebrow">{t("settings.plugins.eyebrow")}</p>
            <h2 className="settings-section-title">{t("settings.plugins.title")}</h2>
            <p className="text-sm text-slatecopy -mt-2 mb-2">{t("settings.plugins.description")}</p>

            <div className="settings-group">
              <ToggleRow
                title={t("settings.plugins.audio.title")}
                description={t("settings.plugins.audio.description")}
                checked={platformSettings?.allowPluginAudio ?? true}
                disabled={!platformSettings || !!busy}
                onChange={(checked) => patchPlatformSettings({ allowPluginAudio: checked }, t("settings.toast.audioSaved"))}
              />
              <ToggleRow
                title={t("settings.plugins.voice.title")}
                description={t("settings.plugins.voice.description")}
                checked={platformSettings?.allowPluginVoice ?? true}
                disabled={!platformSettings || !!busy}
                onChange={(checked) => patchPlatformSettings({ allowPluginVoice: checked }, t("settings.toast.voiceSaved"))}
              />
              <ToggleRow
                title={t("settings.plugins.dynamicSpeech.title")}
                description={t("settings.plugins.dynamicSpeech.description")}
                checked={platformSettings?.allowDynamicSpeech ?? false}
                disabled={!platformSettings || !!busy}
                onChange={(checked) => patchPlatformSettings({ allowDynamicSpeech: checked }, t("settings.toast.dynamicSpeechSaved"))}
              />
              <ToggleRow
                title={t("settings.plugins.microphone.title")}
                description={t("settings.plugins.microphone.description")}
                checked={platformSettings?.allowMicrophone ?? false}
                disabled={!platformSettings || !!busy}
                onChange={(checked) => patchPlatformSettings({ allowMicrophone: checked }, t("settings.toast.microphoneSaved"))}
              />
            </div>

            <div className="settings-group">
              <ToggleRow
                title={t("settings.plugins.quietHours.title")}
                description={t("settings.plugins.quietHours.description")}
                checked={platformSettings?.quietHours.enabled ?? false}
                disabled={!platformSettings || !!busy}
                onChange={(checked) => patchPlatformSettings({ quietHours: { ...(platformSettings?.quietHours ?? { start: "22:00", end: "08:00" }), enabled: checked } }, t("settings.toast.quietHoursSaved"))}
              />
              <div className="settings-row">
                <div className="settings-row-info">
                  <strong>{t("settings.plugins.quietWindow.title")}</strong>
                  <small>{t("settings.plugins.quietWindow.description")}</small>
                </div>
                <div className="flex gap-2 items-center">
                  <input type="time" className="settings-select" value={platformSettings?.quietHours.start ?? "22:00"} disabled={!platformSettings || !!busy} onChange={(event) => patchPlatformSettings({ quietHours: { ...(platformSettings?.quietHours ?? { enabled: false, end: "08:00" }), start: event.target.value } as PluginPlatformSettings["quietHours"] }, t("settings.toast.quietHoursSaved"))} />
                  <span className="opacity-60">{t("common.to")}</span>
                  <input type="time" className="settings-select" value={platformSettings?.quietHours.end ?? "08:00"} disabled={!platformSettings || !!busy} onChange={(event) => patchPlatformSettings({ quietHours: { ...(platformSettings?.quietHours ?? { enabled: false, start: "22:00" }), end: event.target.value } as PluginPlatformSettings["quietHours"] }, t("settings.toast.quietHoursSaved"))} />
                </div>
              </div>
            </div>

          </div>
        )}
      </main>
    </div>
  </div>;
}

function AiBrainSettingsPanel({ settings, busy, onSettings, onNavigate, onOpenVision, run, setMessage }: {
  settings: HostAiSettingsSnapshot | null;
  busy: boolean;
  onSettings: (settings: HostAiSettingsSnapshot) => void;
  onNavigate: (route: Route) => void;
  onOpenVision: () => void;
  run: (label: string, fn: () => Promise<void>) => Promise<void>;
  setMessage: (message: string) => void;
}) {
  const { t } = useI18n();
  const [companion, setCompanion] = useState<CompanionSettings | null>(null);
  const [codexHealth, setCodexHealth] = useState<CompanionTargetHealth | null>(null);
  const [codexModels, setCodexModels] = useState<CodexModelDiscoverySnapshot | null>(null);
  const [health, setHealth] = useState<Partial<Record<HostAiProfileId, HostAiHealthSnapshot>>>({});
  const [imageHealth, setImageHealth] = useState<Partial<Record<HostAiProfileId | "codex", AiImageHealthSnapshot>>>({});
  const [secrets, setSecrets] = useState<HostAiSecretStatus>({ anthropic: { hasKey: false }, openai: { hasKey: false }, openrouter: { hasKey: false }, ollama: { hasKey: false }, custom: { hasKey: false } });
  const [keyDrafts, setKeyDrafts] = useState<Partial<Record<HostAiProfileId, string>>>({});
  const [modelCatalogs, setModelCatalogs] = useState<Partial<Record<HostAiProfileId, HostAiModelCatalog>>>({});

  const refresh = async (force = false) => {
    const [nextCompanion, nextModels, nextSecrets, nextSettings] = await Promise.all([
      api.getCompanionSettings(),
      api.getCodexModels(force).catch((error: unknown): CodexModelDiscoverySnapshot => ({ checkedAt: Date.now(), status: "error", models: [], reason: userFacingError(error) })),
      api.getHostAiApiKeyStatus(),
      api.getHostAiSettings(),
    ]);
    setCompanion(nextCompanion);
    setCodexModels(nextModels);
    setSecrets(nextSecrets);
    onSettings(nextSettings);
    setCodexHealth(await api.getCompanionTargetHealth("codex", force).catch(() => null));
    const defaultCodex = nextModels.models.find((model) => model.isDefault)
      ?? nextModels.models.find((model) => model.id === nextModels.defaultModelId)
      ?? nextModels.models[0];
    const selectedCodex = nextCompanion.codex.model
      ? nextModels.models.find((model) => model.id === nextCompanion.codex.model || model.model === nextCompanion.codex.model)
      : defaultCodex;
    if (nextCompanion.target === "codex") {
      const nextImageHealth = await api.checkVisionImageHealth({ kind: "codex", model: selectedCodex?.model, force }).catch(() => null);
      if (nextImageHealth) setImageHealth((current) => ({ ...current, codex: nextImageHealth }));
    }
    if (nextCompanion.target === "host-ai" && nextSettings.provider !== "none") {
      const activeHealth = await api.getHostAiHealth(nextSettings.provider, force).catch(() => null);
      if (activeHealth) setHealth((current) => ({ ...current, [nextSettings.provider]: activeHealth }));
      const activeImageHealth = await api.checkVisionImageHealth({ kind: "host-ai", provider: nextSettings.provider, model: nextSettings.providers[nextSettings.provider].model, force }).catch(() => null);
      if (activeImageHealth) setImageHealth((current) => ({ ...current, [nextSettings.provider]: activeImageHealth }));
    }
  };

  useEffect(() => { void refresh(false); }, []);

  const selectCodex = () => void run(t("settings.busy.saving"), async () => {
    const next = await api.updateCompanionSettings({ target: "codex" });
    setCompanion(next);
    setCodexHealth(await api.getCompanionTargetHealth("codex", true).catch(() => null));
    setMessage(t("settings.aiBrain.selected", { provider: t("settings.aiBrain.codex") }));
  });

  const selectProvider = (provider: HostAiProfileId) => void run(t("settings.busy.saving"), async () => {
    onSettings(await api.selectHostAiProvider(provider));
    setCompanion(await api.updateCompanionSettings({ target: "host-ai" }));
    setMessage(t("settings.aiBrain.selected", { provider: t(`settings.aiBrain.provider.${provider}`) }));
  });

  const saveProvider = (provider: HostAiProfileId, patch: Partial<HostAiProviderConfig>) => void run(t("settings.busy.saving"), async () => {
    onSettings(await api.updateHostAiProvider(provider, patch));
    setHealth((current) => ({ ...current, [provider]: undefined }));
    setImageHealth((current) => ({ ...current, [provider]: undefined }));
    setMessage(t("settings.aiBrain.providerSaved", { provider: t(`settings.aiBrain.provider.${provider}`) }));
  });

  const setProviderKey = (provider: HostAiProfileId, key: string | null) => void run(t("settings.busy.saving"), async () => {
    const next = await api.setHostAiApiKey(provider, key);
    setSecrets((current) => ({ ...current, [provider]: { hasKey: next.hasKey } }));
    setKeyDrafts((current) => ({ ...current, [provider]: "" }));
    setHealth((current) => ({ ...current, [provider]: undefined }));
    setImageHealth((current) => ({ ...current, [provider]: undefined }));
    setMessage(key ? t("settings.toast.aiKeySaved") : t("settings.toast.aiKeyRemoved"));
  });

  const checkProvider = (provider: HostAiProfileId) => void run(t("settings.busy.checking"), async () => {
    const next = await api.getHostAiHealth(provider, true);
    setHealth((current) => ({ ...current, [provider]: next }));
    const nextImage = await api.checkVisionImageHealth({ kind: "host-ai", provider, model: settings?.providers[provider].model, force: true }).catch((error: unknown): AiImageHealthSnapshot => ({
      status: "error",
      configured: next.configured,
      ready: false,
      provider,
      model: settings?.providers[provider].model ?? "",
      stale: false,
      error: userFacingError(error),
    }));
    setImageHealth((current) => ({ ...current, [provider]: nextImage }));
  });

  const loadProviderModels = (provider: HostAiProfileId) => void run(t("settings.aiBrain.loadingModels"), async () => {
    const catalog = await api.getHostAiModels(provider);
    setModelCatalogs((current) => ({ ...current, [provider]: catalog }));
    setMessage(t("settings.aiBrain.modelsLoaded", { count: catalog.models.length }));
  });

  const defaultCodexModel = codexModels?.models.find((model) => model.isDefault)
    ?? codexModels?.models.find((model) => model.id === codexModels.defaultModelId)
    ?? codexModels?.models[0];
  const selectedCodexModel = companion?.codex.model
    ? codexModels?.models.find((model) => model.id === companion.codex.model || model.model === companion.codex.model)
    : defaultCodexModel;
  const codexModelOptions = [
    { value: "", label: defaultCodexModel ? `Use Codex default (${defaultCodexModel.displayName})` : "Use Codex default" },
    ...(codexModels?.models ?? []).map((model) => ({ value: model.model, label: `${model.displayName}${model.inputModalities.includes("image") ? " · Vision" : " · Text only"}` })),
  ];
  const reasoningOptions = [
    { value: "", label: selectedCodexModel?.defaultReasoningEffort ? `Use model default (${selectedCodexModel.defaultReasoningEffort})` : "Use model default" },
    ...(selectedCodexModel?.supportedReasoningEfforts ?? []).map((effort) => ({ value: effort.value, label: effort.value.charAt(0).toUpperCase() + effort.value.slice(1) })),
  ];
  const saveCodex = (codex: { model?: string; reasoningEffort?: string }) => void run(t("settings.busy.saving"), async () => {
    setCompanion(await api.updateCompanionSettings({ codex }));
    setCodexHealth(null);
    setImageHealth((current) => ({ ...current, codex: undefined }));
    setMessage(t("settings.aiBrain.saved"));
  });

  const providerIds: HostAiProfileId[] = ["anthropic", "openai", "openrouter", "ollama", "custom"];
  const activeBrain = companion?.target === "codex" ? "codex" : settings?.provider ?? "none";
  const activeHostHealth = activeBrain !== "codex" && activeBrain !== "none" ? health[activeBrain] : null;
  const activeImageHealth = activeBrain === "none" ? null : imageHealth[activeBrain];
  return <div className="settings-section">
    <p className="eyebrow">{t("settings.aiBrain.eyebrow")}</p>
    <h2 className="settings-section-title">{t("settings.aiBrain.title")}</h2>
    <p className="text-sm text-slatecopy -mt-2 mb-2">{t("settings.aiBrain.cardsDescription")}</p>

    <div className="settings-group ai-brain-selector-card">
      <VoiceSelectRow
        title={t("settings.aiBrain.activeSelector")}
        description={t("settings.aiBrain.activeSelectorDescription")}
        value={activeBrain}
        disabled={busy || !companion || !settings}
        onChange={(value) => value === "codex" ? selectCodex() : selectProvider(value as HostAiProfileId)}
        options={[
          { value: "none", label: t("settings.aiBrain.chooseProvider"), disabled: true },
          { value: "codex", label: t("settings.aiBrain.codex") },
          ...providerIds.map((provider) => ({ value: provider, label: t(`settings.aiBrain.provider.${provider}`) })),
        ]}
      />
      <div className="settings-row"><div className="settings-row-info"><strong>{t("settings.aiBrain.status")}</strong><small>{activeBrain === "none" ? t("settings.aiBrain.chooseProvider") : activeBrain === "codex" ? codexHealth?.reason ?? (codexHealth?.ready ? t("settings.aiBrain.brainReadyDescription") : t("settings.aiBrain.notChecked")) : activeHostHealth?.error ?? (activeHostHealth?.ready ? t("settings.aiBrain.brainReadyDescription") : t("settings.aiBrain.checkCardBelow"))}</small></div><span className={(activeBrain === "codex" ? codexHealth?.ready : activeHostHealth?.ready) ? "pill pill-green" : "pill pill-orange"}>{(activeBrain === "codex" ? codexHealth?.ready : activeHostHealth?.ready) ? t("settings.aiBrain.ready") : t("settings.aiBrain.needsAttention")}</span></div>
      <div className="settings-row"><div className="settings-row-info"><strong>{t("settings.aiBrain.visionSupport")}</strong><small>{activeImageHealth?.error ?? (activeImageHealth?.ready ? t("settings.aiBrain.visionSupportedDescription") : t("settings.aiBrain.visionDoesNotBlock"))}</small></div><div className="flex gap-2 items-center"><span className={activeImageHealth?.ready ? "pill pill-green" : activeImageHealth?.status === "unsupported" ? "pill pill-slate" : "pill pill-orange"}>{activeImageHealth?.ready ? t("settings.aiBrain.visionSupported") : activeImageHealth?.status === "unsupported" ? t("settings.aiBrain.visionNotSupported") : t("settings.aiBrain.visionNeedsAttention")}</span><Button variant="secondary" size="compact" disabled={busy} onClick={onOpenVision}>{t("settings.aiBrain.openPetVision")}</Button></div></div>
    </div>

    <div className={`settings-group ai-provider-card ${companion?.target === "codex" ? "ai-provider-card-active" : ""}`}>
      <div className="settings-row ai-provider-card-header">
        <div className="settings-row-info"><strong>{t("settings.aiBrain.codex")}</strong><small>{t("settings.aiBrain.codexCardDescription")}</small></div>
        <span className={companion?.target === "codex" ? "pill pill-green" : "pill pill-slate"}>{companion?.target === "codex" ? t("settings.aiBrain.active") : t("settings.aiBrain.configuredHere")}</span>
      </div>
      <VoiceSelectRow title={t("settings.aiBrain.codexModel")} description={selectedCodexModel?.description || t("settings.aiBrain.codexModelDescription")} value={companion?.codex.model ? selectedCodexModel?.model ?? companion.codex.model : ""} disabled={busy || codexModels?.status !== "ready" || !companion} onChange={(value) => saveCodex({ model: value, reasoningEffort: "" })} options={codexModelOptions} />
      <VoiceSelectRow title={t("settings.aiBrain.reasoningEffort")} description={t("settings.aiBrain.reasoningEffortDescription")} value={companion?.codex.reasoningEffort ?? ""} disabled={busy || codexModels?.status !== "ready" || !selectedCodexModel || !companion} onChange={(value) => saveCodex({ reasoningEffort: value })} options={reasoningOptions} />
      <div className="settings-row"><div className="settings-row-info"><strong>{t("settings.aiBrain.providerHealth")}</strong><small>{codexHealth?.reason ?? (codexHealth?.ready ? t("settings.aiBrain.brainReadyDescription") : codexModels?.reason ?? t("settings.aiBrain.notChecked"))}</small></div><div className="flex gap-2 items-center"><span className={codexHealth?.ready ? "pill pill-green" : "pill pill-slate"}>{codexHealth?.ready ? t("settings.aiBrain.ready") : t("settings.aiBrain.notChecked")}</span>{!codexHealth?.ready && <Button variant="primary" size="compact" disabled={busy} onClick={() => onNavigate("integrations")}>{t("settings.aiBrain.configureCodex")}</Button>}<Button variant="secondary" size="compact" disabled={busy} onClick={() => void run(t("settings.busy.checking"), async () => { const models = await api.getCodexModels(true); setCodexModels(models); setCodexHealth(await api.getCompanionTargetHealth("codex", true)); const selected = companion?.codex.model ? models.models.find((model) => model.id === companion.codex.model || model.model === companion.codex.model) : models.models.find((model) => model.isDefault) ?? models.models[0]; const nextImageHealth = await api.checkVisionImageHealth({ kind: "codex", model: selected?.model, force: true }); setImageHealth((current) => ({ ...current, codex: nextImageHealth })); })}>{t("settings.voice.check")}</Button></div></div>
      <div className="settings-row"><div className="settings-row-info"><strong>{t("settings.aiBrain.visionSupport")}</strong><small>{imageHealth.codex?.error ?? t("settings.aiBrain.visionDoesNotBlock")}</small></div><span className={imageHealth.codex?.ready ? "pill pill-green" : imageHealth.codex?.status === "unsupported" ? "pill pill-slate" : "pill pill-orange"}>{imageHealth.codex?.ready ? t("settings.aiBrain.visionSupported") : imageHealth.codex?.status === "unsupported" ? t("settings.aiBrain.visionNotSupported") : t("settings.aiBrain.visionNeedsAttention")}</span></div>
    </div>

    {providerIds.map((provider) => {
      const config = settings?.providers[provider];
      const providerHealth = health[provider];
      const active = companion?.target === "host-ai" && settings?.provider === provider;
      const hasKey = secrets[provider].hasKey;
      const supportsKey = provider !== "ollama";
      const modelCatalog = modelCatalogs[provider];
      const catalogOptions = modelCatalog
        ? [
            ...(config?.model && !modelCatalog.models.some((model) => model.id === config.model) ? [{ value: config.model, label: config.model }] : []),
            ...modelCatalog.models.map((model) => ({ value: model.id, label: model.name === model.id ? model.id : `${model.name} · ${model.id}` })),
          ]
        : [];
      return <div className={`settings-group ai-provider-card ${active ? "ai-provider-card-active" : ""}`} key={provider}>
        <div className="settings-row ai-provider-card-header">
          <div className="settings-row-info"><strong>{t(`settings.aiBrain.provider.${provider}`)}</strong><small>{t(`settings.aiBrain.provider.${provider}.description`)}</small></div>
          <span className={active ? "pill pill-green" : "pill pill-slate"}>{active ? t("settings.aiBrain.active") : t("settings.aiBrain.configuredHere")}</span>
        </div>
        {config && <>
          {modelCatalog
            ? <><VoiceSelectRow title={t("settings.aiBrain.modelCatalog")} description={provider === "openrouter" ? t("settings.aiBrain.openrouterModelDescription") : t("settings.aiBrain.modelCatalogReady", { count: modelCatalog.models.length })} value={config.model} options={catalogOptions} disabled={busy} onChange={(value) => saveProvider(provider, { model: value })} /><VoiceTextRow title={t("settings.aiBrain.manualModel")} description={t("settings.aiBrain.manualModelDescription")} value={config.model} disabled={busy} onSave={(value) => saveProvider(provider, { model: value })} /></>
            : <VoiceTextRow title={t("settings.plugins.model.title")} description={provider === "openrouter" ? t("settings.aiBrain.openrouterModelDescription") : t("settings.plugins.model.description")} value={config.model} placeholder={provider === "openrouter" ? "openrouter/free" : t("settings.plugins.model.placeholder")} disabled={busy} onSave={(value) => saveProvider(provider, { model: value })} />}
          <div className="settings-row"><div className="settings-row-info"><strong>{t("settings.aiBrain.modelCatalog")}</strong><small>{modelCatalog ? t("settings.aiBrain.modelCatalogReady", { count: modelCatalog.models.length }) : t("settings.aiBrain.modelCatalogDescription")}</small></div><Button variant="secondary" size="compact" disabled={busy || (config.requiresApiKey && !hasKey)} onClick={() => loadProviderModels(provider)}>{modelCatalog ? t("settings.aiBrain.refreshModels") : t("settings.aiBrain.loadModels")}</Button></div>
          {(provider === "ollama" || provider === "custom") && <VoiceTextRow title={t("settings.aiBrain.baseUrl")} description={t(`settings.aiBrain.provider.${provider}.urlDescription`)} type="url" value={config.baseUrl} disabled={busy} onSave={(value) => saveProvider(provider, { baseUrl: value })} />}
          {provider === "openrouter" && <div className="settings-row"><div className="settings-row-info"><strong>{t("settings.aiBrain.endpoint")}</strong><small>https://openrouter.ai/api/v1</small></div><span className="pill pill-slate">{t("settings.aiBrain.managed")}</span></div>}
          {provider === "custom" && <ToggleRow title={t("settings.aiBrain.customRequiresKey")} description={t("settings.aiBrain.customRequiresKeyDescription")} checked={config.requiresApiKey} disabled={busy} onChange={(checked) => saveProvider(provider, { requiresApiKey: checked })} />}
          {supportsKey && <div className="settings-row"><div className="settings-row-info"><strong>{t("settings.plugins.apiKey.title")}</strong><small>{hasKey ? t("settings.plugins.apiKey.stored") : config.requiresApiKey ? t("settings.plugins.apiKey.none") : t("settings.aiBrain.keyOptional")}</small></div><div className="flex gap-2 items-center"><input type="password" className="settings-select" autoComplete="off" placeholder={hasKey ? t("settings.plugins.apiKey.placeholderStored") : t("settings.plugins.apiKey.placeholderEmpty")} value={keyDrafts[provider] ?? ""} disabled={busy} onChange={(event) => setKeyDrafts((current) => ({ ...current, [provider]: event.target.value }))} /><Button variant="secondary" size="compact" disabled={busy || !(keyDrafts[provider] ?? "").trim()} onClick={() => setProviderKey(provider, keyDrafts[provider] ?? "")}>{hasKey ? t("settings.aiBrain.replaceKey") : t("settings.plugins.apiKey.save")}</Button>{hasKey && <Button variant="secondary" size="compact" disabled={busy} onClick={() => setProviderKey(provider, null)}>{t("settings.plugins.apiKey.remove")}</Button>}</div></div>}
          <div className="settings-row"><div className="settings-row-info"><strong>{t("settings.aiBrain.providerHealth")}</strong><small>{providerHealth?.error ?? (providerHealth?.ready ? `${providerHealth.model} · ${providerHealth.baseUrl ?? config.baseUrl}` : t("settings.aiBrain.notChecked"))}</small></div><div className="flex gap-2 items-center"><span className={providerHealth?.ready ? "pill pill-green" : providerHealth?.status === "error" ? "pill pill-orange" : "pill pill-slate"}>{providerHealth?.ready ? t("settings.aiBrain.ready") : providerHealth?.status ?? t("settings.aiBrain.notChecked")}</span><Button variant="secondary" size="compact" disabled={busy} onClick={() => checkProvider(provider)}>{t("settings.voice.check")}</Button></div></div>
          <div className="settings-row"><div className="settings-row-info"><strong>{t("settings.aiBrain.visionSupport")}</strong><small>{imageHealth[provider]?.error ?? t("settings.aiBrain.visionDoesNotBlock")}</small></div><span className={imageHealth[provider]?.ready ? "pill pill-green" : imageHealth[provider]?.status === "unsupported" ? "pill pill-slate" : "pill pill-orange"}>{imageHealth[provider]?.ready ? t("settings.aiBrain.visionSupported") : imageHealth[provider]?.status === "unsupported" ? t("settings.aiBrain.visionNotSupported") : t("settings.aiBrain.visionNeedsAttention")}</span></div>
        </>}
      </div>;
    })}
  </div>;
}

function AbilitiesSettingsPanel({ section, settings, secrets, busy, onSettings, onSecrets, run, setMessage }: {
  section: "listen" | "speak" | "vision";
  settings: VoiceSettingsSnapshot | null;
  secrets: VoiceSecretStatus;
  busy: boolean;
  onSettings: (settings: VoiceSettingsSnapshot) => void;
  onSecrets: (status: VoiceSecretStatus) => void;
  run: (label: string, fn: () => Promise<void>) => Promise<void>;
  setMessage: (message: string) => void;
}) {
  const { t } = useI18n();
  const providerIds: VoiceProviderId[] = ["system", "pockettts", "openai-compatible", "elevenlabs"];
  const [health, setHealth] = useState<Partial<Record<VoiceProviderId, VoiceCapabilityEvidence>>>({});
  const [voices, setVoices] = useState<Partial<Record<VoiceProviderId, VoiceInfo[]>>>({});
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [testText, setTestText] = useState(t("settings.voice.test.defaultText"));
  const [wakeHealth, setWakeHealth] = useState<VoiceWakeHealth | null>(null);
  const [wakeSnapshot, setWakeSnapshot] = useState<VoiceWakeSnapshot | null>(null);
  const [wakeCalibration, setWakeCalibration] = useState<VoiceWakeCalibrationSnapshot | null>(null);
  const [companionSettings, setCompanionSettings] = useState<CompanionSettings | null>(null);
  const [vision, setVision] = useState<VisionSnapshot | null>(null);
  const [visionBrainSettings, setVisionBrainSettings] = useState<HostAiSettingsSnapshot | null>(null);
  const [visionCodexModels, setVisionCodexModels] = useState<CodexModelDiscoverySnapshot | null>(null);
  const [visionHostModels, setVisionHostModels] = useState<HostAiModelCatalog | null>(null);
  const [pocketTts, setPocketTts] = useState<PocketTtsSnapshot | null>(null);
  const [transcriptionSettings, setTranscriptionSettings] = useState<VoiceTranscriptionSettings | null>(null);
  const [transcriptionHealth, setTranscriptionHealth] = useState<VoiceTranscriptionHealth | null>(null);
  const [localTranscription, setLocalTranscription] = useState<LocalTranscriptionSnapshot | null>(null);
  const [transcriptionKeyDraft, setTranscriptionKeyDraft] = useState("");
  const [permissions, setPermissions] = useState<DesktopPermissionSnapshot | null>(null);
  const [permissionRestartSuggested, setPermissionRestartSuggested] = useState<Record<DesktopPermissionKind, boolean>>({ microphone: false, "screen-recording": false });
  const [refreshDegraded, setRefreshDegraded] = useState(false);
  const [microphoneDevices, setMicrophoneDevices] = useState<VoiceMicrophoneDevice[]>([]);

  const refreshMicrophones = async () => {
    if (section !== "listen" || !navigator.mediaDevices?.enumerateDevices) return;
    const inputs = (await navigator.mediaDevices.enumerateDevices())
      .filter((device) => device.kind === "audioinput" && device.deviceId && device.deviceId !== "default")
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || t("settings.abilities.listen.microphoneNumber", { number: index + 1 }),
        ...(device.label ? { stableLabel: device.label } : {}),
      }));
    setMicrophoneDevices(inputs.filter((device, index) => inputs.findIndex((candidate) => candidate.deviceId === device.deviceId) === index));
  };

  const refreshAbilities = async (forceVision = false) => {
    const [healthResult, wakeResult, calibrationResult, companionResult, visionResult, pocketResult, transcriptionSettingsResult, transcriptionHealthResult, localTranscriptionResult, permissionsResult] = await Promise.allSettled([
      api.getVoiceWakeHealth(),
      api.getVoiceWakeSnapshot(),
      api.getVoiceWakeCalibrationSnapshot(),
      api.getCompanionSettings(),
      api.getVisionSnapshot(forceVision),
      api.getPocketTtsSnapshot(),
      api.getVoiceTranscriptionSettings(),
      api.getVoiceTranscriptionHealth(),
      api.getLocalTranscriptionSnapshot(),
      api.getDesktopPermissions(),
    ] as const);
    if (healthResult.status === "fulfilled") setWakeHealth(healthResult.value);
    if (wakeResult.status === "fulfilled") setWakeSnapshot(wakeResult.value);
    if (calibrationResult.status === "fulfilled") setWakeCalibration(calibrationResult.value);
    if (companionResult.status === "fulfilled") setCompanionSettings(companionResult.value);
    if (visionResult.status === "fulfilled") setVision(visionResult.value);
    if (pocketResult.status === "fulfilled") setPocketTts(pocketResult.value);
    if (transcriptionSettingsResult.status === "fulfilled") setTranscriptionSettings(transcriptionSettingsResult.value);
    if (transcriptionHealthResult.status === "fulfilled") setTranscriptionHealth(transcriptionHealthResult.value);
    if (localTranscriptionResult.status === "fulfilled") setLocalTranscription(localTranscriptionResult.value);
    if (transcriptionSettingsResult.status === "fulfilled" && transcriptionSettingsResult.value.providerId === "local" && transcriptionHealthResult.status === "fulfilled") {
      await api.getLocalTranscriptionSnapshot().then(setLocalTranscription).catch(() => undefined);
    }
    if (permissionsResult.status === "fulfilled") setPermissions(permissionsResult.value);
    if (section === "vision") {
      const [brainSettings, models] = await Promise.all([
        api.getHostAiSettings().catch(() => null),
        api.getCodexModels(false).catch(() => null),
      ]);
      setVisionBrainSettings(brainSettings);
      setVisionCodexModels(models);
      if (companionResult.status === "fulfilled" && companionResult.value.target === "host-ai" && brainSettings && brainSettings.provider !== "none") {
        setVisionHostModels(await api.getHostAiModels(brainSettings.provider).catch(() => null));
      } else {
        setVisionHostModels(null);
      }
    }
    if (section === "listen") await refreshMicrophones().catch(() => undefined);
    const relevantResults = section === "listen"
      ? [healthResult, wakeResult, calibrationResult, companionResult, transcriptionSettingsResult, transcriptionHealthResult, localTranscriptionResult, permissionsResult]
      : section === "speak"
        ? [pocketResult]
        : [visionResult, permissionsResult];
    setRefreshDegraded(relevantResults.some((result) => result.status === "rejected"));
  };

  useEffect(() => {
    void refreshAbilities().catch(() => undefined);
    const refreshAfterSystemSettings = () => {
      void refreshAbilities().catch(() => undefined);
    };
    window.addEventListener("focus", refreshAfterSystemSettings);
    const timer = window.setInterval(() => {
      if (section === "listen") {
        void api.getVoiceWakeSnapshot().then(setWakeSnapshot).catch(() => undefined);
        void api.getVoiceWakeCalibrationSnapshot().then(setWakeCalibration).catch(() => undefined);
        if (localTranscription?.status === "downloading") void api.getLocalTranscriptionSnapshot().then(setLocalTranscription).catch(() => undefined);
      }
      if (section === "speak") void api.getPocketTtsSnapshot().then(setPocketTts).catch(() => undefined);
      if (section === "vision") void api.getVisionSnapshot(false).then(setVision).catch(() => undefined);
    }, section === "vision" ? 15_000 : 1_000);
    return () => {
      window.removeEventListener("focus", refreshAfterSystemSettings);
      window.clearInterval(timer);
    };
  }, [section, localTranscription?.status]);

  const save = (patch: Record<string, unknown>, refreshWakeAfterSave = false) => void run(t("settings.busy.saving"), async () => {
    onSettings(await api.updateVoiceSettings(patch));
    if (refreshWakeAfterSave) await refreshAbilities();
    setMessage(t("settings.voice.saved"));
  });
  const setWakeEnabled = (enabled: boolean) => void run(t("settings.busy.saving"), async () => {
    const next = await api.updateCompanionSettings({ wake: { enabled } });
    setCompanionSettings(next);
    await refreshAbilities();
    setMessage(enabled ? t("settings.abilities.listen.enabledSaved") : t("settings.abilities.listen.disabledSaved"));
  });
  const setFollowUpEnabled = (followUpEnabled: boolean) => void run(t("settings.busy.saving"), async () => {
    const next = await api.updateCompanionSettings({ wake: { followUpEnabled } });
    setCompanionSettings(next);
    setMessage(t("settings.voice.saved"));
  });
  const saveTranscription = (patch: Partial<VoiceTranscriptionSettings>) => void run(t("settings.busy.saving"), async () => {
    setTranscriptionSettings(await api.updateVoiceTranscriptionSettings(patch));
    setTranscriptionHealth(await api.getVoiceTranscriptionHealth());
    setMessage(t("settings.abilities.listen.transcriptionSaved"));
  });
  const installLocalTranscription = () => void run(t("settings.abilities.listen.local.installing"), async () => {
    const snapshot = await api.installLocalTranscription();
    setLocalTranscription(snapshot);
    if (snapshot.status !== "ready") throw new Error(snapshot.error ?? t("settings.abilities.listen.local.installFailed"));
    setTranscriptionSettings(await api.getVoiceTranscriptionSettings());
    setTranscriptionHealth(await api.getVoiceTranscriptionHealth());
    await refreshAbilities();
    setMessage(t("settings.abilities.listen.local.installed"));
  });
  const startWakeCalibration = () => void run(t("settings.abilities.listen.calibration.starting"), async () => {
    setWakeCalibration(await api.startVoiceWakeCalibration(settings?.wake.phrase ?? ""));
    setMessage(t("settings.abilities.listen.calibration.started"));
  });
  const cancelWakeCalibration = () => void run(t("settings.abilities.listen.calibration.cancelling"), async () => {
    setWakeCalibration(await api.cancelVoiceWakeCalibration());
    await refreshAbilities();
    setMessage(t("settings.abilities.listen.calibration.cancelled"));
  });
  const saveWakeCalibration = () => void run(t("settings.abilities.listen.calibration.saving"), async () => {
    setWakeCalibration(await api.saveVoiceWakeCalibration());
    onSettings(await api.getVoiceSettings());
    await refreshAbilities();
    setMessage(t("settings.abilities.listen.calibration.saved"));
  });
  const deleteWakeInterpretation = (value: string) => void run(t("settings.abilities.listen.calibration.deleting"), async () => {
    setWakeCalibration(await api.deleteVoiceWakeCalibrationInterpretation(value));
    onSettings(await api.getVoiceSettings());
    await refreshAbilities();
    setMessage(t("settings.abilities.listen.calibration.deleted"));
  });
  const resetWakeCalibration = () => void run(t("settings.abilities.listen.calibration.resetting"), async () => {
    setWakeCalibration(await api.resetVoiceWakeCalibration());
    onSettings(await api.getVoiceSettings());
    await refreshAbilities();
    setMessage(t("settings.abilities.listen.calibration.reset"));
  });
  const requestPermission = (kind: DesktopPermissionKind) => void run(t("settings.busy.checking"), async () => {
    const next = await api.requestDesktopPermission(kind);
    setPermissions(next);
    if (next.appLocation === "applications" && next.permissions[kind].requiresRestartAfterGrant) {
      setPermissionRestartSuggested((current) => ({ ...current, [kind]: true }));
    }
    setMessage(t(kind === "microphone" ? "settings.permissions.microphoneRequested" : "settings.permissions.screenRequested"));
  });
  const openPermissionSettings = (kind: DesktopPermissionKind) => void run(t("settings.busy.opening"), async () => {
    const next = await api.openDesktopPermissionSettings(kind);
    setPermissions(next);
    if (next.appLocation === "applications" && next.permissions[kind].requiresRestartAfterGrant) {
      setPermissionRestartSuggested((current) => ({ ...current, [kind]: true }));
    }
    setMessage(t("settings.permissions.opened"));
  });
  const setVisionEnabled = (enabled: boolean) => void run(t("settings.busy.saving"), async () => {
    let next = await api.setVisionEnabled(enabled);
    if (enabled && next.capture.status === "permission-denied") {
      const nextPermissions = await api.requestDesktopPermission("screen-recording");
      setPermissions(nextPermissions);
      if (nextPermissions.appLocation === "applications" && nextPermissions.permissions["screen-recording"].requiresRestartAfterGrant) {
        setPermissionRestartSuggested((current) => ({ ...current, "screen-recording": true }));
      }
      next = await api.getVisionSnapshot(true);
    }
    setVision(next);
    setMessage(enabled
      ? next.capture.ready
        ? t("settings.abilities.vision.enabledSaved")
        : t("settings.permissions.screenRequested")
      : next.storage.deleteError || !next.storage.persisted
        ? t("settings.abilities.vision.deleteFailed")
        : t("settings.abilities.vision.disabledDeleted"));
  });
  const saveVisionModel = (model: string) => void run(t("settings.busy.checking"), async () => {
    if (!model) {
      setVision(await api.setVisionModelPreference(null));
    } else if (companionSettings?.target === "codex") {
      setVision(await api.setVisionModelPreference({ owner: "codex", model }));
    } else {
      const provider = visionBrainSettings?.provider;
      if (!provider || provider === "none") throw new Error(t("settings.aiBrain.chooseProvider"));
      setVision(await api.setVisionModelPreference({ owner: "host-ai", provider, model }));
    }
    setMessage(t("settings.abilities.vision.modelSaved"));
  });
  const openVisionStorage = () => void run(t("settings.busy.opening"), async () => {
    await api.openVisionStorageFolder();
    setMessage(t("settings.abilities.vision.storageOpened"));
  });
  const checkVision = () => void run(t("settings.busy.checking"), async () => {
    const [next, nextPermissions] = await Promise.all([api.getVisionSnapshot(true), api.getDesktopPermissions()]);
    setVision(next);
    setPermissions(nextPermissions);
    if (!next.capture.ready || !next.summary.ready) return;
    setMessage(t("settings.abilities.vision.checkReady"));
  });
  const saveProvider = (id: VoiceProviderId, patch: Record<string, unknown>) => settings && save({ providers: { [id]: { ...settings.providers[id], ...patch } } });
  const check = (id: VoiceProviderId) => void run(t("settings.busy.checking"), async () => {
    const result = await api.checkVoiceProviderHealth(id);
    setHealth((current) => ({ ...current, [id]: result }));
    if (!result.ready) throw new Error(result.reason ?? t("settings.voice.health.unavailable"));
    setMessage(t("settings.voice.health.ready"));
  });
  const discover = (id: VoiceProviderId) => void run(t("settings.busy.checking"), async () => {
    const result = await api.discoverVoiceProviderVoices(id);
    setHealth((current) => ({ ...current, [id]: result.evidence }));
    setVoices((current) => ({ ...current, [id]: result.voices }));
    setMessage(result.supported ? t("settings.voice.voices.found", { count: result.voices.length }) : t("settings.voice.voices.manual"));
  });
  const testProvider = (id: VoiceProviderId) => void run(t("settings.voice.testing"), async () => {
    const config = settings?.providers[id];
    const result = await api.testVoiceSpeech({
      text: testText,
      providerId: id,
      petId: selectedPetId,
      ...(config?.voiceId ? { voiceId: config.voiceId } : {}),
      ...(config && "model" in config && config.model ? { model: config.model } : {}),
    });
    if (!result.ok) throw new Error(result.attempts.at(-1)?.message ?? t("settings.voice.test.failed"));
    setHealth((current) => ({ ...current, [id]: {
      providerId: id,
      checkedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      configured: true,
      reachable: true,
      synthesisTested: true,
      discoverySupported: id === "system" || id === "elevenlabs",
      ready: true,
      method: "settings-test",
    } }));
    setMessage(t("settings.voice.test.successForProvider", { provider: voiceProviderLabel(id, t) }));
  });
  const installPocketTts = () => void run(t("settings.voice.pocket.installing"), async () => {
    const next = await api.installAndEnablePocketTts();
    setPocketTts(next);
    if (next.status !== "ready") throw new Error(next.error ?? t("settings.voice.pocket.failed"));
    onSettings(await api.getVoiceSettings());
    setHealth((current) => ({ ...current, pockettts: undefined }));
    setMessage(t("settings.voice.pocket.ready"));
  });
  const startPocketTts = () => void run(t("settings.voice.pocket.starting"), async () => {
    const next = await api.startPocketTts();
    setPocketTts(next);
    if (next.status !== "ready") throw new Error(next.error ?? t("settings.voice.pocket.failed"));
    onSettings(await api.updateVoiceSettings({ output: { ...settings?.output, providerId: "pockettts" } }));
    setHealth((current) => ({ ...current, pockettts: undefined }));
    setMessage(t("settings.voice.pocket.ready"));
  });
  const stopPocketTts = () => void run(t("settings.voice.pocket.stopping"), async () => {
    setPocketTts(await api.stopPocketTts());
    onSettings(await api.getVoiceSettings());
    setHealth((current) => ({ ...current, pockettts: undefined }));
    setMessage(t("settings.voice.pocket.stopped"));
  });

  useEffect(() => {
    if (section !== "speak" || voices.system !== undefined) return;
    void api.discoverVoiceProviderVoices("system").then((result) => {
      setHealth((current) => ({ ...current, system: result.evidence }));
      setVoices((current) => ({ ...current, system: result.voices }));
    }).catch(() => {
      setVoices((current) => ({ ...current, system: [] }));
    });
  }, [section, voices.system]);

  if (!settings) return <div className="settings-section"><p>{t("settings.voice.loading")}</p></div>;
  const availablePets = settings.installedPets.filter((pet) => pet.available);
  const selectedPetId = availablePets[0]?.id || "";
  const orderedProviderIds = [settings.output.providerId, ...providerIds.filter((id) => id !== settings.output.providerId)];
  const visionStatus = getPetVisionStatus({
    enabled: vision?.enabled ?? false,
    state: vision?.state ?? "disabled",
    captureReady: vision?.capture.ready ?? false,
    summaryReady: vision?.summary.ready ?? false,
  });
  const visionWorking = visionStatus === "working";
  const visionPaused = visionStatus === "paused";
  const compactVisionStatus = t(visionStatus === "off"
    ? "settings.abilities.vision.status.off"
    : visionStatus === "paused"
      ? "settings.abilities.vision.status.pausedShort"
      : visionStatus === "working"
        ? "settings.abilities.vision.working"
        : "settings.abilities.vision.status.setupNeeded");
  const activeVisionPreference = companionSettings?.target === "codex"
    ? vision?.modelPreference?.owner === "codex" ? vision.modelPreference.model : ""
    : vision?.modelPreference?.owner === "host-ai" && vision.modelPreference.provider === visionBrainSettings?.provider
      ? vision.modelPreference.model
      : "";
  const activeHostVisionModel = visionBrainSettings && visionBrainSettings.provider !== "none"
    ? visionBrainSettings.providers[visionBrainSettings.provider].model
    : "";
  const visionModelOptions = companionSettings?.target === "codex"
    ? [
        { value: "", label: t("settings.abilities.vision.useAiBrainDefault") },
        ...(visionCodexModels?.models ?? []).filter((model) => model.inputModalities.includes("image")).map((model) => ({ value: model.model, label: model.displayName })),
      ]
    : [
        { value: "", label: t("settings.abilities.vision.useAiBrainDefault") },
        ...(visionHostModels?.models ?? []).map((model) => ({ value: model.id, label: model.name === model.id ? model.id : `${model.name} · ${model.id}` })),
        ...(!visionHostModels?.models.some((model) => model.id === activeHostVisionModel) && activeHostVisionModel
          ? [{ value: activeHostVisionModel, label: activeHostVisionModel }]
          : []),
      ].filter((option, index, options) => option.value === "" || Boolean(option.value) && options.findIndex((candidate) => candidate.value === option.value) === index);
  const wakeHasRecentPcm = Boolean(
    wakeSnapshot?.diagnostics?.lastPcmFrameAt
    && wakeSnapshot.diagnostics.pcmFramesReceived > 0
    && Date.now() - wakeSnapshot.diagnostics.lastPcmFrameAt < 5_000
  );
  const wakeVerified = Boolean(wakeSnapshot?.armed && wakeHasRecentPcm);
  const wakeStatusKey = wakeVerified
    ? "settings.abilities.listen.listening"
    : !wakeHealth
      ? "settings.abilities.listen.checking"
      : !wakeHealth.ready
        ? "settings.abilities.listen.unavailable"
        : !companionSettings?.enabled
          ? "settings.abilities.listen.enableCompanion"
          : !settings.wake.phrase.trim()
            ? "settings.abilities.listen.choosePhrase"
            : wakeSnapshot?.captureState === "error"
              ? "settings.abilities.listen.needsAttention"
              : companionSettings.wake.enabled
                ? "settings.abilities.listen.starting"
                : "settings.abilities.listen.off";

  const sectionTitle = section === "listen" ? t("settings.abilities.listen.pageTitle") : section === "speak" ? t("settings.abilities.speak.pageTitle") : t("settings.abilities.vision.title");
  const sectionDescription = section === "listen" ? t("settings.abilities.listen.pageDescription") : section === "speak" ? t("settings.abilities.speak.description") : t("settings.abilities.vision.description");
  const diagnostics = wakeSnapshot?.diagnostics;
  const pocketVoices = pocketTts?.voices ?? [];
  const microphonePermission = permissions?.permissions.microphone;
  const screenPermission = permissions?.permissions["screen-recording"];
  const microphonePermissionReady = permissions?.platform !== "darwin" || microphonePermission?.status === "granted";
  const offerMicrophoneRestart = permissions?.appLocation === "applications" && Boolean(microphonePermission?.requiresRestartAfterGrant) && (microphonePermission?.status === "granted" || permissionRestartSuggested.microphone);
  const offerScreenRestart = permissions?.appLocation === "applications" && Boolean(screenPermission?.requiresRestartAfterGrant) && (screenPermission?.status === "granted" || permissionRestartSuggested["screen-recording"]);
  const calibrationCapturing = wakeCalibration?.state === "preparing" || wakeCalibration?.state === "listening" || wakeCalibration?.state === "transcribing";
  const inputRms = calibrationCapturing ? wakeCalibration?.lastPcmRms : wakeSnapshot?.diagnostics?.lastPcmRms;
  const inputAt = calibrationCapturing ? wakeCalibration?.lastPcmFrameAt : wakeSnapshot?.diagnostics?.lastPcmFrameAt;
  const inputLevel = !inputAt || Date.now() - inputAt > 3_000 || inputRms === undefined
    ? 0
    : inputRms < 0.003
      ? 1
      : inputRms < 0.015
        ? 2
        : inputRms < 0.08
          ? 3
          : 4;
  const inputLevelKey = inputLevel === 0 ? "waiting" : inputLevel === 1 ? "veryQuiet" : inputLevel === 2 ? "low" : inputLevel === 3 ? "good" : "loud";
  const savedMicrophoneMissing = Boolean(settings.wake.microphone?.deviceId && !microphoneDevices.some((device) =>
    device.deviceId === settings.wake.microphone?.deviceId || Boolean(settings.wake.microphone?.label && device.stableLabel === settings.wake.microphone.label)
  ));

  return <div className="settings-section">
    <p className="eyebrow">{t("settings.abilities.eyebrow")}</p>
    <h2 className="settings-section-title">{sectionTitle}</h2>
    <p className="text-sm text-slatecopy -mt-2 mb-2">{sectionDescription}</p>
    {refreshDegraded && <div className="settings-row"><div className="settings-row-info"><small>{t("settings.abilities.partialUnavailable")}</small></div><Button variant="secondary" size="compact" disabled={busy} onClick={() => void run(t("settings.busy.checking"), () => refreshAbilities())}>{t("common.retry")}</Button></div>}

    {section === "listen" && <div className="settings-group">
      <div className="settings-row"><div className="settings-row-info"><strong>{t("settings.abilities.listen.title")}</strong><small>{t("settings.abilities.listen.privacy")}</small><small>{wakeSnapshot?.reason ?? wakeHealth?.reason ?? t("settings.abilities.listen.description")}</small></div><span className={wakeVerified ? "pill pill-green" : wakeSnapshot?.captureState === "error" ? "pill pill-orange" : "pill pill-slate"}>{t(wakeStatusKey)}</span></div>
      <ToggleRow title={t("settings.abilities.listen.toggle")} description={t("settings.abilities.listen.toggleDescription")} checked={companionSettings?.wake.enabled ?? false} disabled={busy || (!companionSettings?.wake.enabled && (!wakeHealth?.ready || !companionSettings?.enabled || !settings.wake.phrase.trim() || !transcriptionHealth?.ready || !microphonePermissionReady))} onChange={setWakeEnabled} />
      <ToggleRow title={t("settings.abilities.listen.followUp")} description={t("settings.abilities.listen.followUpDescription")} checked={companionSettings?.wake.followUpEnabled ?? true} disabled={busy || !companionSettings?.wake.enabled} onChange={setFollowUpEnabled} />
      {permissions?.platform === "darwin" && <>
        <div className="settings-row"><div className="settings-row-info"><strong>{t("settings.permissions.microphone")}</strong><small>{t("settings.permissions.microphoneDescription")}</small><small>{permissions.appLocation === "development" ? t("settings.permissions.developmentCopy") : t("settings.permissions.status", { status: microphonePermission?.status ?? "unknown" })}</small>{offerMicrophoneRestart && <small>{t("settings.permissions.restartAfterGrant")}</small>}</div><div className="flex gap-2 items-center"><span className={microphonePermission?.status === "granted" ? "pill pill-green" : "pill pill-orange"}>{microphonePermission?.status ?? "unknown"}</span>{microphonePermission?.status !== "granted" && microphonePermission?.canRequest && <Button variant="primary" size="compact" disabled={busy} onClick={() => requestPermission("microphone")}>{t("settings.permissions.request")}</Button>}{microphonePermission?.canOpenSettings && <Button variant="secondary" size="compact" disabled={busy} onClick={() => openPermissionSettings("microphone")}>{t("settings.permissions.openSettings")}</Button>}{offerMicrophoneRestart && <Button variant="secondary" size="compact" disabled={busy} onClick={() => void api.restartForDesktopPermissions()}>{t("settings.permissions.restart")}</Button>}</div></div>
      </>}
      <VoiceSelectRow
        title={t("settings.abilities.listen.microphoneSelect")}
        description={savedMicrophoneMissing ? t("settings.abilities.listen.microphoneFallback") : t("settings.abilities.listen.microphoneSelectDescription")}
        value={savedMicrophoneMissing ? "" : settings.wake.microphone?.deviceId ?? ""}
        disabled={busy}
        onChange={(value) => {
          const selected = microphoneDevices.find((device) => device.deviceId === value);
          save({ wake: { microphone: { deviceId: value, ...(selected?.stableLabel ? { label: selected.stableLabel } : {}) } } }, true);
        }}
        options={[
          { value: "", label: t("settings.abilities.listen.microphoneSystemDefault") },
          ...microphoneDevices.map((device) => ({ value: device.deviceId, label: device.label })),
        ]}
      />
      <div className="settings-row">
        <div className="settings-row-info"><strong>{t("settings.abilities.listen.inputLevel")}</strong><small>{t("settings.abilities.listen.inputLevelDescription")}</small></div>
        <div className="wake-input-level" aria-label={t(`settings.abilities.listen.inputLevel.${inputLevelKey}`)}>
          <div className="wake-input-level-bars" aria-hidden="true">{[1, 2, 3, 4].map((bar) => <span key={bar} className={bar <= inputLevel ? "is-active" : ""} />)}</div>
          <span>{t(`settings.abilities.listen.inputLevel.${inputLevelKey}`)}</span>
        </div>
      </div>
      <div className="settings-row"><div className="settings-row-info"><strong>{t("settings.abilities.listen.speechRecognition")}</strong><small>{transcriptionHealth?.reason ?? (transcriptionHealth?.ready ? t("settings.abilities.listen.speechRecognitionReady") : t("settings.abilities.listen.speechRecognitionDescription"))}</small></div><span className={transcriptionHealth?.ready ? "pill pill-green" : "pill pill-orange"}>{transcriptionHealth?.ready ? t("settings.aiBrain.ready") : t("settings.aiBrain.needsAttention")}</span></div>
      <VoiceSelectRow title={t("settings.abilities.listen.transcriptionProvider")} description={t("settings.abilities.listen.transcriptionProviderDescription")} value={transcriptionSettings?.providerId ?? "local"} disabled={busy || !transcriptionSettings} onChange={(value) => saveTranscription({ providerId: value as VoiceTranscriptionSettings["providerId"] })} options={[{ value: "local", label: t("settings.abilities.listen.local.provider") }, { value: "openai", label: t("settings.abilities.listen.openaiProvider") }, { value: "none", label: t("settings.plugins.aiProvider.disabled") }]} />
      {transcriptionSettings?.providerId === "local" && <div className="settings-row"><div className="settings-row-info"><strong>{localTranscription?.modelLabel ?? t("settings.abilities.listen.local.provider")}</strong><small>{localTranscription?.error ?? localTranscription?.progress ?? t("settings.abilities.listen.local.description", { size: Math.round((localTranscription?.downloadBytes ?? 0) / 1024 / 1024) })}</small><small>{localTranscription ? t("settings.abilities.listen.local.storage", { path: localTranscription.storageLocation }) : t("settings.abilities.listen.local.offline")}</small></div><div className="flex gap-2 items-center"><span className={localTranscription?.status === "ready" ? "pill pill-green" : localTranscription?.status === "error" ? "pill pill-orange" : "pill pill-slate"}>{t(`settings.abilities.listen.local.status.${localTranscription?.status ?? "not-installed"}`)}</span>{localTranscription?.status !== "ready" && <Button variant="primary" size="compact" disabled={busy || localTranscription?.status === "downloading"} onClick={installLocalTranscription}>{t("settings.abilities.listen.local.downloadEnable")}</Button>}</div></div>}
      {transcriptionSettings?.providerId === "openai" && <div className="settings-row"><div className="settings-row-info"><strong>{t("settings.voice.apiKey")}</strong><small>{secrets["openai-compatible"].hasKey ? t("settings.voice.apiKeyStored") : t("settings.voice.apiKeyNone")}</small><small>{t("settings.abilities.listen.transcriptionModel", { model: transcriptionSettings.model })}</small></div><div className="flex gap-2 items-center"><input className="settings-select" type="password" value={transcriptionKeyDraft} disabled={busy} placeholder={t("settings.voice.apiKeyPlaceholder")} onChange={(event) => setTranscriptionKeyDraft(event.target.value)} /><Button variant="secondary" size="compact" disabled={busy || !transcriptionKeyDraft} onClick={() => void run(t("settings.busy.saving"), async () => { onSecrets(await api.setVoiceSecret("openai-compatible", transcriptionKeyDraft)); setTranscriptionKeyDraft(""); setTranscriptionHealth(await api.getVoiceTranscriptionHealth()); setMessage(t("settings.voice.saved")); })}>{t("settings.voice.saveKey")}</Button>{secrets["openai-compatible"].hasKey && <Button variant="secondary" size="compact" disabled={busy} onClick={() => void run(t("settings.busy.saving"), async () => { onSecrets(await api.setVoiceSecret("openai-compatible", null)); setTranscriptionHealth(await api.getVoiceTranscriptionHealth()); setMessage(t("settings.voice.saved")); })}>{t("settings.voice.removeKey")}</Button>}</div></div>}
      {transcriptionSettings?.providerId === "openai" && <VoiceTextRow title={t("settings.abilities.listen.openaiBaseUrl")} description={t("settings.abilities.listen.openaiBaseUrlDescription")} type="url" value={transcriptionSettings.baseUrl} disabled={busy} onSave={(value) => saveTranscription({ baseUrl: value })} />}
      {transcriptionSettings?.providerId === "openai" && <VoiceTextRow title={t("settings.abilities.listen.openaiModel")} description={t("settings.abilities.listen.openaiModelDescription")} value={transcriptionSettings.model} disabled={busy} onSave={(value) => saveTranscription({ model: value })} />}
      {companionSettings && !companionSettings.enabled && <div className="companion-disclosure"><strong>{t("pets.companion.enableTitle")}</strong><p>{t("pets.companion.enableDisclosure")}</p><Button variant="primary" size="compact" disabled={busy} onClick={() => void run(t("settings.busy.saving"), async () => { setCompanionSettings(await api.enableCompanion()); await refreshAbilities(); setMessage(t("pets.companion.enabled")); })}>{t("pets.companion.enable")}</Button></div>}
      <VoiceSelectRow title={t("settings.abilities.listen.engine")} description={t("settings.abilities.listen.engineDescription")} value={settings.wake.engine} disabled={busy || companionSettings?.wake.enabled === true} onChange={(value) => save({ wake: { engine: value } }, true)} options={[{ value: "official-livekit", label: t("settings.abilities.listen.engineOfficial") }, { value: "custom-sherpa", label: t("settings.abilities.listen.engineCustom") }]} />
      {settings.wake.engine === "official-livekit" && <>
        <div className="settings-row"><div className="settings-row-info"><strong>{t("settings.abilities.listen.phrase")}</strong><small>{t("settings.abilities.listen.officialPhraseDescription")}</small></div><span className="pill pill-slate">Hey Pedra</span></div>
        <VoiceSelectRow title={t("settings.abilities.listen.sensitivity")} description={t("settings.abilities.listen.sensitivityDescription")} value={settings.wake.sensitivity} disabled={busy} onChange={(value) => save({ wake: { sensitivity: value } }, true)} options={[{ value: "easy", label: t("settings.abilities.listen.sensitivityEasy") }, { value: "balanced", label: t("settings.abilities.listen.sensitivityBalanced") }, { value: "strict", label: t("settings.abilities.listen.sensitivityStrict") }]} />
      </>}
      {settings.wake.engine === "custom-sherpa" && <VoiceTextRow title={t("settings.abilities.listen.phrase")} description={t("settings.abilities.listen.customPhraseDescription")} value={settings.wake.phrase} placeholder={t("settings.abilities.listen.phrasePlaceholder")} disabled={busy} onSave={(value) => save({ wake: { phrase: value } }, true)} />}
      {settings.wake.engine === "custom-sherpa" && <div className="wake-calibration-card">
        <div className="settings-row-info">
          <strong>{t("settings.abilities.listen.calibration.title")}</strong>
          <small>{t("settings.abilities.listen.calibration.description")}</small>
          <small>{t("settings.abilities.listen.calibration.privacy")}</small>
          {(wakeCalibration?.state === "listening" || wakeCalibration?.state === "transcribing" || wakeCalibration?.state === "preparing") && <small className="wake-calibration-prompt">{wakeCalibration.state === "transcribing" ? t("settings.abilities.listen.calibration.processing") : t("settings.abilities.listen.calibration.sayPhrase", { phrase: settings.wake.phrase, current: wakeCalibration.completedSamples + 1, total: wakeCalibration.requiredSamples })}</small>}
          {wakeCalibration?.state === "review" && <small className="wake-calibration-prompt">{wakeCalibration.batchInterpretations?.length ? t("settings.abilities.listen.calibration.review", { variants: wakeCalibration.batchInterpretations.join(", ") }) : t("settings.abilities.listen.calibration.noVariants")}</small>}
          {wakeCalibration?.state === "review" && <small>{t("settings.abilities.listen.calibration.detectionCheck", { detected: wakeCalibration.detectedSamples, total: wakeCalibration.completedSamples })}</small>}
          {Boolean(wakeCalibration?.savedInterpretations?.length) && <>
            <small><strong>{t("settings.abilities.listen.calibration.savedTitle")}</strong></small>
            <div className="wake-calibration-interpretations">
              {wakeCalibration?.savedInterpretations?.map((value) => <button key={value} type="button" className="wake-calibration-interpretation" disabled={busy || ["preparing", "listening", "transcribing", "review", "saving"].includes(wakeCalibration.state)} aria-label={t("settings.abilities.listen.calibration.deleteLabel", { value })} onClick={() => deleteWakeInterpretation(value)}><span>{value}</span><span aria-hidden="true">×</span></button>)}
            </div>
          </>}
          {(wakeCalibration?.savedInterpretations?.length ?? 0) > (wakeCalibration?.activeRuntimeInterpretations?.length ?? 0) && <small>{t("settings.abilities.listen.calibration.activeLimit", { active: wakeCalibration?.activeRuntimeInterpretations?.length ?? 0, saved: wakeCalibration?.savedInterpretations?.length ?? 0 })}</small>}
          {wakeCalibration?.reason && <small className="text-red-700">{wakeCalibration.reason}</small>}
        </div>
        <div className="wake-calibration-actions">
          {(wakeCalibration?.state === "preparing" || wakeCalibration?.state === "listening" || wakeCalibration?.state === "transcribing") && <><span className="pill pill-slate">{t("settings.abilities.listen.calibration.progress", { current: wakeCalibration.completedSamples, total: wakeCalibration.requiredSamples })}</span><Button variant="secondary" size="compact" disabled={busy} onClick={cancelWakeCalibration}>{t("common.cancel")}</Button></>}
          {wakeCalibration?.state === "review" && <><Button variant="primary" size="compact" disabled={busy} onClick={saveWakeCalibration}>{t("settings.abilities.listen.calibration.save")}</Button><Button variant="secondary" size="compact" disabled={busy} onClick={cancelWakeCalibration}>{t("common.cancel")}</Button></>}
          {wakeCalibration?.calibrated && wakeCalibration.state !== "review" && <><span className="pill pill-green">{t("settings.abilities.listen.calibration.calibrated")}</span><Button variant="secondary" size="compact" disabled={busy} onClick={resetWakeCalibration}>{t("settings.abilities.listen.calibration.resetButton")}</Button></>}
          {!["preparing", "listening", "transcribing", "review", "saving"].includes(wakeCalibration?.state ?? "idle") && localTranscription?.status === "ready" && <Button variant="primary" size="compact" disabled={busy || !settings.wake.phrase.trim() || !microphonePermissionReady} onClick={startWakeCalibration}>{wakeCalibration?.calibrated ? t("settings.abilities.listen.calibration.recordMore") : t("settings.abilities.listen.calibration.start")}</Button>}
          {localTranscription?.status !== "ready" && <Button variant="primary" size="compact" disabled={busy || localTranscription?.status === "downloading"} onClick={installLocalTranscription}>{t("settings.abilities.listen.calibration.download")}</Button>}
        </div>
      </div>}
      {(companionSettings?.wake.enabled || wakeSnapshot?.captureState === "error") && <>
        <div className="settings-row"><div className="settings-row-info"><strong>{t("settings.abilities.listen.pipeline")}</strong><small>{t("settings.abilities.listen.pipelineDescription")}</small></div></div>
        <AbilityDiagnosticRow label={t("settings.abilities.listen.capture")} ready={Boolean(diagnostics?.captureStartedAt)} detail={diagnostics?.captureStartedAt ? t("settings.abilities.listen.started") : t("settings.abilities.listen.waitingForCapture")} />
        <AbilityDiagnosticRow label={t("settings.abilities.listen.helper")} ready={Boolean(diagnostics?.helperStartedAt)} detail={diagnostics?.helperStartedAt ? t("settings.abilities.listen.connected") : t("settings.abilities.listen.waitingForHelper")} />
        <AbilityDiagnosticRow label={t("settings.abilities.listen.microphone")} ready={wakeHasRecentPcm} detail={wakeHasRecentPcm ? t("settings.abilities.listen.audioFrames", { count: diagnostics?.pcmFramesReceived ?? 0 }) : t("settings.abilities.listen.noAudioFrames")} />
        <AbilityDiagnosticRow label={t("settings.abilities.listen.transcription")} ready={Boolean(diagnostics?.lastTranscriptionAt && diagnostics?.lastFailureStage !== "transcription")} detail={diagnostics?.lastFailureStage === "transcription" ? diagnostics.lastError ?? t("settings.abilities.listen.transcriptionFailed") : diagnostics?.lastTranscriptionAt ? t("settings.abilities.listen.transcriptionSucceeded") : transcriptionHealth?.ready ? t("settings.abilities.listen.transcriptionReadyToTest", { provider: transcriptionSettings?.providerId === "local" ? t("settings.abilities.listen.local.provider") : t("settings.abilities.listen.openaiProvider") }) : t("settings.abilities.listen.transcriptionConfigure")} neutral={!diagnostics?.lastTranscriptionAt && diagnostics?.lastFailureStage !== "transcription"} />
        <AbilityDiagnosticRow label={t("settings.abilities.listen.aiResponse")} ready={Boolean(diagnostics?.lastCompanionTurnAt && diagnostics?.lastFailureStage !== "companion")} detail={diagnostics?.lastFailureStage === "companion" ? diagnostics.lastError ?? t("settings.abilities.listen.aiResponseFailed") : diagnostics?.lastCompanionTurnAt ? t("settings.abilities.listen.aiResponseSucceeded") : t("settings.abilities.listen.aiResponseNotTested")} neutral={!diagnostics?.lastCompanionTurnAt && diagnostics?.lastFailureStage !== "companion"} />
        <AbilityDiagnosticRow label={t("settings.abilities.listen.lastTurn")} ready={Boolean(diagnostics?.lastCompanionTurnAt)} detail={diagnostics?.lastCompanionTurnAt ? new Date(diagnostics.lastCompanionTurnAt).toLocaleTimeString() : t("settings.abilities.listen.noTurnYet")} neutral={!diagnostics?.lastCompanionTurnAt} />
      </>}
    </div>}

    {section === "speak" && <>
    <div className="settings-group">
      <VoiceSelectRow title={t("settings.voice.defaultProvider")} description={t("settings.voice.defaultProviderDescription")} value={settings.output.providerId} disabled={busy} onChange={(value) => save({ output: { ...settings.output, providerId: value } })} options={providerIds.map((id) => ({ value: id, label: voiceProviderLabel(id, t) }))} />
      <VoiceSelectRow title={t("settings.voice.overlap")} description={t("settings.voice.overlapDescription")} value={settings.output.overlapPolicy} disabled={busy} onChange={(value) => save({ output: { ...settings.output, overlapPolicy: value } })} options={[{ value: "interrupt", label: t("settings.voice.overlap.interrupt") }, { value: "queue", label: t("settings.voice.overlap.queue") }, { value: "ignore", label: t("settings.voice.overlap.ignore") }]} />
      <VoiceSelectRow title={t("settings.voice.fallback")} description={t("settings.voice.fallbackDescription")} value={settings.output.providerFallback} disabled={busy} onChange={(value) => save({ output: { ...settings.output, providerFallback: value } })} options={[{ value: "system", label: t("settings.voice.fallback.system") }, { value: "fail", label: t("settings.voice.fallback.none") }]} />
    </div>

    {orderedProviderIds.map((id) => {
      const config = settings.providers[id] as Record<string, string | number | undefined>;
      const foundVoices = voices[id] ?? [];
      const evidence = health[id];
      const secretId = id === "openai-compatible" || id === "elevenlabs" ? id : null;
      const isDefault = id === settings.output.providerId;
      const supportsDiscovery = id === "system" || id === "elevenlabs";
      const displayVoices = id === "pockettts" ? pocketVoices : foundVoices;
      const pocketBusy = id === "pockettts" && (pocketTts?.status === "installing" || pocketTts?.status === "starting" || pocketTts?.status === "warming");
      const pocketReady = id === "pockettts" && pocketTts?.status === "ready";
      return <div className="settings-group" key={id}>
        <div className="settings-row">
          <div className="settings-row-info"><strong>{voiceProviderLabel(id, t)}</strong><small>{voiceProviderDescription(id, t)}</small><small>{id === "pockettts" ? pocketTts?.error ?? pocketTts?.progress ?? t("settings.voice.pocket.notInstalled") : evidence ? (evidence.ready ? t("settings.voice.health.ready") : evidence.reason ?? t("settings.voice.health.unavailable")) : t("settings.voice.health.notChecked")}</small></div>
          <div className="flex gap-2 items-center">{isDefault && <span className="pill pill-green">{t("settings.voice.defaultBadge")}</span>}<span className={(evidence?.ready || pocketReady) ? "pill pill-green" : (evidence || pocketTts?.error) ? "pill pill-orange" : "pill pill-slate"}>{id === "pockettts" ? t(`settings.voice.pocket.status.${pocketTts?.status ?? "not-installed"}`) : evidence?.ready ? t("settings.voice.connected") : t("settings.voice.notConnected")}</span><Button variant="secondary" size="compact" disabled={busy || pocketBusy} onClick={() => testProvider(id)}>{t("settings.voice.test.button")}</Button>{id !== "pockettts" && <Button variant="secondary" size="compact" disabled={busy} onClick={() => check(id)}>{t("settings.voice.check")}</Button>}{supportsDiscovery && <Button variant="secondary" size="compact" disabled={busy} onClick={() => discover(id)}>{t("settings.voice.findProviderVoices", { provider: voiceProviderLabel(id, t) })}</Button>}</div>
        </div>
        {id === "pockettts" && <div className="settings-row"><div className="settings-row-info"><strong>{t("settings.voice.pocket.localService")}</strong><small>{t("settings.voice.pocket.localServiceDescription", { version: pocketTts?.packageVersion ?? "2.1.0" })}</small></div><div className="flex gap-2 items-center">{(pocketTts?.status === "not-installed" || pocketTts?.status === "uv-missing" || pocketTts?.status === "error") && <Button variant="primary" size="compact" disabled={busy || pocketBusy} onClick={installPocketTts}>{t("settings.voice.pocket.downloadEnable")}</Button>}{pocketTts?.status === "stopped" && <Button variant="primary" size="compact" disabled={busy} onClick={startPocketTts}>{t("settings.voice.pocket.startUse")}</Button>}{pocketReady && <Button variant="secondary" size="compact" disabled={busy} onClick={stopPocketTts}>{t("settings.voice.pocket.stop")}</Button>}</div></div>}
        {id === "pockettts" && <details className="settings-row"><summary>{t("settings.voice.pocket.advanced")}</summary><small>{t("settings.voice.pocket.managedUrl", { url: pocketTts?.baseUrl ?? "http://127.0.0.1:8000" })}</small></details>}
        {id !== "system" && id !== "pockettts" && <VoiceTextRow title={t("settings.voice.baseUrl")} description={t("settings.voice.baseUrlHelp")} type="url" value={String(config.baseUrl ?? "")} disabled={busy} onSave={(value) => saveProvider(id, { baseUrl: value })} />}
        {(id === "system" || displayVoices.length) ? <VoiceSelectRow title={t("settings.voice.providerVoice", { provider: voiceProviderLabel(id, t) })} description={id === "pockettts" ? t("settings.voice.pocket.voiceDescription") : t("settings.voice.voiceDiscoveredForProvider", { provider: voiceProviderLabel(id, t), count: displayVoices.length })} value={String(config.voiceId ?? "")} disabled={busy || pocketBusy} onChange={(value) => saveProvider(id, { voiceId: value })} options={[...(id === "pockettts" ? [] : [{ value: "", label: t("settings.voice.providerDefaultFor", { provider: voiceProviderLabel(id, t) }) }]), ...displayVoices.map((voice) => ({ value: voice.id, label: formatVoiceOptionLabel(id, voice, t) }))]} /> : <VoiceTextRow title={t("settings.voice.providerVoice", { provider: voiceProviderLabel(id, t) })} description={voiceManualDescription(id, t)} value={String(config.voiceId ?? "")} placeholder={t("settings.voice.voicePlaceholder")} disabled={busy} onSave={(value) => saveProvider(id, { voiceId: value })} />}
        {(id === "openai-compatible" || id === "elevenlabs") && <VoiceTextRow title={t("settings.voice.model")} description={t("settings.voice.modelDescription")} value={String(config.model ?? "")} disabled={busy} onSave={(value) => saveProvider(id, { model: value })} />}
        {secretId && <div className="settings-row"><div className="settings-row-info"><strong>{t("settings.voice.apiKey")}</strong><small>{secrets[secretId].hasKey ? t("settings.voice.apiKeyStored") : t("settings.voice.apiKeyNone")}</small></div><div className="flex gap-2 items-center"><input className="settings-select" type="password" value={keyDrafts[secretId] ?? ""} disabled={busy} placeholder={t("settings.voice.apiKeyPlaceholder")} onChange={(event) => setKeyDrafts((current) => ({ ...current, [secretId]: event.target.value }))} /><Button variant="secondary" size="compact" disabled={busy || !(keyDrafts[secretId] ?? "")} onClick={() => void run(t("settings.busy.saving"), async () => { onSecrets(await api.setVoiceSecret(secretId, keyDrafts[secretId])); setKeyDrafts((current) => ({ ...current, [secretId]: "" })); setMessage(t("settings.voice.saved")); })}>{t("settings.voice.saveKey")}</Button>{secrets[secretId].hasKey && <Button variant="secondary" size="compact" disabled={busy} onClick={() => void run(t("settings.busy.saving"), async () => { onSecrets(await api.setVoiceSecret(secretId, null)); setMessage(t("settings.voice.saved")); })}>{t("settings.voice.removeKey")}</Button>}</div></div>}
      </div>;
    })}

    <div className="settings-group"><div className="settings-row"><div className="settings-row-info"><strong>{t("settings.voice.test.title")}</strong><small>{t("settings.voice.test.chooseProvider")}</small></div><div className="flex gap-2 items-center">{availablePets[0] && <span className="pill pill-slate">{availablePets[0].displayName}</span>}<input className="settings-select" value={testText} maxLength={300} disabled={busy} onChange={(event) => setTestText(event.target.value)} /><Button variant="secondary" size="compact" disabled={busy || !selectedPetId} onClick={() => void api.stopVoiceSpeech(selectedPetId)}>{t("settings.voice.stop")}</Button></div></div></div>
    </>}

    {section === "vision" && <div className="settings-group">
      <ToggleRow title={t("settings.abilities.vision.toggle")} description={t("settings.abilities.vision.toggleDescription")} checked={vision?.enabled ?? false} disabled={busy || !vision} onChange={setVisionEnabled} />
      <div className="settings-row"><div className="settings-row-info"><strong>{t("settings.abilities.vision.statusLabel")}</strong><small>{vision?.capture.reason ?? vision?.summary.reason ?? (visionWorking ? t("settings.abilities.vision.checkReady") : visionPaused ? t("settings.abilities.vision.pauseDescription") : t("settings.abilities.vision.offDescription"))}</small></div><div className="flex gap-2 items-center"><span className={visionWorking ? "pill pill-green" : vision?.enabled && !visionPaused ? "pill pill-orange" : "pill pill-slate"}>{compactVisionStatus}</span>{vision?.capture.status === "permission-denied" && screenPermission?.canRequest && <Button variant="primary" size="compact" disabled={busy} onClick={() => requestPermission("screen-recording")}>{t("settings.permissions.allowScreenAccess")}</Button>}<Button variant="secondary" size="compact" disabled={busy} onClick={checkVision}>{t("settings.abilities.vision.checkVision")}</Button>{vision?.capture.status === "permission-denied" && offerScreenRestart && <Button variant="secondary" size="compact" disabled={busy} onClick={() => void api.restartForDesktopPermissions()}>{t("settings.permissions.restart")}</Button>}</div></div>
      <VoiceSelectRow title={t("settings.abilities.vision.model")} description={t("settings.abilities.vision.modelDescription")} value={activeVisionPreference} disabled={busy || !companionSettings || visionBrainSettings?.provider === "none" && companionSettings.target === "host-ai"} onChange={saveVisionModel} options={visionModelOptions} />
      <div className="settings-row"><div className="settings-row-info"><strong>{t("settings.abilities.vision.storage")}</strong><small>{t("settings.abilities.vision.privacy")}</small></div><Button variant="secondary" size="compact" disabled={busy || !vision} onClick={openVisionStorage}>{t("settings.abilities.vision.openStorage")}</Button></div>
    </div>}

  </div>;
}

function AbilityDiagnosticRow({ label, ready, detail, neutral = false }: { label: string; ready: boolean; detail: string; neutral?: boolean }) {
  const { t } = useI18n();
  return <div className="settings-row"><div className="settings-row-info"><strong>{label}</strong><small>{detail}</small></div><span className={neutral ? "pill pill-slate" : ready ? "pill pill-green" : "pill pill-orange"}>{neutral ? "—" : ready ? t("settings.abilities.diagnostic.ready") : t("settings.abilities.diagnostic.waiting")}</span></div>;
}

function VoiceSelectRow({ title, description, value, options, disabled, onChange }: { title: string; description: string; value: string; options: Array<{ value: string; label: string; disabled?: boolean }>; disabled: boolean; onChange: (value: string) => void }) {
  return <div className="settings-row"><div className="settings-row-info"><strong>{title}</strong><small>{description}</small></div><select className="settings-select" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}</select></div>;
}

function VoiceTextRow({ title, description, value, placeholder, type = "text", disabled, onSave }: { title: string; description: string; value: string; placeholder?: string; type?: string; disabled: boolean; onSave: (value: string) => void }) {
  return <div className="settings-row"><div className="settings-row-info"><strong>{title}</strong><small>{description}</small></div><input className="settings-select" type={type} defaultValue={value} placeholder={placeholder} disabled={disabled} onBlur={(event) => { if (event.target.value !== value) onSave(event.target.value); }} /></div>;
}

function voiceProviderLabel(providerId: VoiceProviderId, t: (key: string, values?: Record<string, string | number>) => string): string {
  if (providerId === "system") return t("settings.voice.provider.system");
  if (providerId === "pockettts") return t("settings.voice.provider.pockettts");
  if (providerId === "openai-compatible") return t("settings.voice.provider.openaiCompatible");
  return t("settings.voice.provider.elevenlabs");
}

function voiceProviderDescription(providerId: VoiceProviderId, t: (key: string, values?: Record<string, string | number>) => string): string {
  if (providerId === "system") return t("settings.voice.providerDescription.system");
  if (providerId === "pockettts") return t("settings.voice.providerDescription.pockettts");
  if (providerId === "openai-compatible") return t("settings.voice.providerDescription.openaiCompatible");
  return t("settings.voice.providerDescription.elevenlabs");
}

function voiceManualDescription(providerId: VoiceProviderId, t: (key: string, values?: Record<string, string | number>) => string): string {
  if (providerId === "pockettts") return t("settings.voice.voiceManual.pockettts");
  if (providerId === "openai-compatible") return t("settings.voice.voiceManual.openaiCompatible");
  return t("settings.voice.voiceManual.generic", { provider: voiceProviderLabel(providerId, t) });
}

function formatVoiceOptionLabel(providerId: VoiceProviderId, voice: VoiceInfo, t: (key: string, values?: Record<string, string | number>) => string): string {
  const language = voice.language ? ` · ${voice.language}` : "";
  return `[${voiceProviderLabel(providerId, t)}${language}] ${voice.label}`;
}

function LanSettingsPanel({ status, onRefresh, busy }: { status: LanStatusSnapshot | null; onRefresh: () => void; busy: boolean }) {
  const { t } = useI18n();
  const clients = status?.clients ?? [];
  const authLabel = getLanAuthLabel(status, t);
  const topologyIssues = status?.topologyIssues ?? [];
  return (
    <div className="settings-section">
      <div className="flex items-center justify-between">
        <div>
          <p className="eyebrow">{t("settings.lan.eyebrow")}</p>
          <h2 className="settings-section-title">{t("settings.lan.title")}</h2>
        </div>
        <Button variant="secondary" size="compact" disabled={busy} onClick={onRefresh}>
          <RefreshIcon />
          {t("settings.lan.refresh")}
        </Button>
      </div>
      <p className="text-sm text-slatecopy -mt-2 mb-2">{t("settings.lan.description")}</p>

      <div className="settings-group">
        <div className="lan-status-grid">
          <LanStatusMetric label={t("settings.lan.mode")} value={status?.mode ?? "off"} />
          <LanStatusMetric label={t("settings.lan.host")} value={status?.localHost ?? "-"} />
          <LanStatusMetric label={t("settings.lan.server")} value={status?.serverUrl ?? "-"} />
          <LanStatusMetric label={t("settings.lan.auth")} value={authLabel} tone={status?.auth === "token" ? "ok" : "warn"} />
          <LanStatusMetric label={t("settings.lan.tokenHint")} value={status?.tokenHint ? t("settings.lan.tokenHintValue", { hint: status.tokenHint }) : t("settings.lan.none")} />
          <LanStatusMetric label={t("settings.lan.currentOwner")} value={status?.currentHost ?? t("settings.lan.none")} />
          <LanStatusMetric label={t("settings.lan.persistedOwner")} value={status?.persistedCurrentHost ?? t("settings.lan.none")} />
          <LanStatusMetric label={t("settings.lan.clients")} value={String(clients.length)} />
          <LanStatusMetric label={t("settings.lan.topology")} value={status?.topologyHosts ? t("settings.lan.topologyConfigured", { hosts: status.topologyHosts, links: status.topologyLinks }) : t("settings.lan.topologyFallback")} />
          <LanStatusMetric label={t("settings.lan.topologyWarnings")} value={String(topologyIssues.length)} tone={topologyIssues.length ? "warn" : "ok"} />
        </div>
      </div>

      {topologyIssues.length ? (
        <div className="settings-group">
          <div className="settings-row">
            <div className="settings-row-info">
              <strong>{t("settings.lan.topologyWarnings")}</strong>
              <small>{t("settings.lan.topologyWarningsDescription")}</small>
            </div>
          </div>
          {topologyIssues.map((issue) => (
            <div className="settings-row" key={`${issue.host}-${issue.edge}-${issue.neighbor}-${issue.code}`}>
              <div className="settings-row-info">
                <strong>{issue.host} {issue.edge} {issue.neighbor}</strong>
                <small>{getLanTopologyIssueLabel(issue, t)}</small>
              </div>
              <span className="pill pill-orange">{t("settings.lan.warning")}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="settings-group">
        <div className="settings-row">
          <div className="settings-row-info">
            <strong>{t("settings.lan.connectedHosts")}</strong>
            <small>{t("settings.lan.connectedHostsDescription")}</small>
          </div>
        </div>
        {clients.length ? clients.map((client) => (
          <div className="settings-row" key={client.host}>
            <div className="settings-row-info">
              <strong>{client.host}</strong>
              <small>{client.position ? [client.position.x, client.position.y].join(", ") : t("settings.lan.noPosition")}</small>
            </div>
            <span className={client.host === status?.currentHost ? "pill pill-green" : "pill pill-slate"}>{client.host === status?.currentHost ? t("settings.lan.owner") : t("settings.lan.connected")}</span>
          </div>
        )) : (
          <div className="settings-row">
            <div className="settings-row-info">
              <strong>{t("settings.lan.noClients")}</strong>
              <small>{t("settings.lan.noClientsDescription")}</small>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function getLanAuthLabel(status: LanStatusSnapshot | null, t: (key: string, values?: Record<string, string | number>) => string): string {
  if (!status) return t("settings.lan.authNone");
  if (status.authInsecure) return t("settings.lan.authInsecure");
  if (status.authSource === "env") return t("settings.lan.authEnv");
  if (status.authSource === "stored") return t("settings.lan.authStored");
  if (status.authSource === "generated") return t("settings.lan.authGenerated");
  return t("settings.lan.authNone");
}

function getLanTopologyIssueLabel(issue: LanTopologyIssue, t: (key: string, values?: Record<string, string | number>) => string): string {
  if (issue.code === "self_reference") return t("settings.lan.topologySelfReference");
  return t("settings.lan.topologyMissingReverse", { reverse: oppositeLanEdge(issue.edge), neighbor: issue.neighbor, host: issue.host });
}

function oppositeLanEdge(edge: LanTopologyIssue["edge"]): LanTopologyIssue["edge"] {
  if (edge === "left") return "right";
  if (edge === "right") return "left";
  if (edge === "up") return "down";
  return "up";
}

function LanStatusMetric({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" }) {
  const pillClass = tone === "ok" ? "pill pill-green" : tone === "warn" ? "pill pill-orange" : "pill pill-blue";
  return (
    <div className="lan-status-metric">
      <span>{label}</span>
      <strong className={pillClass}>{value}</strong>
    </div>
  );
}
const pluginFilterLabelKeys: Record<PluginFilter, string> = {
  all: "plugins.filter.all",
  installed: "plugins.filter.installed",
  catalog: "plugins.filter.catalog",
  local: "plugins.filter.local",
  broken: "plugins.filter.broken",
};

const pluginPermissionLabelKeys: Record<PluginPermission, string> = {
  "pet:speak": "plugins.permission.pet:speak",
  "pet:reaction": "plugins.permission.pet:reaction",
  "pet:move": "plugins.permission.pet:move",
  timer: "plugins.permission.timer",
  schedule: "plugins.permission.schedule",
  storage: "plugins.permission.storage",
  status: "plugins.permission.status",
  commands: "plugins.permission.commands",
  network: "plugins.permission.network",
  "pet:interact": "plugins.permission.pet:interact",
  "pet:pin": "plugins.permission.pet:pin",
  "pet:animate": "plugins.permission.pet:animate",
  "pet:speak:dynamic": "plugins.permission.pet:speak:dynamic",
  "pet:drop": "plugins.permission.pet:drop",
  "pets:read": "plugins.permission.pets:read",
  "pets:manage": "plugins.permission.pets:manage",
  audio: "plugins.permission.audio",
  events: "plugins.permission.events",
  "ui:toast": "plugins.permission.ui:toast",
  "ui:panel": "plugins.permission.ui:panel",
  "ui:delivery": "plugins.permission.ui:delivery",
  notify: "plugins.permission.notify",
  bus: "plugins.permission.bus",
  ai: "plugins.permission.ai",
  secrets: "plugins.permission.secrets",
  "voice:speak": "plugins.permission.voice:speak",
  "voice:listen": "plugins.permission.voice:listen",
  "companion:context": "plugins.permission.companion:context",
  auth: "plugins.permission.auth",
  files: "plugins.permission.files",
  "system:openExternal": "plugins.permission.system:openExternal",
  "system:metrics": "plugins.permission.system:metrics",
  clipboard: "plugins.permission.clipboard",
  "network:write": "plugins.permission.network:write",
};
const sensitivePermissionSet = new Set<PluginPermission>(["voice:listen", "clipboard", "pet:speak:dynamic", "companion:context"]);

const pluginStatusTone: Record<NonNullable<PluginStatus["tone"]>, keyof typeof statusPillToneClass> = {
  info: "blue",
  success: "green",
  warning: "orange",
  error: "red",
};

function PluginGlyph({ className = "plugin-glyph" }: { className?: string }) {
  return <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2 3 6.5l9 4.5 9-4.5z" />
    <path d="m3 12 9 4.5 9-4.5" />
    <path d="m3 17.5 9 4.5 9-4.5" />
  </svg>;
}

function PluginIcon({ icon = "plugin", className = "plugin-glyph" }: { icon?: PluginIconName; className?: string }) {
  if (icon === "bell") return <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10 5a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3a4 4 0 0 0 2 3H4a4 4 0 0 0 2-3v-3a7 7 0 0 1 4-6M9 17v1a3 3 0 0 0 6 0v-1" />
  </svg>;
  if (icon === "timer") return <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0-18 0" />
    <path d="M12 7v5l3 3" />
  </svg>;
  if (icon === "github") return <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 19c-4.3 1.4-4.3-2.5-6-3" />
    <path d="M15 21v-3.5c0-1 .1-1.4-.5-2c2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2a4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6c-.6.6-.6 1.2-.5 2V21" />
  </svg>;
  if (icon === "heart") return <HeartIcon />;
  if (icon === "sparkles") return <StarIcon />;
  if (icon === "coffee") return <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10 2v2" /><path d="M14 2v2" /><path d="M16 8h1a4 4 0 0 1 0 8h-1" /><path d="M6 8h10v7a5 5 0 0 1-5 5h0a5 5 0 0 1-5-5Z" /><path d="M4 22h14" />
  </svg>;
  if (icon === "focus") return <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
  </svg>;
  if (icon === "droplet") return <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 2.5S5 10 5 15a7 7 0 0 0 14 0c0-5-7-12.5-7-12.5Z" />
    <path d="M8.5 15.5a3.5 3.5 0 0 0 5.5 2.9" />
  </svg>;
  return <PluginGlyph className={className} />;
}

function isPluginIconDataUrl(value: string | undefined): value is string {
  return typeof value === "string" && /^data:image\/svg\+xml;base64,[a-z0-9+/=]+$/iu.test(value);
}

function PluginIconImage({ entry, className = "plugin-glyph" }: { entry: PluginEntry; className?: string }) {
  const iconDataUrl = isPluginIconDataUrl(entry.installed?.iconDataUrl) ? entry.installed.iconDataUrl : isPluginIconDataUrl(entry.catalog?.iconDataUrl) ? entry.catalog.iconDataUrl : undefined;
  if (iconDataUrl) return <img className={`${className} plugin-icon-img`} src={iconDataUrl} alt="" aria-hidden="true" draggable="false" />;
  return <PluginIcon icon={pluginIcon(entry)} className={className} />;
}

function pluginIcon(entry: PluginEntry): PluginIconName {
  return entry.installed?.icon || entry.catalog?.icon || "plugin";
}

function pluginName(entry: PluginEntry): string {
  return entry.installed?.name || entry.catalog?.name || entry.id;
}

function pluginDescription(entry: PluginEntry, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (entry.installed?.brokenReason) return entry.installed.brokenReason;
  return entry.installed?.description || entry.catalog?.description || (entry.installed ? t("plugins.description.installedReady") : t("plugins.description.availableCatalog"));
}

function pluginPrimaryTone(entry: PluginEntry): keyof typeof statusPillToneClass {
  if (entry.installed?.brokenReason) return "red";
  if (entry.installed?.catalogDisabled) return "orange";
  if (entry.installed?.enabled) return "green";
  if (entry.installed) return "slate";
  return "blue";
}

function pluginPrimaryLabel(entry: PluginEntry, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (entry.installed?.brokenReason) return t("plugins.status.broken");
  if (entry.installed?.catalogDisabled) return t("plugins.status.catalogDisabled");
  if (entry.installed?.enabled) return t("plugins.status.active");
  if (entry.installed) return t("plugins.status.disabled");
  return t("plugins.status.available");
}

function mergePluginEntries(snapshot: PluginServiceSnapshot | null, catalog: PluginCatalogSnapshot | null): PluginEntry[] {
  const merged = new Map<string, PluginEntry>();
  for (const installed of snapshot?.plugins ?? []) merged.set(installed.id, { id: installed.id, installed });
  for (const catalogPlugin of catalog?.plugins ?? []) {
    const current = merged.get(catalogPlugin.id) ?? { id: catalogPlugin.id };
    merged.set(catalogPlugin.id, { ...current, catalog: catalogPlugin });
  }
  return [...merged.values()].sort((a, b) => {
    const installedDelta = Number(Boolean(b.installed)) - Number(Boolean(a.installed));
    if (installedDelta) return installedDelta;
    return pluginName(a).localeCompare(pluginName(b));
  });
}

function initialConfigValue(field: PluginConfigField): unknown {
  if (field.default !== undefined) return field.default;
  if (field.type === "boolean") return false;
  if (field.type === "number") return field.min ?? 0;
  if (field.type === "multiSelect" || field.type === "list") return [];
  return "";
}

function commandFieldToConfigField(field: PluginCommandFormField): PluginConfigField {
  return { type: field.type, label: field.label, default: field.default, options: field.options, min: field.min, max: field.max, maxLength: field.maxLength };
}

function materializeCommandDraft(form: PluginCommandForm | undefined, values: Record<string, unknown> | undefined): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const field of form?.fields ?? []) next[field.id] = values?.[field.id] ?? initialConfigValue(commandFieldToConfigField(field));
  return next;
}

function materializeListItemDefaults(schema: PluginConfigSchema, value: Record<string, unknown> = {}): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema)) next[key] = materializeConfigValue(field, value[key]);
  return next;
}

function materializeConfigValue(field: PluginConfigField, value: unknown): unknown {
  if (field.type === "list" && field.itemSchema) {
    const items = Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item)) : [];
    return items.map((item) => materializeListItemDefaults(field.itemSchema ?? {}, item));
  }
  return value ?? initialConfigValue(field);
}

function materializeConfigDraft(schema: PluginConfigSchema | undefined, config: PluginConfig | undefined): PluginConfig {
  const next: PluginConfig = {};
  for (const [key, field] of Object.entries(schema ?? {})) next[key] = materializeConfigValue(field, config?.[key]);
  return next;
}

export function computeNextRovingIndex(
  key: string,
  currentIndex: number,
  totalCount: number
): { nextIndex: number } {
  if (key === "ArrowRight" || key === "ArrowDown") {
    return { nextIndex: (currentIndex + 1) % totalCount };
  }
  if (key === "ArrowLeft" || key === "ArrowUp") {
    return { nextIndex: (currentIndex - 1 + totalCount) % totalCount };
  }
  if (key === "Home") {
    return { nextIndex: 0 };
  }
  if (key === "End") {
    return { nextIndex: totalCount - 1 };
  }
  return { nextIndex: currentIndex };
}

function ConfigFieldEditor({ pluginId, fieldKey, field, value, onChange, onPickSound, spritePreviews }: { pluginId?: string; fieldKey: string; field: PluginConfigField; value: unknown; onChange: (value: unknown) => void; onPickSound?: (pluginId: string) => Promise<void>; spritePreviews?: SafePluginRecord["spritePreviews"] }) {
  const { t } = useI18n();
  const label = field.label || fieldKey;
  const description = field.description;
  const textValue = typeof value === "string" ? value : typeof field.default === "string" ? field.default : "";

  if (field.type === "boolean") {
    return <label className="plugin-config-row plugin-config-row-boolean">
      <span><strong>{label}</strong>{description && <small>{description}</small>}</span>
      <input className="settings-toggle" type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />
    </label>;
  }

  if (field.type === "list" && field.itemSchema) {
    const items = Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item)) : [];
    const maxed = typeof field.maxItems === "number" && items.length >= field.maxItems;

    const isReminders = (pluginId === "openpets.break-buddy" || fieldKey === "reminders") && ["reminders", "breaks"].includes(fieldKey);
    const addLabel = isReminders ? t("plugins.config.addReminder") : t("plugins.config.addItem");

    return <div className="plugin-config-row">
      <span><strong>{label}</strong>{description && <small>{description}</small>}</span>
      <div className="plugin-list-editor">
        {items.map((item, index) => {
          let itemTitle = t("plugins.config.item", { index: index + 1 });
          let removeLabel = t("plugins.config.remove");

          if (isReminders) {
            removeLabel = t("plugins.config.removeReminder");
            const id = String(item.id || "").trim();
            const scheduleType = item.scheduleType;
            if (scheduleType === "daily") {
              const time = String(item.time || "09:00");
              itemTitle = t("plugins.config.dailyAt", { id: id || t("plugins.config.reminder"), time });
            } else if (scheduleType === "interval") {
              const mins = Number(item.intervalMinutes) || 60;
              itemTitle = t("plugins.config.everyMin", { id: id || t("plugins.config.reminder"), mins });
            } else if (id) {
              itemTitle = id;
            }
          }

          const schemaEntries = Object.entries(field.itemSchema ?? {});
          const messageField = schemaEntries.find(([k]) => k === "message");
          const scheduleFields = schemaEntries.filter(([k]) => ["scheduleType", "time", "days", "intervalMinutes"].includes(k));
          const behaviorFields = schemaEntries.filter(([k]) => ["id", "enabled", "reaction"].includes(k));
          const otherFields = schemaEntries.filter(([k]) => !["message", "scheduleType", "time", "days", "intervalMinutes", "id", "enabled", "reaction"].includes(k));

          const renderField = ([childKey, childField]: [string, PluginConfigField]) => {
            if (isReminders) {
              const scheduleType = item.scheduleType;
              if (scheduleType === "daily" && childKey === "intervalMinutes") return null;
              if (scheduleType === "interval" && (childKey === "time" || childKey === "days")) return null;
            }
            return <ConfigFieldEditor key={childKey} pluginId={pluginId} fieldKey={childKey} field={childField} value={item[childKey] ?? initialConfigValue(childField)} onChange={(nextValue) => onChange(items.map((existing, itemIndex) => itemIndex === index ? { ...existing, [childKey]: nextValue } : existing))} spritePreviews={spritePreviews} />;
          };

          return (
            <div className="plugin-list-item" key={index}>
              <div className="plugin-list-item-header">
                <span className="truncate mr-2">{itemTitle}</span>
                <Button variant="danger" size="compact" onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}>{removeLabel}</Button>
              </div>
              <div className="flex flex-col gap-3">
                {isReminders ? (
                  <>
                    {behaviorFields.length > 0 && (
                      <div className="plugin-config-group">
                        <div className="plugin-config-group-title">{t("plugins.config.group.identity")}</div>
                        {behaviorFields.map(renderField)}
                      </div>
                    )}
                    {messageField && (
                      <div className="plugin-config-group">
                        <div className="plugin-config-group-title">{t("plugins.config.group.message")}</div>
                        {renderField(messageField)}
                      </div>
                    )}
                    {scheduleFields.length > 0 && (
                      <div className="plugin-config-group">
                        <div className="plugin-config-group-title">{t("plugins.config.group.schedule")}</div>
                        {scheduleFields.map(renderField)}
                      </div>
                    )}
                    {otherFields.map(renderField)}
                  </>
                ) : (
                  schemaEntries.map(renderField)
                )}
              </div>
            </div>
          );
        })}
        <Button variant="secondary" size="compact" disabled={maxed} onClick={() => onChange([...items, materializeListItemDefaults(field.itemSchema ?? {})])}>{addLabel}</Button>
      </div>
    </div>;
  }

  if (field.type === "sound") {
    const soundLabel = typeof value === "string" ? (value || t("plugins.config.defaultSound")) : value && typeof value === "object" && "name" in value && typeof value.name === "string" ? value.name : t("plugins.config.defaultSound");
    return <label className="plugin-config-row">
      <span><strong>{label}</strong>{description && <small>{description}</small>}</span>
      <span className="flex items-center gap-2">
        <span className="plugin-input flex-1 truncate" aria-live="polite">{soundLabel}</span>
        <Button variant="secondary" size="compact" disabled={!pluginId || !onPickSound} onClick={() => { if (pluginId) void onPickSound?.(pluginId); }}>{t("plugins.config.browseSound")}</Button>
        <Button variant="secondary" size="compact" onClick={() => onChange("alert")}>{t("plugins.config.useDefaultSound")}</Button>
        <Button variant="secondary" size="compact" onClick={() => onChange("")}>{t("plugins.config.clearSound")}</Button>
      </span>
    </label>;
  }

  if (field.type === "select" && field.presentation === "sprite-grid") {
    const options = field.options ?? [];
    const [focusedValue, setFocusedValue] = React.useState<string>(textValue || (options[0]?.value ?? ""));
    const cardRefs = React.useRef<Map<string, HTMLDivElement | null>>(new Map());

    React.useEffect(() => {
      if (textValue) setFocusedValue(textValue);
    }, [textValue]);

    return <div className="plugin-config-row">
      <span><strong>{label}</strong>{description && <small>{description}</small>}</span>
      <div className="courier-sprite-grid" role="radiogroup" aria-label={label}>
        {options.map((option, index) => {
          const isSelected = textValue === option.value;
          const isFocused = focusedValue === option.value || (!focusedValue && index === 0);

          const spriteInfo = spritePreviews?.[option.previewSprite || ""];
          const spriteUrl = spriteInfo?.url || "";
          const frames = spriteInfo?.frames ?? 1;
          const duration = spriteInfo?.durationMs ?? 0;
          const frameWidth = spriteInfo?.frameWidth || 256;
          const frameHeight = spriteInfo?.frameHeight || 256;
          const scaleVal = 80 / frameWidth;

          const previewStyle: React.CSSProperties = {
            backgroundImage: `url("${spriteUrl}")`,
            width: `${frameWidth}px`,
            height: `${frameHeight}px`,
            backgroundSize: `${frameWidth * frames}px ${frameHeight}px`,
            transform: `scale(${scaleVal})`,
            transformOrigin: "top left",
            position: "absolute",
            top: 0,
            left: 0,
            backgroundRepeat: "repeat-x",
            backgroundPosition: "0 0",
            pointerEvents: "none",
            animationDuration: `${duration}ms`,
            animationTimingFunction: `steps(${frames})`,
          };

          const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
            const idx = options.findIndex((o) => o.value === option.value);
            const { nextIndex } = computeNextRovingIndex(event.key, idx, options.length);

            const isArrowKey = event.key === "ArrowRight" || event.key === "ArrowDown" || event.key === "ArrowLeft" || event.key === "ArrowUp";
            const isHomeEnd = event.key === "Home" || event.key === "End";

            if (isArrowKey || isHomeEnd) {
              event.preventDefault();
              const targetValue = options[nextIndex].value;
              onChange(targetValue); // ARIA: arrow navigation both focus and select next option; Home/End also select
              setFocusedValue(targetValue);
              setTimeout(() => {
                const targetEl = cardRefs.current.get(targetValue);
                targetEl?.focus();
              }, 0);
            } else if (event.key === " " || event.key === "Enter") {
              event.preventDefault();
              onChange(option.value);
            }
          };

          return (
            <div
              key={option.value}
              ref={(el) => {
                if (el) cardRefs.current.set(option.value, el);
                else cardRefs.current.delete(option.value);
              }}
              role="radio"
              aria-checked={isSelected}
              tabIndex={isFocused ? 0 : -1}
              data-courier-value={option.value}
              onFocus={() => setFocusedValue(option.value)}
              onKeyDown={handleKeyDown}
              onClick={() => onChange(option.value)}
              className={`courier-card ${isSelected ? "selected" : ""}`}
              style={{
                "--courier-total-width": `-${frameWidth * frames}px`
              } as React.CSSProperties}
            >
              <div className="courier-sprite-frame">
                {spriteUrl && (
                  <div
                    className="courier-sprite-preview"
                    style={previewStyle}
                  />
                )}
              </div>
              <div className="courier-card-meta">
                <span className="courier-card-title">{option.label || option.value}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>;
  }

  return <label className="plugin-config-row">
    <span><strong>{label}</strong>{description && <small>{description}</small>}</span>
    {field.type === "textarea" ? (
      <textarea className="plugin-input plugin-textarea" value={textValue} maxLength={field.maxLength} onChange={(event) => onChange(event.target.value)} />
    ) : field.type === "select" ? (
      <select className="settings-select plugin-select" value={textValue} onChange={(event) => onChange(event.target.value)}>
        {(field.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label || option.value}</option>)}
      </select>
    ) : field.type === "multiSelect" ? (
      <span className="plugin-chip-list">
        {(field.options ?? []).map((option) => {
          const selected = Array.isArray(value) && value.includes(option.value);
          return <button type="button" key={option.value} className={`plugin-chip ${selected ? "active" : ""}`} onClick={() => {
            const current = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
            onChange(selected ? current.filter((item) => item !== option.value) : [...current, option.value]);
          }}>{option.label || option.value}</button>;
        })}
      </span>
    ) : (
      <input className="plugin-input" type={field.type === "number" ? "number" : field.type === "time" ? "time" : field.type === "date" ? "date" : field.type === "secret" ? "password" : "text"} autoComplete={field.type === "secret" ? "off" : undefined} value={field.type === "number" && typeof value === "number" ? String(value) : textValue} min={field.min} max={field.max} step={field.step} maxLength={field.maxLength} onChange={(event) => onChange(field.type === "number" ? Number(event.target.value) : event.target.value)} />
    )}
  </label>;
}

function PathField({ label, value, placeholder, onSave, disabled }: { label: string; value: string; placeholder: string; onSave: (v: string) => void; disabled?: boolean }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-bold text-slatecopy uppercase tracking-wider">{label}</label>
      <div className="flex gap-2">
        <input
          className="plugin-input flex-1"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
        />
        <Button variant="secondary" size="compact" icon={<SaveIcon />} disabled={disabled || draft === value} onClick={() => onSave(draft)}>{t("common.save")}</Button>
      </div>
    </div>
  );
}

function IntegrationIcon({ id }: { id: string }) {
  const logos: Record<string, string> = {
    claude: claudeLogoUrl,
    codex: codexLogoUrl,
    opencode: opencodeLogoUrl,
    cursor: cursorLogoUrl,
    pi: piLogoUrl,
    vscode: vscodeLogoUrl,
    windsurf: windsurfLogoUrl,
    zed: zedLogoUrl,
  };
  const src = logos[id];
  if (src) return <img src={src} className="integration-logo" alt="" draggable="false" />;
  return <PluginGlyph />;
}

function claudeStatusTone(state: ClaudeCodeStatus["state"]): StatusTone {
  if (state === "configured") return "green";
  if (state === "error") return "red";
  if (state === "needs_setup" || state === "detected") return "blue";
  return "slate";
}

function opencodeStatusTone(state: OpenCodeSetupStatus["state"]): StatusTone {
  if (state === "configured") return "green";
  if (state === "error") return "red";
  if (state === "needs_setup") return "blue";
  return "slate";
}

function cursorStatusTone(state: CursorSetupStatus["state"]): StatusTone {
  if (state === "configured") return "green";
  if (state === "error" || state === "conflict") return "red";
  if (state === "needs_update") return "orange";
  if (state === "needs_setup") return "blue";
  return "slate";
}

function codexStatusTone(state: CodexIntegrationState): StatusTone {
  if (state === "connected") return "green";
  if (state === "conflict" || state === "unsupported") return "red";
  if (state === "needs_repair") return "orange";
  if (state === "installable" || state === "waiting_for_trust" || state === "installing") return "blue";
  return "slate";
}

function codexStatusLabel(state: CodexIntegrationState, t: (key: string) => string): string {
  const keys: Record<CodexIntegrationState, string> = {
    not_detected: "integrations.codex.status.notDetected",
    installable: "integrations.codex.status.ready",
    installing: "integrations.codex.status.installing",
    waiting_for_trust: "integrations.codex.status.waitingForTrust",
    connected: "integrations.codex.status.connected",
    needs_repair: "integrations.codex.status.needsRepair",
    conflict: "integrations.codex.status.conflict",
    unsupported: "integrations.codex.status.unsupported",
  };
  return t(keys[state]);
}

function codexTrustLabel(state: CodexIntegrationSnapshot["hooks"]["trust"], t: (key: string) => string): string {
  const keys: Record<CodexIntegrationSnapshot["hooks"]["trust"], string> = {
    missing: "integrations.codex.trust.missing",
    waiting: "integrations.codex.trust.waiting",
    trusted: "integrations.codex.trust.trusted",
    modified: "integrations.codex.trust.modified",
    unsupported: "integrations.codex.trust.unsupported",
  };
  return t(keys[state]);
}

function codexOwnershipLabel(ownership: CodexIntegrationSnapshot["managedChanges"][number]["ownership"], t: (key: string) => string): string {
  if (ownership === "read_only") return t("integrations.codex.ownership.readOnly");
  if (ownership === "legacy") return t("integrations.codex.ownership.legacy");
  return t("integrations.codex.ownership.managed");
}

function IntegrationsView() {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<AgentSetupSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ label: string; action?: AgentSetupAction | "codex-review" } | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [codexPollError, setCodexPollError] = useState("");
  const [codexReviewOpened, setCodexReviewOpened] = useState(false);

  const load = async (selectedPetId?: string, commandMode?: AgentSetupSnapshot["commandMode"]) => {
    try {
      const petId = selectedPetId === undefined ? snapshot?.selectedPetId : selectedPetId;
      const mode = commandMode === undefined ? snapshot?.commandMode : commandMode;
      const next = await api.getIntegrationsState(petId, mode);
      setSnapshot(next);
      setError("");
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    }
  };

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    if (!message) return;
    const timeout = window.setTimeout(() => setMessage(""), 3000);
    return () => window.clearTimeout(timeout);
  }, [message]);

  useEffect(() => {
    if (selectedId !== "codex" || snapshot?.codexStatus.state !== "waiting_for_trust" || busy || snapshot.busy) return;
    let cancelled = false;
    let inFlight = false;
    let consecutiveFailures = 0;

    const poll = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const next = await api.getIntegrationsState(snapshot.selectedPetId, snapshot.commandMode);
        if (cancelled) return;
        consecutiveFailures = 0;
        setCodexPollError("");
        setSnapshot(next);
        if (next.codexStatus.state === "connected") {
          setError("");
          setMessage(t("integrations.codex.approvalDetected"));
          setCodexReviewOpened(false);
          void api.completeCodexHookReview().catch(() => undefined);
        }
      } catch {
        if (cancelled) return;
        consecutiveFailures += 1;
        if (consecutiveFailures >= 2) setCodexPollError(t("integrations.codex.pollFailed"));
      } finally {
        inFlight = false;
      }
    };

    const initialPoll = window.setTimeout(() => void poll(), 1500);
    const interval = window.setInterval(() => void poll(), 3000);
    return () => {
      cancelled = true;
      window.clearTimeout(initialPoll);
      window.clearInterval(interval);
    };
  }, [selectedId, snapshot?.codexStatus.state, snapshot?.selectedPetId, snapshot?.commandMode, busy, snapshot?.busy, t]);

  useEffect(() => {
    if (snapshot?.codexStatus.state !== "waiting_for_trust") setCodexReviewOpened(false);
  }, [snapshot?.codexStatus.state]);

  const run = async (label: string, action: AgentSetupAction) => {
    try {
      setBusy({ label, action });
      setError("");
      setMessage("");
      const next = await api.runIntegrationAction(action, snapshot?.selectedPetId, snapshot?.commandMode);
      setSnapshot(next);
      if (next.lastAction) {
        if (next.lastAction.ok) setMessage(next.lastAction.message);
        else setError(next.lastAction.message);
      }
      if (action.startsWith("codex-")) {
        const refreshed = await api.getIntegrationsState(next.selectedPetId, next.commandMode);
        setSnapshot({ ...refreshed, lastAction: next.lastAction });
        window.setTimeout(() => void load(refreshed.selectedPetId, refreshed.commandMode), 1_000);
      }
    } catch (err) {
      setError(userFacingError(err));
    } finally {
      setBusy(null);
    }
  };

  const launchCodexReview = async () => {
    try {
      setBusy({ label: t("integrations.codex.openingReview"), action: "codex-review" });
      setError("");
      setMessage("");
      const result = await api.launchCodexHookReview();
      if (result.ok) {
        setCodexReviewOpened(true);
        setMessage(result.message);
      }
      else setError(result.message);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(null);
    }
  };

  const updatePath = async (key: keyof AgentSetupCommandPaths, value: string) => {
    try {
      setBusy({ label: t("integrations.busy.savingPath") });
      setError("");
      setMessage("");
      await api.updateIntegrationCommandPaths({ [key]: value });
      await load();
      setMessage(t("integrations.toast.pathSaved"));
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(null);
    }
  };

  const updateCodexReaction = async (key: keyof CodexReactionPreferences, value: boolean) => {
    try {
      setBusy({ label: t("integrations.codex.reactionsSaving") });
      setError("");
      const next = await api.updateCodexReactionPreferences({ [key]: value });
      setSnapshot(next);
      setMessage(t("integrations.codex.reactionsSaved"));
    } catch (err) {
      setError(userFacingError(err));
    } finally {
      setBusy(null);
    }
  };

  const changeCommandMode = (mode: AgentSetupSnapshot["commandMode"]) => {
    void load(snapshot?.selectedPetId, mode);
  };

  if (!snapshot) {
    return (
      <GlassCard className="flex h-64 flex-col items-center justify-center gap-4 text-center">
        <p className="text-sm font-semibold text-slatecopy">{error || t("integrations.loading")}</p>
        {error && <Button variant="secondary" size="compact" icon={<RefreshIcon />} onClick={() => void load()}>{t("common.retry")}</Button>}
      </GlassCard>
    );
  }

  const isBusy = Boolean(busy) || snapshot.busy;
  const busyAction = busy?.action;
  const integrationDialogTitleId = selectedId ? `integration-detail-title-${selectedId}` : undefined;

  const integrations = [
    { id: "claude", name: t("integrations.claude.name"), icon: "claude", status: snapshot.status.label, tone: claudeStatusTone(snapshot.status.state), description: t("integrations.claude.description") },
    { id: "codex", name: t("integrations.codex.name"), icon: "codex", status: codexStatusLabel(snapshot.codexStatus.state, t), tone: codexStatusTone(snapshot.codexStatus.state), description: t("integrations.codex.description") },
    { id: "opencode", name: t("integrations.opencode.name"), icon: "opencode", status: snapshot.opencodeStatus.label, tone: opencodeStatusTone(snapshot.opencodeStatus.state), description: t("integrations.opencode.description") },
    { id: "cursor", name: t("integrations.cursor.name"), icon: "cursor", status: snapshot.cursorStatus.label, tone: cursorStatusTone(snapshot.cursorStatus.state), description: t("integrations.cursor.description") },
    { id: "pi", name: t("integrations.pi.name"), icon: "pi", status: t("integrations.pi.status"), tone: "blue" satisfies StatusTone, description: t("integrations.pi.description") },
  ] as const;

  const soon = [
    { name: t("integrations.soon.vscode"), icon: "vscode" },
    { name: t("integrations.soon.windsurf"), icon: "windsurf" },
    { name: t("integrations.soon.zed"), icon: "zed" },
  ];

  const selectedIntegrationName = selectedId === "pi" ? t("integrations.pi.name") : integrations.find((item) => item.id === selectedId)?.name;
  const visibleCodexChanges = snapshot.codexStatus.managedChanges.filter((change) => change.id !== "legacy-plugin" || change.present);

  return (
    <div className="flex flex-col gap-6 h-full overflow-y-auto pr-2">
      {error && <div className="error">{error}</div>}
      {message && <div className="settings-success settings-message">{message}</div>}

      <div className="integration-grid">
        {integrations.map((item) => (
          <article key={item.id} className={`integration-card ${selectedId === item.id ? "border-brand ring-4 ring-brand/15" : ""}`}>
            <div className="plugin-card-body">
              <div className="integration-icon">
                <IntegrationIcon id={item.icon} />
              </div>
              <div className="plugin-card-content">
                <div className="flex items-center justify-between">
                  <strong>{item.name}</strong>
                  <StatusPill tone={item.tone}>{item.status}</StatusPill>
                </div>
                <small>{item.description}</small>
              </div>
            </div>
            <div className="plugin-card-footer">
              <div className="flex gap-2 w-full">
                {item.id === "claude" && snapshot.status.canConfigure && <Button variant="primary" size="compact" icon={<InstallIcon />} disabled={isBusy} onClick={() => run(t("integrations.busy.installing"), "configure")}>{t("integrations.install")}</Button>}
                {item.id === "codex" && snapshot.codexStatus.canInstall && <Button variant="primary" size="compact" icon={<InstallIcon />} disabled={isBusy} onClick={() => { setSelectedId("codex"); void run(t("integrations.codex.connecting"), "codex-install"); }}>{busyAction === "codex-install" ? t("integrations.codex.connecting") : t("integrations.connect")}</Button>}
                {item.id === "opencode" && snapshot.opencodeStatus.canInstall && <Button variant="primary" size="compact" icon={<InstallIcon />} disabled={isBusy} onClick={() => run(t("integrations.busy.installing"), "opencode-install")}>{t("integrations.install")}</Button>}
                {item.id === "cursor" && snapshot.cursorStatus.canInstall && <Button variant="primary" size="compact" icon={<InstallIcon />} disabled={isBusy} onClick={() => run(t("integrations.busy.installing"), "cursor-install")}>{t("integrations.install")}</Button>}
                <Button variant="secondary" size="compact" icon={<ConfigureIcon />} fullWidth={item.id === "pi"} onClick={() => setSelectedId(item.id)}>{item.id === "pi" ? t("integrations.viewSetup") : t("integrations.configure")}</Button>
              </div>
            </div>
          </article>
        ))}
        {soon.map((item) => (
          <article key={item.name} className="integration-card opacity-60">
            <div className="plugin-card-body">
              <div className="integration-icon grayscale">
                <IntegrationIcon id={item.icon} />
              </div>
              <div className="plugin-card-content">
                <div className="flex items-center justify-between">
                  <strong>{item.name}</strong>
                  <StatusPill tone="slate">{t("integrations.soon.status")}</StatusPill>
                </div>
                <small>{t("integrations.soon.description")}</small>
              </div>
            </div>
            <div className="plugin-card-footer">
              <Button variant="secondary" size="compact" fullWidth disabled>{t("integrations.soon.button")}</Button>
            </div>
          </article>
        ))}
      </div>

      {selectedId && (
        <div className="plugin-config-overlay" role="dialog" aria-modal="true" aria-labelledby={integrationDialogTitleId}>
          <button className="plugin-config-backdrop" type="button" aria-label={t("integrations.closeAria")} onClick={() => setSelectedId(null)} />
          <GlassCard className="plugin-inspector">
            <div className="plugin-inspector-head">
              <div className="plugin-inspector-icon">
                <IntegrationIcon id={selectedId} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="eyebrow">{t("integrations.detail")}</p>
                <h2 id={integrationDialogTitleId}>{selectedIntegrationName}</h2>
              </div>
              <Button variant="secondary" size="compact" icon={<CloseIcon />} onClick={() => setSelectedId(null)}>{t("integrations.close")}</Button>
            </div>

            <div className="flex flex-col gap-5 mt-4">
              {selectedId !== "pi" && selectedId !== "codex" && (
                <section className="plugin-section">
                  <div className="plugin-section-title"><small>{t("integrations.commandSource")}</small><strong>{t("integrations.cliMode")}</strong></div>
                  <select className="settings-select w-full" value={snapshot.commandMode} disabled={isBusy} onChange={(event) => changeCommandMode(event.target.value as AgentSetupSnapshot["commandMode"])}>
                    <option value="published">{t(commandModeLabelKeys.published)}</option>
                    <option value="bundled">{t(commandModeLabelKeys.bundled)}</option>
                    <option value="local" disabled={!snapshot.localDevAvailable}>{t(commandModeLabelKeys.local)}{snapshot.localDevAvailable ? "" : t("integrations.localUnavailable")}</option>
                  </select>
                  <p className="text-xs text-slatecopy mt-2">{t("integrations.commandModeHelp")}</p>
                </section>
              )}

              {selectedId === "claude" && (
                <>
                  <section className="plugin-section">
                    <div className="plugin-section-title"><small>{t("integrations.connection")}</small><strong>{t("integrations.statusRouting")}</strong></div>
                    <div className="flex items-center justify-between p-3 rounded-2xl bg-blue-50/50 border border-blue-100/50">
                      <div className="flex flex-col">
                        <strong className="text-sm text-navy">{snapshot.status.label}</strong>
                        <small className="text-xs text-slatecopy">{snapshot.status.details}</small>
                      </div>
                      <StatusPill tone={claudeStatusTone(snapshot.status.state)}>{snapshot.status.state}</StatusPill>
                    </div>
                    <div className="mt-2">
                      <label className="text-xs font-bold text-slatecopy uppercase tracking-wider mb-1 block">{t("integrations.petRouting")}</label>
                      <select
                        className="settings-select w-full"
                        value={snapshot.selectedPetId || ""}
                        onChange={(e) => void load(e.target.value)}
                        disabled={isBusy}
                      >
                        <option value="">{t("integrations.defaultPet")}</option>
                        {snapshot.petOptions.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}
                      </select>
                    </div>
                  </section>

                  <section className="plugin-section">
                    <div className="plugin-section-title"><small>{t("integrations.configuration")}</small><strong>{t("integrations.commandPaths")}</strong></div>
                    <div className="flex flex-col gap-3">
                      <PathField label={t("integrations.claudeCommand")} value={snapshot.commandPaths.claude} placeholder="claude" onSave={(v) => updatePath("claude", v)} disabled={isBusy} />
                      <PathField label={t("integrations.nodeCommand")} value={snapshot.commandPaths.node} placeholder="node" onSave={(v) => updatePath("node", v)} disabled={isBusy} />
                    </div>
                  </section>

                  <div className="grid grid-cols-2 gap-3">
                    <section className="plugin-section">
                      <div className="plugin-section-title"><small>{t("integrations.optional")}</small><strong>{t("integrations.claudeHooks")}</strong></div>
                      <div className="flex items-center justify-between mb-2">
                        <StatusPill tone={snapshot.hookStatus.status === "installed" ? "green" : "blue"}>{snapshot.hookStatus.status}</StatusPill>
                      </div>
                    <div className="flex flex-col gap-2">
                      <Button variant="primary" size="compact" icon={<HookIcon />} disabled={isBusy} onClick={() => run(t("integrations.busy.installingHooks"), "install-hooks")}>{t("integrations.installHooks")}</Button>
                      <Button variant="danger" size="compact" icon={<RemoveIcon />} disabled={isBusy || snapshot.hookStatus.status === "needs_setup"} onClick={() => run(t("integrations.busy.removingHooks"), "uninstall-hooks")}>{t("integrations.removeHooks")}</Button>
                    </div>
                  </section>
                  <section className="plugin-section">
                    <div className="plugin-section-title"><small>{t("integrations.included")}</small><strong>{t("integrations.instructions")}</strong></div>
                    <div className="flex items-center justify-between mb-2">
                      <StatusPill tone={snapshot.memoryStatus.state === "installed" ? "green" : "blue"}>{snapshot.memoryStatus.state}</StatusPill>
                    </div>
                    <Button variant="secondary" size="compact" icon={<MemoryIcon />} disabled={isBusy} onClick={() => run(t("integrations.busy.updatingInstructions"), "install-memory")}>{t("integrations.updateInstructions")}</Button>
                  </section>
                </div>

                <section className="plugin-section">
                  <div className="plugin-section-title"><small>{t("integrations.actions")}</small><strong>{t("integrations.management")}</strong></div>
                  <div className="grid grid-cols-2 gap-2">
                    {snapshot.status.canConfigure && <Button variant="primary" icon={<InstallIcon />} disabled={isBusy} onClick={() => run(t("integrations.busy.installing"), "configure")}>{t("integrations.installMcp")}</Button>}
                    {snapshot.status.canReplace && <Button variant="warning" icon={<ReplaceIcon />} disabled={isBusy} onClick={() => run(t("integrations.busy.replacing"), "replace")}>{t("integrations.replaceMcp")}</Button>}
                    {snapshot.status.canRemove && <Button variant="danger" icon={<RemoveIcon />} disabled={isBusy} onClick={() => run(t("integrations.busy.removing"), "remove")}>{t("integrations.removeMcp")}</Button>}
                    <Button variant="secondary" icon={<RefreshIcon />} disabled={isBusy} onClick={() => void load()}>{t("integrations.refreshStatus")}</Button>
                  </div>
                </section>


                  <details className="plugin-section group">
                    <summary className="cursor-pointer list-none flex items-center justify-between">
                      <div className="plugin-section-title"><small>{t("integrations.advanced")}</small><strong>{t("integrations.mcpJsonPreview")}</strong></div>
                      <span className="text-brand group-open:rotate-180 transition-transform"><NextIcon /></span>
                    </summary>
                    <pre className="mt-3 p-3 rounded-xl bg-navy/5 text-[10px] font-mono overflow-x-auto border border-navy/5">
                      {JSON.stringify(snapshot.preview.mcpJson, null, 2)}
                    </pre>
                  </details>

                </>
              )}

              {selectedId === "codex" && (
                <>
                  <section className="plugin-section codex-connection-card">
                    <div className="flex items-start justify-between gap-4">
                      <div className="plugin-section-title min-w-0">
                        <small>{t("integrations.connection")}</small>
                        <strong>{codexStatusLabel(snapshot.codexStatus.state, t)}</strong>
                        <p className="text-xs text-slatecopy mt-1">{snapshot.codexStatus.message}</p>
                      </div>
                      <StatusPill tone={codexStatusTone(snapshot.codexStatus.state)}>{codexStatusLabel(snapshot.codexStatus.state, t)}</StatusPill>
                    </div>

                    <div className="codex-detection-grid">
                      <div><small>{t("integrations.codex.detectedVersion")}</small><strong>{snapshot.codexStatus.version || "—"}</strong></div>
                      <div className="min-w-0"><small>{t("integrations.codex.location")}</small><strong className="break-all">{snapshot.codexStatus.location || snapshot.codexStatus.command || t("integrations.codex.detectedAutomatically")}</strong></div>
                    </div>

                    <div className="codex-status-facts">
                      <div><span>{t("integrations.codex.hookTrust")}</span><StatusPill tone={snapshot.codexStatus.hooks.trust === "trusted" ? "green" : snapshot.codexStatus.hooks.trust === "modified" ? "orange" : "blue"}>{codexTrustLabel(snapshot.codexStatus.hooks.trust, t)}</StatusPill></div>
                      <div><span>{t("integrations.codex.lastEvent")}</span><strong>{snapshot.codexLastEvent ? `${snapshot.codexLastEvent.lifecycle} · ${new Date(snapshot.codexLastEvent.receivedAt).toLocaleString()}` : t("integrations.codex.noEvents")}</strong></div>
                    </div>

                    <div className="flex flex-col gap-2">
                      <strong className="text-sm">{t("integrations.codex.connectionChecks")}</strong>
                      {(snapshot.codexStatus.checks ?? []).map((check) => (
                        <div className="flex items-start justify-between gap-3 p-3 rounded-xl bg-navy/5 border border-navy/5" key={check.id}>
                          <div className="min-w-0"><strong className="text-sm">{check.message}</strong>{check.detail && <small className="block text-slatecopy mt-1 break-all">{check.detail}</small>}</div>
                          <StatusPill tone={check.state === "ok" ? "green" : check.state === "waiting" ? "blue" : check.state === "unsupported" || check.state === "error" ? "red" : "orange"}>{check.state === "ok" ? t("integrations.codex.checkOk") : check.state === "waiting" ? t("integrations.codex.checkWaiting") : t("integrations.codex.checkAction")}</StatusPill>
                        </div>
                      ))}
                    </div>

                    <div className="codex-action-bar">
                      {snapshot.codexStatus.canInstall && <Button variant="primary" icon={<InstallIcon />} disabled={isBusy} onClick={() => run(t("integrations.codex.connecting"), "codex-install")}>{busyAction === "codex-install" ? t("integrations.codex.connecting") : t("integrations.connect")}</Button>}
                      {snapshot.codexStatus.canRepair && <Button variant="warning" icon={<ReplaceIcon />} disabled={isBusy} onClick={() => run(t("integrations.codex.repairing"), "codex-repair")}>{busyAction === "codex-repair" ? t("integrations.codex.repairing") : t("integrations.repair")}</Button>}
                      {snapshot.codexStatus.canDisconnect && <Button variant="danger" icon={<RemoveIcon />} disabled={isBusy} onClick={() => run(t("integrations.codex.removing"), "codex-disconnect")}>{busyAction === "codex-disconnect" ? t("integrations.codex.removing") : t("integrations.disconnect")}</Button>}
                      <Button variant="secondary" icon={<RefreshIcon />} disabled={isBusy} onClick={() => run(t("integrations.codex.refreshing"), "codex-refresh")}>{busyAction === "codex-refresh" ? t("integrations.codex.refreshing") : t("integrations.refreshStatus")}</Button>
                    </div>
                    <p className="text-xs text-slatecopy">{t("integrations.codex.connectHelp")}</p>

                    {selectedId === "codex" && error && <div className="error m-0" role="alert">{error}</div>}
                    {selectedId === "codex" && message && <div className="settings-success settings-message m-0" role="status">{message}</div>}

                    {snapshot.codexStatus.state === "waiting_for_trust" && (
                      <div className="codex-approval-callout">
                        <strong>{t("integrations.codex.approvalTitle")}</strong>
                        <p>{t("integrations.codex.approvalIntro")}</p>
                        <ol className="codex-approval-guide">
                          <li><span>1</span><p>{t("integrations.codex.approvalUpdate")}</p></li>
                          <li><span>2</span><p>{t("integrations.codex.approvalExactSix")}</p></li>
                          <li><span>3</span><p>{t("integrations.codex.approvalDone")}</p></li>
                        </ol>
                        {codexReviewOpened ? (
                          <div className="codex-review-opened" role="status">
                            <strong>{t("integrations.codex.terminalOpened")}</strong>
                            <p>{t("integrations.codex.terminalOpenedHelp")}</p>
                            <Button variant="secondary" size="compact" disabled={isBusy} onClick={() => void launchCodexReview()}>{t("integrations.codex.openAgain")}</Button>
                          </div>
                        ) : (
                          <div className="codex-approval-actions">
                            <Button variant="primary" icon={<HookIcon />} fullWidth disabled={isBusy} onClick={() => void launchCodexReview()}>{busyAction === "codex-review" ? t("integrations.codex.openingReview") : t("integrations.codex.reviewInCodex")}</Button>
                          </div>
                        )}
                        <p>{t("integrations.codex.approvalDifferentCount")}</p>
                        {codexPollError && <p className="codex-approval-poll-error" role="status">{codexPollError}</p>}
                        <p className="codex-approval-note">{t("integrations.codex.trustHelp")}</p>
                      </div>
                    )}
                  </section>

                  <section className="plugin-section">
                    <div className="plugin-section-title"><small>{t("integrations.codex.capabilities")}</small><strong>{t("integrations.codex.whatThisEnables")}</strong><p>{t("integrations.codex.reactionsDescription")}</p></div>
                    <div className="settings-group">
                      <ToggleRow title={t("integrations.codex.reactionStarted")} description={t("integrations.codex.reactionStartedDescription")} checked={snapshot.codexReactionPreferences.taskStarted} disabled={isBusy} onChange={(value) => void updateCodexReaction("taskStarted", value)} />
                      <ToggleRow title={t("integrations.codex.reactionWorking")} description={t("integrations.codex.reactionWorkingDescription")} checked={snapshot.codexReactionPreferences.taskWorking} disabled={isBusy} onChange={(value) => void updateCodexReaction("taskWorking", value)} />
                      <ToggleRow title={t("integrations.codex.reactionCompleted")} description={t("integrations.codex.reactionCompletedDescription")} checked={snapshot.codexReactionPreferences.taskCompleted} disabled={isBusy} onChange={(value) => void updateCodexReaction("taskCompleted", value)} />
                    </div>
                    <div className="codex-capability-grid mt-4">
                      <div className="codex-capability-card codex-capability-card-wide">
                        <strong>{t("integrations.codex.petControls")}</strong>
                        <p>{t("integrations.codex.petControlsDescription")}</p>
                        <small>{t("integrations.codex.petControlsExample")}</small>
                      </div>
                    </div>
                  </section>

                  <details className="plugin-section group">
                    <summary className="cursor-pointer list-none flex items-center justify-between">
                      <div className="plugin-section-title"><small>{t("integrations.codex.transparency")}</small><strong>{t("integrations.codex.whatChanges")}</strong></div>
                      <span className="text-brand group-open:rotate-180 transition-transform"><NextIcon /></span>
                    </summary>
                    <p className="text-xs text-slatecopy">{t("integrations.codex.whatChangesHelp")}</p>
                    <div className="flex flex-col gap-3 mt-3">
                      {visibleCodexChanges.map((change) => <div key={change.id} className="p-3 rounded-xl bg-navy/5 border border-navy/5"><div className="flex justify-between gap-3"><strong className="text-sm">{change.title}</strong><StatusPill tone={change.present ? "green" : "slate"}>{change.present ? codexOwnershipLabel(change.ownership, t) : t("integrations.codex.willManage")}</StatusPill></div><small className="block text-slatecopy font-mono mt-1">{change.path}</small><p className="text-xs mt-2">{change.detail}</p></div>)}
                    </div>
                  </details>

                  <details className="plugin-section group">
                    <summary className="cursor-pointer list-none flex items-center justify-between">
                      <div className="plugin-section-title"><small>{t("integrations.advanced")}</small><strong>{t("integrations.codex.troubleshooting")}</strong></div>
                      <span className="text-brand group-open:rotate-180 transition-transform"><NextIcon /></span>
                    </summary>
                    <p className="text-xs text-slatecopy">{t("integrations.codex.commandPathsHelp")}</p>
                    <div className="flex flex-col gap-3 mt-2">
                      <PathField label={t("integrations.codexCommand")} value={snapshot.commandPaths.codex} placeholder={t("integrations.codex.detectedAutomatically")} onSave={(v) => updatePath("codex", v)} disabled={isBusy} />
                      <PathField label={t("integrations.nodeCommand")} value={snapshot.commandPaths.node} placeholder={t("integrations.codex.detectedAutomatically")} onSave={(v) => updatePath("node", v)} disabled={isBusy} />
                    </div>
                  </details>
                </>
              )}

              {selectedId === "opencode" && (
                <>
                  <section className="plugin-section">
                    <div className="plugin-section-title"><small>{t("integrations.connection")}</small><strong>{t("integrations.globalSetup")}</strong></div>
                    <div className="flex items-center justify-between p-3 rounded-2xl bg-blue-50/50 border border-blue-100/50">
                      <div className="flex flex-col">
                        <strong className="text-sm text-navy">{snapshot.opencodeStatus.label}</strong>
                        <small className="text-xs text-slatecopy">{snapshot.opencodeStatus.details}</small>
                      </div>
                      <StatusPill tone={opencodeStatusTone(snapshot.opencodeStatus.state)}>{snapshot.opencodeStatus.state}</StatusPill>
                    </div>
                    <div className="mt-2">
                      <label className="text-xs font-bold text-slatecopy uppercase tracking-wider mb-1 block">{t("integrations.petRouting")}</label>
                      <select
                        className="settings-select w-full"
                        value={snapshot.selectedPetId || ""}
                        onChange={(e) => void load(e.target.value)}
                        disabled={isBusy}
                      >
                        <option value="">{t("integrations.defaultPet")}</option>
                        {snapshot.petOptions.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}
                      </select>
                    </div>
                  </section>

                  <section className="plugin-section">
                    <div className="plugin-section-title"><small>{t("integrations.configuration")}</small><strong>{t("integrations.commandPaths")}</strong></div>
                    <div className="flex flex-col gap-3">
                      <PathField label={t("integrations.opencodeCommand")} value={snapshot.commandPaths.opencode} placeholder="opencode" onSave={(v) => updatePath("opencode", v)} disabled={isBusy} />
                      <PathField label={t("integrations.nodeCommand")} value={snapshot.commandPaths.node} placeholder="node" onSave={(v) => updatePath("node", v)} disabled={isBusy} />
                    </div>
                  </section>

                  <section className="plugin-section">
                    <div className="plugin-section-title"><small>{t("integrations.actions")}</small><strong>{t("integrations.management")}</strong></div>
                    <div className="grid grid-cols-2 gap-2">
                      {snapshot.opencodeStatus.canInstall && <Button variant="primary" icon={<InstallIcon />} disabled={isBusy} onClick={() => run(t("integrations.busy.installing"), "opencode-install")}>{t("integrations.installGlobal")}</Button>}
                      {snapshot.opencodeStatus.canRemove && <Button variant="danger" icon={<RemoveIcon />} disabled={isBusy} onClick={() => run(t("integrations.busy.removing"), "opencode-remove")}>{t("integrations.removeGlobal")}</Button>}
                      <Button variant="secondary" icon={<RefreshIcon />} disabled={isBusy} onClick={() => void load()}>{t("integrations.refreshStatus")}</Button>
                    </div>
                  </section>

                  <details className="plugin-section group">
                    <summary className="cursor-pointer list-none flex items-center justify-between">
                      <div className="plugin-section-title"><small>{t("integrations.advanced")}</small><strong>{t("integrations.configPreview")}</strong></div>
                      <span className="text-brand group-open:rotate-180 transition-transform"><NextIcon /></span>
                    </summary>
                    <pre className="mt-3 p-3 rounded-xl bg-navy/5 text-[10px] font-mono overflow-x-auto border border-navy/5">
                      {JSON.stringify(snapshot.opencodePreview.configPreview, null, 2)}
                    </pre>
                  </details>
                </>
              )}

              {selectedId === "cursor" && (
                <>
                  <section className="plugin-section">
                    <div className="plugin-section-title"><small>{t("integrations.connection")}</small><strong>{t("integrations.globalMcp")}</strong></div>
                    <div className="flex items-center justify-between p-3 rounded-2xl bg-blue-50/50 border border-blue-100/50">
                      <div className="flex flex-col">
                        <strong className="text-sm text-navy">{snapshot.cursorStatus.label}</strong>
                        <small className="text-xs text-slatecopy">{snapshot.cursorStatus.details}</small>
                      </div>
                      <StatusPill tone={cursorStatusTone(snapshot.cursorStatus.state)}>{snapshot.cursorStatus.state}</StatusPill>
                    </div>
                    <div className="mt-2">
                      <label className="text-xs font-bold text-slatecopy uppercase tracking-wider mb-1 block">{t("integrations.petRouting")}</label>
                      <select
                        className="settings-select w-full"
                        value={snapshot.selectedPetId || ""}
                        onChange={(e) => void load(e.target.value)}
                        disabled={isBusy}
                      >
                        <option value="">{t("integrations.defaultPet")}</option>
                        {snapshot.petOptions.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}
                      </select>
                    </div>
                  </section>

                  <section className="plugin-section">
                    <div className="plugin-section-title"><small>{t("integrations.actions")}</small><strong>{t("integrations.management")}</strong></div>
                    <div className="grid grid-cols-2 gap-2">
                      {snapshot.cursorStatus.canInstall && <Button variant="primary" icon={<InstallIcon />} disabled={isBusy} onClick={() => run(t("integrations.busy.installing"), "cursor-install")}>{t("integrations.installMcp")}</Button>}
                      {snapshot.cursorStatus.canReplace && <Button variant="warning" icon={<ReplaceIcon />} disabled={isBusy} onClick={() => run(t("integrations.busy.replacing"), "cursor-replace")}>{t("integrations.replaceMcp")}</Button>}
                      {snapshot.cursorStatus.canRemove && <Button variant="danger" icon={<RemoveIcon />} disabled={isBusy} onClick={() => run(t("integrations.busy.removing"), "cursor-remove")}>{t("integrations.removeMcp")}</Button>}
                      <Button variant="secondary" icon={<RefreshIcon />} disabled={isBusy} onClick={() => void load()}>{t("integrations.refreshStatus")}</Button>
                    </div>
                  </section>


                  <details className="plugin-section group">
                    <summary className="cursor-pointer list-none flex items-center justify-between">
                      <div className="plugin-section-title"><small>{t("integrations.advanced")}</small><strong>{t("integrations.mcpEntryPreview")}</strong></div>
                      <span className="text-brand group-open:rotate-180 transition-transform"><NextIcon /></span>
                    </summary>
                    <pre className="mt-3 p-3 rounded-xl bg-navy/5 text-[10px] font-mono overflow-x-auto border border-navy/5">
                      {JSON.stringify({ mcpServers: snapshot.cursorPreview.mcpEntry }, null, 2)}
                    </pre>
                  </details>

                  <details className="plugin-section group">
                    <summary className="cursor-pointer list-none flex items-center justify-between">
                      <div className="plugin-section-title"><small>{t("integrations.advanced")}</small><strong>{t("integrations.rulesPreview")}</strong></div>
                      <span className="text-brand group-open:rotate-180 transition-transform"><NextIcon /></span>
                    </summary>
                    <p className="mt-3 text-xs text-slatecopy">{snapshot.cursorPreview.rulesPath}</p>
                    <pre className="mt-3 p-3 rounded-xl bg-navy/5 text-[10px] font-mono overflow-x-auto border border-navy/5">
                      {snapshot.cursorPreview.rulesContent}
                    </pre>
                  </details>
                </>
              )}

              {selectedId === "pi" && (
                <section className="plugin-section">
                  <div className="plugin-section-title"><small>{t("integrations.pi.manualSetup")}</small><strong>{t("integrations.pi.extension")}</strong></div>
                  <p className="text-sm text-slatecopy leading-relaxed">
                    {t("integrations.pi.intro")}
                  </p>
                  <div className="mt-3 p-4 rounded-2xl bg-navy/5 border border-navy/5 flex flex-col gap-3">
                    <div className="flex flex-col gap-1">
                      <span className="text-[10px] font-bold text-slatecopy uppercase tracking-wider">{t("integrations.pi.globalInstall")}</span>
                      <code className="bg-white px-2 py-1 rounded border border-blue-100 text-brand text-xs">pi install npm:@open-pets/pi</code>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-[10px] font-bold text-slatecopy uppercase tracking-wider">{t("integrations.pi.projectInstall")}</span>
                      <code className="bg-white px-2 py-1 rounded border border-blue-100 text-brand text-xs">pi install -l npm:@open-pets/pi</code>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-[10px] font-bold text-slatecopy uppercase tracking-wider">{t("integrations.pi.remove")}</span>
                      <code className="bg-white px-2 py-1 rounded border border-blue-100 text-brand text-xs">pi remove npm:@open-pets/pi</code>
                    </div>
                  </div>
                  <div className="mt-3 p-4 rounded-2xl bg-blue-50/50 border border-blue-100/60 flex flex-col gap-2">
                    <span className="text-[10px] font-bold text-slatecopy uppercase tracking-wider">{t("integrations.pi.slashCommands")}</span>
                    <code className="bg-white px-2 py-1 rounded border border-blue-100 text-brand text-xs">/openpets status</code>
                    <code className="bg-white px-2 py-1 rounded border border-blue-100 text-brand text-xs">/openpets test</code>
                    <code className="bg-white px-2 py-1 rounded border border-blue-100 text-brand text-xs">/openpets react &lt;reaction&gt;</code>
                    <code className="bg-white px-2 py-1 rounded border border-blue-100 text-brand text-xs">/openpets say &lt;message&gt;</code>
                  </div>
                  <p className="text-xs text-slatecopy mt-2">
                    {t("integrations.pi.outro")}
                  </p>
                </section>
              )}
            </div>
          </GlassCard>
        </div>
      )}
    </div>
  );
}

function PluginsView() {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<PluginServiceSnapshot | null>(null);
  const [catalog, setCatalog] = useState<PluginCatalogSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [filter, setFilter] = useState<PluginFilter>("all");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [configDraft, setConfigDraft] = useState<PluginConfig>({});
  const [commandDrafts, setCommandDrafts] = useState<Record<string, Record<string, unknown>>>({});
  const [activeCommandId, setActiveCommandId] = useState("");
  const [showDeveloperMode, setShowDeveloperMode] = useState(false);

  async function load(refreshCatalog = false, clearMessages = true) {
    if (clearMessages) setError("");
    const [nextSnapshot, nextCatalog] = await Promise.all([
      api.getPluginsSnapshot(),
      api.getPluginCatalogSnapshot(refreshCatalog).catch(() => ({ plugins: [] } as PluginCatalogSnapshot)),
    ]);
    setSnapshot(nextSnapshot);
    setCatalog(nextCatalog);
    const entries = mergePluginEntries(nextSnapshot, nextCatalog);
    setSelectedId((current) => entries.some((entry) => entry.id === current) ? current : "");
  }

  useEffect(() => { void load().catch((err) => setError(String(err?.message ?? err))); }, []);
  // Re-fetch plugin records when the host locale changes so `$t:` labels re-render translated.
  useEffect(() => api.onPluginsRefresh(() => { void load(false, false).catch((err) => setError(String(err?.message ?? err))); }), []);
  useEffect(() => {
    if (!message) return;
    const timeout = window.setTimeout(() => setMessage(""), 2200);
    return () => window.clearTimeout(timeout);
  }, [message]);

  const entries = useMemo(() => mergePluginEntries(snapshot, catalog), [snapshot, catalog]);
  const selected = entries.find((entry) => entry.id === selectedId);
  const installed = selected?.installed;
  const catalogPlugin = selected?.catalog;
  const hasConfigFields = Boolean(installed?.configSchema && Object.keys(installed.configSchema).length > 0);
  const activeCommand = installed?.commands?.find((command) => command.id === activeCommandId);

  useEffect(() => { setConfigDraft(materializeConfigDraft(installed?.configSchema, installed?.effectiveConfig)); }, [installed?.id, installed?.configSchema, installed?.effectiveConfig]);
  useEffect(() => { setCommandDrafts({}); setActiveCommandId(""); }, [installed?.id]);

  const filteredEntries = useMemo(() => {
    return entries.filter((entry) => {
      if (filter === "installed" && !entry.installed) return false;
      if (filter === "catalog" && entry.installed) return false;
      if (filter === "local" && entry.installed?.source !== "local") return false;
      if (filter === "broken" && !entry.installed?.brokenReason) return false;
      return true;
    });
  }, [entries, filter]);

  async function run(label: string, fn: () => Promise<void>) {
    try { setBusy(label); setError(""); setMessage(""); await fn(); }
    catch (err) { setError(String((err as Error)?.message ?? err)); }
    finally { setBusy(""); }
  }

  function applyResult(result: PluginServiceResult, success?: string) {
    setSnapshot(result.snapshot);
    if (!result.ok) { setError(result.error); return false; }
    if (success) setMessage(success);
    return true;
  }

  function updateDraft(key: string, value: unknown) {
    setConfigDraft((current) => ({ ...current, [key]: value }));
  }

  function updateCommandDraft(commandId: string, key: string, value: unknown) {
    setCommandDrafts((current) => ({ ...current, [commandId]: { ...(current[commandId] ?? {}), [key]: value } }));
  }

  async function pickConfigSound(pluginId: string, key: string) {
    try {
      setError("");
      const result = await api.pickPluginConfigSound(pluginId);
      if (!result.ok) { setSnapshot(result.snapshot); setError(result.error); return; }
      if (!result.sound.id) { setSnapshot(result.snapshot); return; }
      updateDraft(key, result.sound);
      setMessage(t("plugins.toast.soundImported"));
    } catch (err) { setError(String((err as Error)?.message ?? err)); }
  }

  async function installCatalogEntry(entry: PluginEntry) {
    const result = await api.installCatalogPlugin(entry.id);
    if (!applyResult(result)) return;
    const installedPlugin = result.snapshot.plugins.find((plugin) => plugin.id === entry.id);
    if (!installedPlugin) { setMessage(t("plugins.toast.noPluginInstalled")); return; }
    await load(false, false);
    setMessage(t("plugins.toast.pluginInstalled"));
  }

  async function updateCatalogEntry(plugin: SafePluginRecord) {
    const previousVersion = plugin.version;
    const result = await api.updateCatalogPlugin(plugin.id);
    if (!applyResult(result)) return;
    const updatedPlugin = result.snapshot.plugins.find((nextPlugin) => nextPlugin.id === plugin.id);
    setMessage(updatedPlugin && updatedPlugin.version !== previousVersion ? t("plugins.toast.pluginUpdated") : t("plugins.toast.noPluginUpdate"));
  }

  return (
    <div className="plugins-layout">
      {error && <div className="error settings-message">{error}</div>}
      {message && <div className="settings-success settings-message">{message}</div>}
      <div className={`plugin-developer-panel ${showDeveloperMode ? "open" : ""}`}>
        <button className="plugin-developer-toggle" type="button" onClick={() => setShowDeveloperMode((open) => !open)} aria-expanded={showDeveloperMode}>
          <span>{t("plugins.developer.eyebrow")}</span>
          <small>{showDeveloperMode ? t("plugins.developer.hide") : t("plugins.developer.show")}</small>
        </button>
        {showDeveloperMode && <div className="plugin-developer-body">
          <p>{t("plugins.developer.description")}</p>
          <Button variant="secondary" size="compact" icon={<FolderPlusIcon />} disabled={!!busy} onClick={() => void run(t("plugins.busy.loading"), async () => {
            const beforeIds = new Set(snapshot?.plugins.map((plugin) => plugin.id) ?? []);
            const result = await api.loadLocalPlugin();
            if (!applyResult(result)) return;
            const loadedPlugin = result.snapshot.plugins.find((plugin) => plugin.source === "local" && !beforeIds.has(plugin.id));
            setMessage(loadedPlugin ? t("plugins.toast.localLoaded") : t("plugins.toast.noLocalLoaded"));
          })}>{t("plugins.developer.loadUnpacked")}</Button>
        </div>}
      </div>
      <GlassCard className="plugins-hub">
        <div className="filters">
          {(["all", "installed", "catalog", "local", "broken"] as PluginFilter[]).map((nextFilter) => (
            <button key={nextFilter} className={`filter ${filter === nextFilter ? "active" : ""}`} onClick={() => setFilter(nextFilter)}>{t(pluginFilterLabelKeys[nextFilter])}</button>
          ))}
        </div>
        <div className="plugin-grid">
          {filteredEntries.map((entry) => (
            <article key={entry.id} className={`plugin-card ${entry.installed?.brokenReason ? "broken" : ""}`}>
              <div className="plugin-card-body">
                <span className="plugin-card-icon"><PluginIconImage entry={entry} /></span>
                <div className="plugin-card-content">
                  <strong>{pluginName(entry)}</strong>
                  <small>{pluginDescription(entry, t)}</small>
                  <div className="badges mt-1">
                    <StatusPill tone={pluginPrimaryTone(entry)}>{pluginPrimaryLabel(entry, t)}</StatusPill>
                    {entry.installed?.bundled && <StatusPill tone="blue">{t("plugins.badge.bundled")}</StatusPill>}
                    {entry.catalog?.publisherType === "community" && <StatusPill tone="orange">{t("plugins.badge.community")}</StatusPill>}
                    {entry.installed?.source === "local" && <StatusPill tone="orange">{t("plugins.badge.local")}</StatusPill>}
                    {entry.installed?.runtime === "javascript" || entry.catalog?.runtime === "javascript" ? <StatusPill tone="purple">{t("plugins.badge.js")}</StatusPill> : <StatusPill tone="slate">{t("plugins.badge.declarative")}</StatusPill>}
                  </div>
                </div>
              </div>

              <div className="plugin-card-footer">
                <div className="plugin-card-meta">
                  <span className="text-[10px] font-bold text-slatecopy/50 uppercase tracking-tight">v{entry.installed?.version || entry.catalog?.version}</span>
                </div>

                <div className="plugin-card-actions">
                  {entry.installed && (
                    <div className="plugin-card-toggle-zone">
                      <span className="plugin-card-toggle-label">{entry.installed.enabled ? t("plugins.card.active") : t("plugins.card.off")}</span>
                      <input
                        className="settings-toggle plugin-card-toggle"
                        type="checkbox"
                        checked={entry.installed.enabled}
                        disabled={!!busy || entry.installed.catalogDisabled || Boolean(entry.installed.brokenReason)}
                        onChange={(event) => {
                          const nextEnabled = event.target.checked;
                          void run(t("plugins.busy.saving"), async () => {
                            applyResult(await api.setPluginEnabled(entry.id, nextEnabled), nextEnabled ? t("plugins.toast.pluginEnabled") : t("plugins.toast.pluginDisabled"));
                          });
                        }}
                      />
                    </div>
                  )}

                  {entry.installed ? (
                    <>
                      {entry.installed.source === "local" && entry.installed.sourcePath && <Button variant="secondary" size="compact" icon={<RefreshIcon />} disabled={!!busy} onClick={() => void run(t("plugins.busy.refreshingSource"), async () => { applyResult(await api.refreshLocalPlugin(entry.id), t("plugins.toast.localRefreshed")); })}>{t("plugins.card.refresh")}</Button>}
                      <Button variant="secondary" size="compact" icon={<ConfigureIcon />} disabled={!!busy} onClick={() => setSelectedId(entry.id)}>{t("plugins.card.configure")}</Button>
                    </>
                  ) : (
                    <Button variant="primary" size="compact" icon={<InstallIcon />} disabled={!!busy || entry.catalog?.deprecated} onClick={() => void run(t("plugins.busy.installing"), async () => { await installCatalogEntry(entry); })}>{t("plugins.card.installPlugin")}</Button>
                  )}
                </div>
              </div>
            </article>
          ))}
          {!filteredEntries.length && <div className="plugin-empty"><PluginGlyph /><strong>{t("plugins.empty.title")}</strong><small>{t("plugins.empty.description")}</small></div>}
        </div>
        <div className="plugin-hub-footer">
          <span><strong>{snapshot?.plugins.length ?? 0}</strong> {t("plugins.footer.installed")} · <strong>{catalog?.plugins.length ?? 0}</strong> {t("plugins.footer.catalog")}</span>
          <span className="plugin-hub-actions">
            <Button variant="secondary" size="compact" disabled={!!busy} icon={<RefreshIcon />} onClick={() => void run(t("plugins.busy.refreshing"), async () => { await load(true); setMessage(t("plugins.toast.catalogRefreshed")); })}>{t("plugins.footer.refresh")}</Button>
            <Button variant="secondary" size="compact" icon={<FolderPlusIcon />} disabled={!!busy} onClick={() => void run(t("plugins.busy.loading"), async () => {
              const result = await api.loadLocalPlugin();
              if (applyResult(result, t("plugins.toast.localLoaded"))) await load(false, false);
            })}>{t("plugins.footer.loadLocal")}</Button>
          </span>
        </div>
      </GlassCard>
      {selected && <div className="plugin-config-overlay" role="dialog" aria-modal="true" aria-label={t("plugins.inspector.configAria", { name: pluginName(selected) })}>
        <button className="plugin-config-backdrop" type="button" aria-label={t("plugins.inspector.closeAria")} onClick={() => setSelectedId("")} />
        <GlassCard className="plugin-inspector">
        {selected ? <>
          <div className="plugin-inspector-head">
            <span className="plugin-inspector-icon"><PluginIconImage entry={selected} /></span>
            <div className="flex-1 min-w-0"><p className="eyebrow">{t("plugins.inspector.details")}</p><h2>{pluginName(selected)}</h2><p className="desc">{pluginDescription(selected, t)}</p></div>
            <Button variant="secondary" size="compact" icon={<CloseIcon />} onClick={() => setSelectedId("")}>{t("plugins.inspector.close")}</Button>
          </div>
          <div className="meta">
            <StatusPill tone={pluginPrimaryTone(selected)}>{pluginPrimaryLabel(selected, t)}</StatusPill>
            <StatusPill tone="slate">v{installed?.version ?? catalogPlugin?.version}</StatusPill>
            {installed?.bundled && <StatusPill tone="blue">{t("plugins.badge.bundled")}</StatusPill>}
            {catalogPlugin?.publisherType === "community" && <StatusPill tone="orange">{t("plugins.badge.community")}</StatusPill>}
            {installed?.source === "local" && <StatusPill tone="orange">{t("plugins.badge.local")}</StatusPill>}
            {(installed?.catalogDeprecated || catalogPlugin?.deprecated) && <StatusPill tone="orange">{t("plugins.badge.deprecated")}</StatusPill>}
          </div>
          {(installed?.catalogStatusReason || catalogPlugin?.statusReason || installed?.status?.text) && <div className="plugin-status-strip">
            {installed?.status?.text && <StatusPill tone={installed.status.tone ? pluginStatusTone[installed.status.tone] : "blue"}>{installed.status.text}</StatusPill>}
            <span>{installed?.catalogStatusReason || catalogPlugin?.statusReason}</span>
          </div>}
          {installed ? <>
            <section className="plugin-section">
              <div className="plugin-section-title"><small>{t("plugins.inspector.runtime")}</small><strong>{t("plugins.inspector.statePermissions")}</strong></div>
              <label className="settings-row plugin-toggle-row">
                <div className="settings-row-info"><strong>{installed.enabled ? t("plugins.inspector.enabled") : t("plugins.inspector.disabled")}</strong><small>{installed.brokenReason || (installed.catalogDisabled ? t("plugins.inspector.catalogDisabledNote") : t("plugins.inspector.toggleNote"))}</small></div>
                <input className="settings-toggle" type="checkbox" checked={installed.enabled} disabled={!!busy || installed.catalogDisabled || Boolean(installed.brokenReason)} onChange={(event) => { const nextEnabled = event.target.checked; void run(t("plugins.busy.saving"), async () => { applyResult(await api.setPluginEnabled(installed.id, nextEnabled), nextEnabled ? t("plugins.toast.pluginEnabled") : t("plugins.toast.pluginDisabled")); }); }} />
              </label>
              {installed.source === "local" && installed.sourcePath && <div className="plugin-source-path"><small>{t("plugins.inspector.sourceFolder")}</small><code>{installed.sourcePath}</code></div>}
              <div className="badges plugin-permissions">{installed.approvedPermissions.length ? installed.approvedPermissions.map((permission) => <StatusPill key={permission} tone={sensitivePermissionSet.has(permission) ? "red" : permission === "network" || permission === "network:write" ? "orange" : "blue"}>{t(pluginPermissionLabelKeys[permission])}</StatusPill>) : <StatusPill tone="slate">{t("plugins.inspector.noPermissions")}</StatusPill>}</div>
              {installed.approvedPermissions.includes("companion:context") && <p className="plugin-permission-note">{t("plugins.permission.companionContextNote")}</p>}
            </section>
            {!!installed.configErrors?.length && <section className="plugin-section plugin-section-danger"><div className="plugin-section-title"><small>{t("plugins.inspector.configuration")}</small><strong>{t("plugins.inspector.needsAttention")}</strong></div><ul>{installed.configErrors.map((configError, index) => <li key={index}>{configError.message || String(configError)}</li>)}</ul></section>}
            {hasConfigFields && <section className="plugin-section">
              <div className="plugin-section-title"><small>{t("plugins.inspector.settings")}</small><strong>{t("plugins.inspector.configuration")}</strong></div>
              <div className="plugin-config-form">{Object.entries(installed.configSchema ?? {}).map(([key, field]) => <ConfigFieldEditor key={key} pluginId={installed.id} fieldKey={key} field={field} value={configDraft[key] ?? initialConfigValue(field)} onChange={(value) => updateDraft(key, value)} onPickSound={(pluginId) => pickConfigSound(pluginId, key)} spritePreviews={installed.spritePreviews} />)}</div>
              <Button variant="primary" fullWidth icon={<SaveIcon />} disabled={!!busy} onClick={() => void run(t("plugins.busy.saving"), async () => { applyResult(await api.savePluginConfig(installed.id, configDraft), t("plugins.toast.configSaved")); })}>{t("plugins.inspector.saveConfiguration")}</Button>
            </section>}
            {!!installed.commands?.length && <section className="plugin-section">
              <div className="plugin-section-title"><small>{t("plugins.inspector.commands")}</small><strong>{t("plugins.inspector.quickActions")}</strong></div>
              <div className="plugin-command-list">
                {installed.commands.map((command) => (
                  <div key={command.id} className="flex flex-col gap-2">
                    <Button variant="secondary" size="compact" disabled={!!busy} onClick={() => {
                      if (command.form) { setActiveCommandId((current) => current === command.id ? "" : command.id); return; }
                      void run(t("plugins.busy.running"), async () => { applyResult(await api.executePluginCommand(installed.id, command.id), t("plugins.toast.commandRan")); });
                    }}>
                      {command.title}
                    </Button>
                    {command.description && <small className="text-[10px] text-slatecopy px-1 leading-tight">{command.description}</small>}
                  </div>
                ))}
              </div>
              {activeCommand?.form && (() => {
                const formDraft = materializeCommandDraft(activeCommand.form, commandDrafts[activeCommand.id]);
                return <div className="plugin-command-form-panel">
                  <div className="plugin-section-title"><small>{activeCommand.title}</small><strong>{activeCommand.form.submitLabel || activeCommand.title}</strong></div>
                  <div className="plugin-command-form">
                    {activeCommand.form.fields.map((field) => <ConfigFieldEditor key={field.id} pluginId={installed.id} fieldKey={field.id} field={commandFieldToConfigField(field)} value={formDraft[field.id]} onChange={(value) => updateCommandDraft(activeCommand.id, field.id, value)} />)}
                  </div>
                  <div className="flex gap-2">
                    <Button variant="primary" size="compact" disabled={!!busy} onClick={() => void run(t("plugins.busy.running"), async () => { if (applyResult(await api.executePluginCommand(installed.id, activeCommand.id, formDraft), t("plugins.toast.commandRan"))) setActiveCommandId(""); })}>{activeCommand.form.submitLabel || activeCommand.title}</Button>
                    <Button variant="secondary" size="compact" disabled={!!busy} onClick={() => setActiveCommandId("")}>{t("plugins.inspector.close")}</Button>
                  </div>
                </div>;
              })()}
            </section>}
            <section className="plugin-section plugin-actions-section">
              {installed.source === "local" && installed.sourcePath && <Button variant="secondary" disabled={!!busy} icon={<FolderPlusIcon />} onClick={() => void run(t("plugins.busy.refreshingSource"), async () => { applyResult(await api.refreshLocalPlugin(installed.id), t("plugins.toast.localRefreshed")); })}>{t("plugins.inspector.refreshFromFolder")}</Button>}
              <Button variant="secondary" disabled={!!busy} icon={<RefreshIcon />} onClick={() => void run(t("plugins.busy.reloading"), async () => { applyResult(await api.reloadPlugin(installed.id), t("plugins.toast.pluginReloaded")); })}>{t("plugins.inspector.reload")}</Button>
              {installed.source === "catalog" && !installed.bundled && catalogPlugin && catalogPlugin.version !== installed.version && <Button variant="primary" icon={<InstallIcon />} disabled={!!busy} onClick={() => void run(t("plugins.busy.updating"), async () => { await updateCatalogEntry(installed); })}>{t("plugins.inspector.update")}</Button>}
              {!installed.bundled && <Button variant="danger" icon={<RemoveIcon />} disabled={!!busy} onClick={() => { if (window.confirm(t("plugins.inspector.uninstallConfirm", { name: pluginName(selected) }))) void run(t("plugins.busy.uninstalling"), async () => { if (applyResult(await api.uninstallPlugin(installed.id), t("plugins.toast.pluginUninstalled"))) setSelectedId(""); }); }}>{t("plugins.inspector.uninstall")}</Button>}
            </section>
          </> : <section className="plugin-section">
            <div className="plugin-section-title"><small>{t("plugins.inspector.catalog")}</small><strong>{t("plugins.inspector.readyToInstall")}</strong></div>
            <p className="desc">{t("plugins.inspector.catalogDescription")}</p>
            <div className="badges plugin-permissions">{catalogPlugin?.permissions.map((permission) => <StatusPill key={permission} tone={sensitivePermissionSet.has(permission) ? "red" : permission === "network" || permission === "network:write" ? "orange" : "blue"}>{t(pluginPermissionLabelKeys[permission])}</StatusPill>)}</div>
            <Button variant="primary" fullWidth icon={<InstallIcon />} disabled={!!busy || catalogPlugin?.deprecated} onClick={() => void run(t("plugins.busy.installing"), async () => { await installCatalogEntry(selected); })}>{t("plugins.inspector.installPlugin")}</Button>
          </section>}
        </> : <div className="plugin-empty plugin-empty-detail"><PluginGlyph /><strong>{t("plugins.emptyDetail.title")}</strong><small>{t("plugins.emptyDetail.description")}</small></div>}
        </GlassCard>
      </div>}
    </div>
  );
}

function PetCompanionPanel({ petId, originalName, onDirtyChange }: { petId: string; originalName: string; onDirtyChange: (dirty: boolean) => void }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<CompanionSettings | null>(null);
  const [brainHealth, setBrainHealth] = useState<CompanionTargetHealth | null>(null);
  const emptyCharacter = React.useMemo<CompanionCharacterProfile>(() => ({ visibleName: originalName, species: "", origin: "", appearance: "", personality: "", quirks: "", lifeStory: "" }), [originalName]);
  const [draft, setDraft] = useState<CompanionCharacterProfile>(emptyCharacter);
  const [sourceText, setSourceText] = useState("");
  const [status, setStatus] = useState("");
  const [panelError, setPanelError] = useState("");
  const [busyAction, setBusyAction] = useState("");

  const applySettings = React.useCallback((next: CompanionSettings) => {
    setSettings(next);
    setDraft(next.characters[petId] ?? emptyCharacter);
  }, [petId, emptyCharacter]);

  useEffect(() => {
    let active = true;
    void api.getCompanionSettings().then(async (next) => {
      if (!active) return;
      applySettings(next);
      const nextHealth = await api.getCompanionTargetHealth(next.target).catch(() => null);
      if (active) setBrainHealth(nextHealth);
    }).catch((error) => { if (active) setPanelError(String((error as Error)?.message ?? error)); });
    return () => { active = false; };
  }, [applySettings]);

  const saved = settings?.characters[petId] ?? emptyCharacter;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);

  async function run(action: string, task: () => Promise<void>) {
    try {
      setBusyAction(action);
      setPanelError("");
      setStatus("");
      await task();
    } catch (error) {
      setPanelError(String((error as Error)?.message ?? error));
    } finally {
      setBusyAction("");
    }
  }

  const updateField = (key: keyof CompanionCharacterProfile, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const generate = (mode: "complete" | "reimagine") => void run(mode, async () => {
    const result = await api.generateCompanionCharacter({ petId, mode, draft, ...(sourceText.trim() ? { sourceText } : {}) });
    setDraft(result.draft);
    setStatus(t(mode === "complete" ? "pets.character.completedDraft" : "pets.character.reimaginedDraft"));
  });
  const generating = busyAction === "complete" || busyAction === "reimagine";
  const brainReady = brainHealth?.ready === true;
  const generatorReady = settings?.enabled === true && brainReady;

  return (
    <section className="companion-panel" aria-labelledby={`companion-title-${petId}`}>
      <div className="companion-panel-head">
        <div>
          <p className="eyebrow">{t("pets.character.eyebrow")}</p>
          <h3 id={`companion-title-${petId}`}>{t("pets.character.title")}</h3>
          <p>{t("pets.character.description")}</p>
        </div>
        {dirty ? <StatusPill tone="orange">{t("pets.character.unsaved")}</StatusPill> : <StatusPill tone="green">{t("common.saved")}</StatusPill>}
      </div>

      {panelError && <div className="error companion-panel-message">{panelError}</div>}
      {status && <div className="companion-success companion-panel-message">{status}</div>}

      {!settings ? <p className="desc">{t("common.loading")}</p> : (
        <div className="companion-panel-body">
          <div className={`character-generator ${generating ? "is-generating" : ""}`}>
            <div className="character-generator-head">
              <div><strong>{t("pets.character.aiTitle")}</strong><small>{t("pets.character.aiDescription")}</small></div>
              <div className="character-brain-status">
                <StatusPill tone={brainReady ? "green" : brainHealth?.configured ? "orange" : "slate"}>{brainHealth === null ? t("pets.character.brainChecking") : brainReady ? t("pets.character.brainReady") : t("pets.character.brainNeedsSetup")}</StatusPill>
                <small>{brainHealth === null ? t("pets.character.brainCheckingDescription") : brainReady ? t("pets.character.brainReadyDescription", { provider: brainHealth.provider ?? settings.target, model: brainHealth.model ?? t("pets.character.selectedModel") }) : brainHealth.reason ?? t("pets.character.brainSetupDescription")}</small>
              </div>
            </div>
            <div className="character-generator-options">
              <div className="character-generator-option">
                <div><strong>{t("pets.character.completeTitle")}</strong><small>{t("pets.character.completeDescription")}</small></div>
                <Button variant="secondary" disabled={!!busyAction || !generatorReady} onClick={() => generate("complete")}>{busyAction === "complete" ? t("pets.character.completing") : t("pets.character.complete")}</Button>
              </div>
              <div className="character-generator-option character-generator-option-featured">
                <div><strong>{t("pets.character.reimagineTitle")}</strong><small>{t("pets.character.reimagineDescription")}</small></div>
                <Button variant="primary" disabled={!!busyAction || !generatorReady} onClick={() => generate("reimagine")}>{busyAction === "reimagine" ? t("pets.character.reimagining") : t("pets.character.reimagine")}</Button>
              </div>
            </div>
            {!generatorReady && <p className="character-generator-help">{t("pets.character.generatorRequirement")}</p>}
            {generating && <div className="character-generation-progress" role="status" aria-live="polite"><span className="character-generation-spinner" aria-hidden="true" /><div><strong>{t(busyAction === "complete" ? "pets.character.completingStatus" : "pets.character.reimaginingStatus")}</strong><small>{t("pets.character.generationWait")}</small></div></div>}
          </div>

          <div className="companion-profile-grid">
            <CharacterField label={t("pets.character.visibleName")} description={t("pets.character.visibleNameDescription")} value={draft.visibleName} maxLength={120} disabled={!!busyAction} onChange={(value) => updateField("visibleName", value)} />
            <CharacterField label={t("pets.character.species")} description={t("pets.character.speciesDescription")} value={draft.species} maxLength={160} disabled={!!busyAction} onChange={(value) => updateField("species", value)} />
          </div>
          <CharacterField label={t("pets.character.origin")} description={t("pets.character.originDescription")} value={draft.origin} maxLength={500} rows={3} disabled={!!busyAction} onChange={(value) => updateField("origin", value)} />
          <CharacterField label={t("pets.character.appearance")} description={t("pets.character.appearanceDescription")} value={draft.appearance} maxLength={700} rows={3} disabled={!!busyAction} onChange={(value) => updateField("appearance", value)} />
          <CharacterField label={t("pets.character.personality")} description={t("pets.character.personalityDescription")} value={draft.personality} maxLength={900} rows={4} disabled={!!busyAction} onChange={(value) => updateField("personality", value)} />
          <CharacterField label={t("pets.character.quirks")} description={t("pets.character.quirksDescription")} value={draft.quirks} maxLength={700} rows={3} disabled={!!busyAction} onChange={(value) => updateField("quirks", value)} />
          <CharacterField label={t("pets.character.lifeStory")} description={t("pets.character.lifeStoryDescription")} value={draft.lifeStory} maxLength={1200} rows={5} disabled={!!busyAction} onChange={(value) => updateField("lifeStory", value)} />

          <div className="companion-field">
            <span>{t("pets.character.sourceNotes")}</span><small>{t("pets.character.sourceNotesDescription")}</small>
            <textarea value={sourceText} maxLength={8000} rows={3} disabled={!!busyAction} onChange={(event) => setSourceText(event.target.value)} placeholder={t("pets.character.sourceNotesPlaceholder")} />
            <div className="companion-field-actions"><span>{sourceText.length}/8000 · {t("pets.character.notSaved")}</span><Button variant="secondary" size="compact" disabled={!!busyAction} onClick={() => void run("import", async () => { const result = await api.importCompanionText(); if (result.canceled) return; if (result.text.length > 8000) throw new Error(t("pets.character.sourceNotesTooLong")); setSourceText(result.text); })}>{t("settings.memory.import")}</Button></div>
          </div>

          <div className="character-save-bar">
            <div>{dirty ? <strong>{t("pets.character.unsavedDescription")}</strong> : <span>{t("pets.character.savedDescription")}</span>}</div>
            <div className="flex gap-2"><Button variant="secondary" size="compact" disabled={!!busyAction} onClick={() => { setDraft(emptyCharacter); setStatus(t("pets.character.resetDraft")); }}>{t("pets.character.reset")}</Button><Button variant="primary" size="compact" disabled={!!busyAction || !dirty} onClick={() => void run("save", async () => { applySettings(await api.updateCompanionCharacterSettings(petId, draft)); setStatus(t("pets.character.saved")); })}>{t("common.save")}</Button></div>
          </div>
        </div>
      )}
    </section>
  );
}

function CharacterField({ label, description, value, maxLength, rows, disabled, onChange }: { label: string; description: string; value: string; maxLength: number; rows?: number; disabled?: boolean; onChange: (value: string) => void }) {
  return <label className="companion-field"><span>{label}</span><small>{description}</small>{rows ? <textarea value={value} maxLength={maxLength} rows={rows} disabled={disabled} onChange={(event) => onChange(event.target.value)} /> : <input value={value} maxLength={maxLength} disabled={disabled} onChange={(event) => onChange(event.target.value)} />}<span className="character-count">{value.length}/{maxLength}</span></label>;
}

function ControlCenter() {
  const { t } = useI18n();
  const initialRoute = useMemo(() => initialControlCenterRoute(), []);
  const [currentRoute, setCurrentRoute] = useState<Route>(initialRoute.route);
  const [requestedPetId, setRequestedPetId] = useState(initialRoute.petId ?? "");
  const [state, setState] = useState<StateSnapshot | null>(null);
  const [catalog, setCatalog] = useState<CatalogState | null>(null);
  const [catalogPages, setCatalogPages] = useState<Record<number, PetEntry[]>>({});
  const [catalogSearch, setCatalogSearch] = useState<SearchPetEntry[] | null>(null);
  const [catalogPage, setCatalogPage] = useState(0);
  const [codex, setCodex] = useState<CodexState>({ pets: [] });
  const [selectedId, setSelectedId] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(initialRoute.notice === "pet-unavailable" ? t("pets.companion.petUnavailable") : "");
  const [characterDirty, setCharacterDirty] = useState(false);
  const characterDirtyRef = useRef(false);
  const petDetailDialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);
  const closePetDetails = React.useCallback(() => {
    if (characterDirtyRef.current && !window.confirm(t("pets.character.discardConfirm"))) return;
    setSelectedId("");
    setCharacterDirty(false);
  }, [t]);
  useEffect(() => { characterDirtyRef.current = characterDirty; }, [characterDirty]);

  useEffect(() => api.onRouteChange((value) => {
    const request = normalizeControlCenterRouteRequest(value);
    setCurrentRoute(request.route);
    setRequestedPetId(request.petId ?? "");
    if (request.notice === "pet-unavailable") setError(t("pets.companion.petUnavailable"));
  }), []);

  async function loadPetsData() {
    setError("");
    const [nextState, nextCatalog, nextCodex] = await Promise.all([api.getPetsState(), api.getCatalog(), api.getCodexPets()]);
    logPetsEvent("load-complete", { installed: nextState.pets.installed.length, defaultPetId: nextState.preferences.defaultPetId, catalogSource: nextCatalog.source, catalogPets: nextCatalog.pets.length, catalogPage: nextCatalog.page, catalogPageCount: nextCatalog.pageCount, codexPets: nextCodex.pets.length, catalogError: nextCatalog.error, codexError: nextCodex.error, firstCatalogPet: nextCatalog.pets[0] ? { id: nextCatalog.pets[0].id, preview: imageDebug(nextCatalog.pets[0].preview), thumbnail: imageDebug(nextCatalog.pets[0].thumbnail), spritesheet: imageDebug(nextCatalog.pets[0].spritesheet) } : null });
    setState(nextState); setCatalog(nextCatalog); setCodex(nextCodex);
    setCatalogPage(nextCatalog.page ?? 0);
    setCatalogPages({ [nextCatalog.page ?? 0]: nextCatalog.pets });
    const visiblePetIds = new Set<string>([...nextState.pets.installed.map((pet) => pet.id), ...nextCatalog.pets.map((pet) => pet.id), ...nextCodex.pets.map((pet) => pet.id)]);
    setSelectedId((current) => current && visiblePetIds.has(current) ? current : "");
  }
  useEffect(() => {
    if (currentRoute !== "pets") return;
    void loadPetsData().catch((err) => setError(String(err?.message ?? err)));
  }, [currentRoute]);

  const pets = useMemo(() => {
    const installed = new Map((state?.pets.installed ?? []).map((p) => [p.id, p]));
    const catalogMap = new Map<string, PetEntry>();
    for (const pagePets of Object.values(catalogPages)) {
      for (const p of pagePets) {
        catalogMap.set(p.id, p);
      }
    }
    const codexMap = new Map<string, PetEntry>((codex.pets ?? []).map((p) => [p.id, p]));

    const rows: PetEntry[] = (state?.pets.installed ?? []).map((p) => {
      const catalogPet = catalogMap.get(p.id);
      const codexPet = codexMap.get(p.id);
      const localSpritesheet = p.id && !catalogPet && !codexPet && !p.builtIn ? installedPetSpritesheetUrl(p.id) : undefined;
      const spritesheet = safePetImage(codexPet?.spritesheet) || safePetImage(catalogPet?.spritesheet) || safePetImage(localSpritesheet);
      const preview = safePetImage(codexPet?.preview) || safePetImage(catalogPet?.preview) || safePetImage(catalogPet?.thumbnail) || safePetImage(p.source && "preview" in p.source ? (p.source as { preview?: string }).preview : undefined) || safePetImage(localSpritesheet) || defaultThumbUrl;
      const category = catalogPet?.category;
      const original = catalogPet?.original;
      const featured = catalogPet?.featured;
      return {
        ...p,
        spritesheet,
        preview,
        category,
        original,
        featured,
        sourceKind: "installed" as const,
        installed: true,
      };
    });

    for (const p of catalogMap.values()) {
      if (!installed.has(p.id)) {
        rows.push({
          ...p,
          preview: safePetImage(p.preview) || safePetImage(p.thumbnail) || defaultThumbUrl,
          spritesheet: safePetImage(p.spritesheet),
          sourceKind: "catalog",
          installed: false,
        });
      }
    }

    for (const p of codexMap.values()) {
      if (!installed.has(p.id) && !catalogMap.has(p.id)) {
        rows.push({
          ...p,
          preview: safePetImage(p.preview),
          spritesheet: safePetImage(p.spritesheet),
          sourceKind: "codex",
          installed: false,
        });
      }
    }

    return rows.filter((p) => {
      if (filter === "installed" && !p.installed) return false;
      if (filter === "codex" && p.sourceKind !== "codex" && !(installed.get(p.id)?.source?.kind === "codex")) return false;
      if (filter === "originals" && !p.original && !p.builtIn) return false;
      if (filter === "featured" && (!p.featured || p.original)) return false;
      const q = query.trim().toLowerCase();
      return !q || `${p.displayName} ${p.description ?? ""} ${p.searchText ?? ""} ${p.id}`.toLowerCase().includes(q);
    });
  }, [state, catalogPages, catalogSearch, codex, filter, query]);

  const selected = selectedId ? pets.find((p) => p.id === selectedId) ?? null : null;
  const defaultId = state?.preferences.defaultPetId;

  useEffect(() => {
    if (currentRoute !== "pets" || !requestedPetId || !state) return;
    const target = pets.find((pet) => pet.id === requestedPetId && pet.installed && !pet.broken);
    if (target) setSelectedId(target.id);
    else setError(t("pets.companion.petUnavailable"));
    setRequestedPetId("");
  }, [currentRoute, pets, requestedPetId, state, t]);

  useEffect(() => {
    if (!selected) return;

    const dialog = petDetailDialogRef.current;
    if (!dialog) return;

    previouslyFocusedElementRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableSelector = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
    requestAnimationFrame(() => {
      dialog.querySelector<HTMLElement>(focusableSelector)?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePetDetails();
        return;
      }

      if (event.key !== "Tab") return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previouslyFocusedElementRef.current?.focus();
    };
  }, [selected, closePetDetails]);

  useEffect(() => {
    if (!selected) return;
    logPetsEvent("selected-pet", { id: selected.id, sourceKind: selected.sourceKind, installed: selected.installed, builtIn: selected.builtIn, preview: imageDebug(selected.preview), spritesheet: imageDebug(selected.spritesheet), hasSafePreview: Boolean(safePetImage(selected.preview)), hasSafeSpritesheet: Boolean(safePetImage(selected.spritesheet)), catalogPages: Object.keys(catalogPages).join(",") });
  }, [selected]);

  const statusText = useMemo(() => {
    if (!selected) return "";
    const isDefault = selected.id === defaultId;
    const isCodex = selected.sourceKind === "codex" || (state?.pets.installed.find(p => p.id === selected.id)?.source?.kind === "codex");
    if (selected.broken) return selected.brokenReason || t("pets.status.broken");
    if (isDefault) return selected.protected ? t("pets.status.defaultProtected") : t("pets.status.default");
    if (selected.installed) {
      if (isCodex) return t("pets.status.installedCodex");
      return t("pets.status.installed");
    }
    if (selected.sourceKind === "codex") return t("pets.status.availableCodex");
    return t("pets.status.availableCatalog");
  }, [selected, defaultId, state, t]);

  async function act(label: string, fn: () => Promise<unknown>) {
    try { setBusy(label); setError(""); await fn(); await loadPetsData(); }
    catch (err) { setError(String((err as Error)?.message ?? err)); }
    finally { setBusy(""); }
  }

  useEffect(() => {
    if (currentRoute !== "pets") return;
    if (catalogSearch) return;
    void api.getCatalogSearch().then((result) => {
      if (result.error) setError(result.error);
      setCatalogSearch(result.pets ?? []);
    }).catch((err) => setError(String(err?.message ?? err)));
  }, [catalogSearch, currentRoute]);

  useEffect(() => {
    if (currentRoute !== "pets") return;
    if (!catalogSearch) return;
    const q = query.trim().toLowerCase();
    const needsRemotePages = !!q || filter === "featured" || filter === "originals";

    const pages = new Set<number>();

    if (state?.pets.installed) {
      for (const p of state.pets.installed) {
        const searchPet = catalogSearch.find(sp => sp.id === p.id);
        if (searchPet && typeof searchPet.catalogPage === "number" && !catalogPages[searchPet.catalogPage]) {
          pages.add(searchPet.catalogPage);
        }
      }
    }

    if (needsRemotePages) {
      for (const pet of catalogSearch) {
        if (pages.size >= 12) break;
        if (filter === "originals" && !pet.original) continue;
        if (filter === "featured" && (!pet.featured || pet.original)) continue;
        if (q && !`${pet.displayName} ${pet.searchText ?? ""} ${pet.id}`.toLowerCase().includes(q)) continue;
        if (typeof pet.catalogPage === "number" && !catalogPages[pet.catalogPage]) pages.add(pet.catalogPage);
      }
    }

    if (!pages.size) return;
    let cancelled = false;
    void Promise.all([...pages].map((page) => api.getCatalogPage(page).catch((err) => ({ source: "error", pets: [], error: String((err as Error)?.message ?? err), page } as CatalogState)))).then((results) => {
      if (cancelled) return;
      setCatalogPages((current) => {
        const next = { ...current };
        for (const result of results) if (result.source !== "error") next[result.page ?? 0] = result.pets;
        return next;
      });
      const firstError = results.find((result) => result.source === "error")?.error;
      if (firstError) setError(firstError);
    });
    return () => { cancelled = true; };
  }, [catalogPages, catalogSearch, filter, query, state, currentRoute]);

  async function loadCatalogPage(page: number) {
    if (catalogPages[page]) { setCatalogPage(page); return; }
    try {
      setBusy(t("pets.busy.loadingPage")); setError("");
      const next = await api.getCatalogPage(page);
      setCatalog(next); setCatalogPage(next.page ?? page); setCatalogPages((pages) => ({ ...pages, [next.page ?? page]: next.pets }));
    } catch (err) { setError(String((err as Error)?.message ?? err)); }
    finally { setBusy(""); }
  }

  const currentMeta = routeMetadata[currentRoute];

  return (
    <main className="app-shell">
      <header className="hero">
        <div className="hero-content">
          <p className="eyebrow">{t("app.controlCenter")}</p>
          <h1>{t(currentMeta.titleKey)}</h1>
          <p className="hero-desc">{t(currentMeta.descKey)}</p>
        </div>
        <div className="hero-logo-container">
          <img src={openPetsLogoUrl} className="hero-brand-logo" alt={t("app.logo.alt")} />
        </div>
      </header>

      <nav className="nav-bar">
        {navTabs.map((tab) => (
          <button
            key={tab.id}
            className={`nav-tab ${currentRoute === tab.id ? "active" : ""}`}
            onClick={() => setCurrentRoute(tab.id)}
          >
            {tab.icon}
            <span>{t(tab.labelKey)}</span>
          </button>
        ))}
      </nav>

      {error && <div className="error">{error}</div>}

      {currentRoute === "dashboard" ? (
        <DashboardView onNavigate={setCurrentRoute} />
      ) : currentRoute === "settings" ? (
        <SettingsView onNavigate={setCurrentRoute} />
      ) : currentRoute === "plugins" ? (
        <PluginsView />
      ) : currentRoute === "integrations" ? (
        <IntegrationsView />
      ) : (
        <div className="layout">
          <GlassCard className="gallery">
            <div className="toolbar"><SearchInput value={query} onChange={(e) => setQuery(e.target.value)} /></div>
            <div className="filter-row">
              <div className="filters">
                {(["all", "installed", "featured", "originals", "codex"] as Filter[]).map((f) => (
                  <button
                    key={f}
                    className={`filter ${filter === f ? "active" : ""} ${f === "originals" ? "original" : ""} ${f === "featured" ? "featured" : ""}`}
                    onClick={() => setFilter(f)}
                    aria-current={filter === f ? "page" : undefined}
                  >
                    <span className="filter-icon-wrapper">{filterIcons[f]}</span>
                    <span className="filter-text">{t(filterLabelKeys[f])}</span>
                  </button>
                ))}
              </div>
              <div className="filter-actions">
                <Button variant="secondary" size="compact" icon={<FolderPlusIcon />} disabled={!!busy} onClick={() => void act(t("pets.busy.importing"), () => api.installLocalPet())}>{t("pets.import")}</Button>
                <Button variant="secondary" size="compact" icon={<HeartIcon />} onClick={() => void api.openGallery().catch((err) => setError(String(err?.message ?? err)))}>{t("pets.gallery")}</Button>
              </div>
            </div>
            <div className="pets-grid">{pets.map((pet) => {
              const isBuiltIn = pet.builtIn;
              const hasDistinctPreview = pet.preview && pet.preview !== pet.spritesheet;
              const useSpritesheetFrame = !isBuiltIn && !hasDistinctPreview && !!pet.spritesheet;
              const isDefault = pet.id === defaultId;
              const canInstall = !pet.installed && pet.sourceKind === "catalog";
              const canImport = !pet.installed && pet.sourceKind === "codex";
              const canSetDefault = pet.installed && !isDefault && !pet.broken;
              const canRemove = pet.installed && !pet.builtIn && !pet.protected;

              return (
                <div
                  key={`${pet.sourceKind}-${pet.id}`}
                  className={`pet-card group ${selected?.id === pet.id ? "selected" : ""}`}
                >
                  <span className="thumb">
                    {useSpritesheetFrame ? (
                      <SpriteFrame src={pet.spritesheet} label={t("pets.spriteLabel.thumbnail", { name: pet.displayName })} size="thumb" />
                    ) : (
                      <PetImage src={pet.preview} debugLabel={`${pet.id}:card`} />
                    )}
                  </span>
                  <div className="card-content">
                    <span className="card-title-row">
                      <b className="card-title">{pet.displayName}</b>
                    </span>
                    <p className="card-desc">{pet.description || pet.id}</p>
                    <div className="badges">{isDefault && <StatusPill tone="green">{t("pets.badge.default")}</StatusPill>}{pet.original || pet.builtIn ? <StatusPill tone="yellow">{t("pets.badge.original")}</StatusPill> : pet.featured ? <StatusPill tone="purple">{t("pets.badge.featured")}</StatusPill> : null}{pet.installed && <StatusPill>{t("pets.badge.installed")}</StatusPill>}{pet.sourceKind === "codex" && <StatusPill tone="orange">{t("pets.badge.codex")}</StatusPill>}</div>

                    <div className="pet-card-actions" onClick={(event) => event.stopPropagation()}>
                      <Button
                        variant="secondary"
                        size="compact"
                        icon={<EyeIcon />}
                        ariaLabel={t("pets.aria.view", { name: pet.displayName })}
                        onClick={() => setSelectedId(pet.id)}
                      >
                        {t("pets.action.viewPet")}
                      </Button>
                      {canInstall && (
                        <Button
                          variant="primary"
                          size="compact"
                          icon={<InstallIcon />}
                          disabled={!!busy}
                          ariaLabel={t("pets.aria.install", { name: pet.displayName })}
                          onClick={() => { void act(t("pets.busy.installing"), () => api.installPet(pet.id)); }}
                        >
                          {t("pets.action.install")}
                        </Button>
                      )}
                      {canImport && (
                        <Button
                          variant="warning"
                          size="compact"
                          icon={<ImportIcon />}
                          disabled={!!busy}
                          ariaLabel={t("pets.aria.import", { name: pet.displayName })}
                          onClick={() => { void act(t("pets.busy.importing"), () => api.importCodexPet(pet.id)); }}
                        >
                          {t("pets.action.import")}
                        </Button>
                      )}
                      {canSetDefault && (
                        <Button
                          variant="primary"
                          size="compact"
                          icon={<SetDefaultIcon />}
                          disabled={!!busy}
                          ariaLabel={t("pets.aria.setDefault", { name: pet.displayName })}
                          onClick={() => { void act(t("pets.busy.settingDefault"), () => api.setDefaultPet(pet.id)); }}
                        >
                          {t("pets.action.default")}
                        </Button>
                      )}
                      {canRemove && (
                        <Button
                          variant="danger"
                          size="compact"
                          icon={<RemoveIcon />}
                          disabled={!!busy}
                          ariaLabel={t("pets.aria.remove", { name: pet.displayName })}
                          onClick={() => { void act(t("pets.busy.removing"), () => api.removePet(pet.id)); }}
                        >
                          {t("pets.action.remove")}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}</div>
            <div className="pager">
              {!!catalog?.pageCount && catalog.pageCount > 1 ? (
                <Button
                  variant="secondary"
                  size="compact"
                  icon={<PrevIcon />}
                  disabled={!!busy || catalogPage <= 0}
                  onClick={() => void loadCatalogPage(catalogPage - 1)}
                >
                  {t("pets.pager.prev")}
                </Button>
              ) : <span />}
              <span className="pager-text">{t("pets.pager.count", { count: pets.length })}{!!catalog?.pageCount && catalog.pageCount > 1 ? t("pets.pager.page", { page: catalogPage + 1, pageCount: catalog.pageCount }) : ""}</span>
              {!!catalog?.pageCount && catalog.pageCount > 1 ? (
                <Button
                  variant="secondary"
                  size="compact"
                  icon={<NextIcon />}
                  iconPosition="right"
                  disabled={!!busy || catalogPage >= catalog.pageCount - 1}
                  onClick={() => void loadCatalogPage(catalogPage + 1)}
                >
                  {t("pets.pager.next")}
                </Button>
              ) : <span />}
            </div>
          </GlassCard>

          {selected ? (
            <div ref={petDetailDialogRef} className="plugin-config-overlay" role="dialog" aria-modal="true" aria-label={t("pets.detail.ariaLabel", { name: selected.displayName })}>
              <button className="plugin-config-backdrop" type="button" aria-label={t("pets.detail.closeAria")} onClick={closePetDetails} />
              <GlassCard className="plugin-inspector pet-detail-inspector">
                <div className="plugin-inspector-head">
                  <span className="plugin-inspector-icon">
                    {safePetImage(selected.spritesheet) ? (
                      <SpriteFrame src={selected.spritesheet} label={t("pets.spriteLabel.thumb", { name: selected.displayName })} size="thumb" />
                    ) : (
                      <PetImage src={selected.preview} debugLabel={`${selected.id}:thumb`} />
                    )}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="eyebrow">{t("pets.detail.eyebrow")}</p>
                    <h2>{selected.displayName}</h2>
                  </div>
                  <Button variant="secondary" size="compact" icon={<CloseIcon />} onClick={closePetDetails}>{t("common.close")}</Button>
                </div>

                <div className="pet-detail-content">
                  <div className="pet-detail-main">
                    <p className="desc">{selected.description || selected.id}</p>
                    <div className="stage">
                      {safePetImage(selected.spritesheet) ? (
                        <SpriteFrame src={selected.spritesheet} label={t("pets.spriteLabel.animatedPreview", { name: selected.displayName })} />
                      ) : (
                        <PetImage src={selected.preview} debugLabel={`${selected.id}:detail-fallback`} />
                      )}
                    </div>
                    <div className="meta">
                      {selected.broken && <StatusPill tone="red">{t("pets.badge.broken")}</StatusPill>}
                      {selected.installed && !selected.broken && <StatusPill tone="green">{t("pets.badge.ready")}</StatusPill>}
                      {selected.builtIn && <StatusPill tone="orange">{t("pets.badge.originals")}</StatusPill>}
                      {selected.original && !selected.builtIn && <StatusPill tone="yellow">{t("pets.badge.original")}</StatusPill>}
                      {selected.featured && !selected.original && <StatusPill tone="purple">{t("pets.badge.featured")}</StatusPill>}
                    </div>
                    {statusText && <p className="text-sm text-slatecopy mt-3 mb-0 font-medium">{statusText}</p>}
                  </div>

                  <aside className="pet-detail-reactions">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slatecopy mb-3">{t("pets.detail.previewAnimations")}</h3>
                    <div className="pet-preview-grid">
                      {[
                        { label: t("pets.detail.preview.idle"), state: "idle" as const },
                        { label: t("pets.detail.preview.thinking"), state: "thinking" as const },
                        { label: t("pets.detail.preview.happy"), state: "happy" as const },
                        { label: t("pets.detail.preview.wave"), state: "wave" as const },
                      ].map((previewState) => (
                        <article key={previewState.state} className="pet-preview-item">
                          <SpriteFrame src={selected.spritesheet} label={t("pets.spriteLabel.statePreview", { name: selected.displayName, state: previewState.label })} state={previewState.state} size="mini" />
                          <span className="text-xs font-bold text-slatecopy">{previewState.label}</span>
                        </article>
                      ))}
                    </div>
                  </aside>
                </div>

                {selected.installed && !selected.broken && selected.id === defaultId && (
                  <PetCompanionPanel petId={selected.id} originalName={selected.displayName} onDirtyChange={setCharacterDirty} />
                )}

                <div className="actions-container mt-6 flex flex-col gap-3 pet-detail-actions">
                  {/* Main Action (Install, Import, Set Default) */}
                  {!selected.installed && selected.sourceKind === "catalog" && (
                    <Button
                      variant="primary"
                      fullWidth
                      icon={<InstallIcon />}
                      disabled={!!busy}
                      onClick={() => act(t("pets.busy.installing"), () => api.installPet(selected.id))}
                    >
                      {busy || t("pets.detail.installPet")}
                    </Button>
                  )}
                  {!selected.installed && selected.sourceKind === "codex" && (
                    <Button
                      variant="warning"
                      fullWidth
                      icon={<ImportIcon />}
                      disabled={!!busy}
                      onClick={() => act(t("pets.busy.importing"), () => api.importCodexPet(selected.id))}
                    >
                      {busy || t("pets.detail.importCodexPet")}
                    </Button>
                  )}
                  {selected.installed && selected.id !== defaultId && !selected.broken && (
                    <Button
                      variant="primary"
                      fullWidth
                      icon={<SetDefaultIcon />}
                      disabled={!!busy}
                      onClick={() => act(t("pets.busy.settingDefault"), () => api.setDefaultPet(selected.id))}
                    >
                      {busy || t("pets.detail.setDefaultPet")}
                    </Button>
                  )}

                  <div className={`grid gap-3 ${selected.installed && !selected.builtIn && !selected.protected ? "grid-cols-2" : "grid-cols-1"}`}>
                    {selected.installed && !selected.builtIn && !selected.protected && (
                      <Button
                        variant="danger"
                        icon={<RemoveIcon />}
                        disabled={!!busy}
                        onClick={() => act(t("pets.busy.removing"), () => api.removePet(selected.id))}
                      >
                        {t("pets.detail.remove")}
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      icon={<RefreshIcon />}
                      disabled={!!busy}
                      onClick={() => void loadPetsData()}
                    >
                      {t("pets.detail.refresh")}
                    </Button>
                  </div>
                </div>
              </GlassCard>
            </div>
          ) : null}
        </div>
      )}
    </main>
  );
}

function App() {
  const [i18n, setI18n] = useState<I18nSnapshot | null>(null);

  const reloadI18n = React.useCallback(() => {
    void api.getI18n().then((snapshot) => {
      setI18n(snapshot);
      document.documentElement.lang = snapshot.locale;
    }).catch(() => undefined);
  }, []);
  useEffect(() => { reloadI18n(); }, [reloadI18n]);

  return (
    <I18nProvider snapshot={i18n} onReload={reloadI18n}>
      <ControlCenter />
    </I18nProvider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
