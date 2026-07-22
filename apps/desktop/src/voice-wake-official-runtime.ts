import { join } from "node:path";

import type { VoiceWakeHelperEvent } from "./voice-wake-helper-protocol.js";
import { createLiveKitVoiceWakeRuntime } from "./voice-wake-livekit-runtime.js";
import { createSherpaOnnxVoiceWakeRuntime, createSherpaVadVoiceWakeRuntime, type VoiceWakeHelperSpawner, type VoiceWakeRuntimeLog } from "./voice-wake-sherpa-runtime.js";
import { UnavailableVoiceWakeRuntime, type VoiceWakeRuntime, type VoiceWakeRuntimeHealth, type VoiceWakeRuntimeSelection, type VoiceWakeRuntimeSession, type VoiceWakeRuntimeStartConfig } from "./voice-wake-runtime.js";
import type { VoicePcmFrame } from "./voice-wake-types.js";

export function createProductionOfficialVoiceWakeRuntime(options: {
  readonly resourcesPath?: string;
  readonly spawnLiveKitHelper?: VoiceWakeHelperSpawner;
  readonly spawnSherpaHelper?: VoiceWakeHelperSpawner;
  readonly log?: VoiceWakeRuntimeLog;
} = {}): VoiceWakeRuntime {
  const resourcesPath = options.resourcesPath ?? (process as NodeJS.Process & { readonly resourcesPath?: string }).resourcesPath;
  if (!resourcesPath) return new UnavailableVoiceWakeRuntime("Wake word is not available: the packaged resource directory is missing.");
  const sherpaRoot = join(resourcesPath, "voice-wake", "sherpa-onnx");
  const shared = {
    ...(options.spawnSherpaHelper ? { spawnHelper: options.spawnSherpaHelper } : {}),
    ...(options.log ? { log: options.log } : {}),
  };
  return new OfficialVoiceWakeRuntime({
    livekit: createLiveKitVoiceWakeRuntime({
      bundleRoot: join(resourcesPath, "voice-wake", "livekit"),
      ...(options.spawnLiveKitHelper ? { spawnHelper: options.spawnLiveKitHelper } : {}),
      ...(options.log ? { log: options.log } : {}),
    }),
    vad: createSherpaVadVoiceWakeRuntime({ bundleRoot: sherpaRoot, ...shared }),
    custom: createSherpaOnnxVoiceWakeRuntime({ bundleRoot: sherpaRoot, ...shared }),
  });
}

export class OfficialVoiceWakeRuntime implements VoiceWakeRuntime {
  readonly #livekit: VoiceWakeRuntime;
  readonly #vad: VoiceWakeRuntime;
  readonly #custom: VoiceWakeRuntime;

  constructor(children: { readonly livekit: VoiceWakeRuntime; readonly vad: VoiceWakeRuntime; readonly custom: VoiceWakeRuntime }) {
    this.#livekit = children.livekit;
    this.#vad = children.vad;
    this.#custom = children.custom;
  }

  health(selection?: VoiceWakeRuntimeSelection): VoiceWakeRuntimeHealth {
    if (selection?.engine === "custom-sherpa") return this.#custom.health(selection);
    const livekit = this.#livekit.health(selection);
    const vad = this.#vad.health(selection);
    if (!livekit.ready) return livekit;
    if (!vad.ready) return { ...vad, method: "livekit-wakeword", modelId: livekit.modelId, reason: vad.reason ?? "Local voice activity detection is unavailable." };
    return livekit;
  }

  async start(config: VoiceWakeRuntimeStartConfig): Promise<VoiceWakeRuntimeSession> {
    if (config.engine === "custom-sherpa") return this.#custom.start(config);
    const keyword = await this.#livekit.start(config);
    try {
      const vad = await this.#vad.start(config);
      return new OfficialVoiceWakeSession(keyword, vad);
    } catch (error) {
      await keyword.stop();
      throw error;
    }
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([this.#livekit.dispose(), this.#vad.dispose(), this.#custom.dispose()]);
  }
}

class OfficialVoiceWakeSession implements VoiceWakeRuntimeSession {
  readonly #keyword: VoiceWakeRuntimeSession;
  readonly #vad: VoiceWakeRuntimeSession;
  readonly #listeners = new Set<(event: VoiceWakeHelperEvent) => void>();
  readonly #unsubscribers: Array<() => void>;
  #stopped = false;

  constructor(keyword: VoiceWakeRuntimeSession, vad: VoiceWakeRuntimeSession) {
    this.#keyword = keyword;
    this.#vad = vad;
    this.#unsubscribers = [
      keyword.onEvent((event) => {
        if (event.type === "keyword" || event.type === "error" || event.type === "log") this.#emit(event);
      }),
      vad.onEvent((event) => {
        if (event.type === "vad" || event.type === "error" || event.type === "log") this.#emit(event);
      }),
    ];
  }

  sendFrame(frame: VoicePcmFrame): void {
    if (this.#stopped) return;
    this.#keyword.sendFrame(frame);
    this.#vad.sendFrame(frame);
  }

  reset(): void {
    if (this.#stopped) return;
    this.#keyword.reset();
    this.#vad.reset();
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
    await Promise.allSettled([this.#keyword.stop(), this.#vad.stop()]);
    this.#listeners.clear();
  }

  onEvent(listener: (event: VoiceWakeHelperEvent) => void): () => void {
    if (!this.#stopped) this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #emit(event: VoiceWakeHelperEvent): void {
    for (const listener of [...this.#listeners]) { try { listener(event); } catch { /* listener isolation */ } }
  }
}
