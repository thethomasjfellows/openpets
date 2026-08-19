import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { app, BrowserWindow, ipcMain, session, type RenderProcessGoneDetails } from "electron";

import {
  VoiceCaptureServiceCore,
  getVoiceCaptureAudioConstraints,
  type VoiceCapturePcmMessage,
  type VoiceCaptureRuntime,
  type VoiceCaptureWakeStart,
  type VoiceCaptureWindowHandle,
  type VoiceCaptureWindowMode,
} from "./voice-capture-core.js";
import { createVoiceCaptureWorkletSource, voiceCaptureWorkletProcessorName } from "./voice-capture-worklet.js";
import { debug } from "./logger.js";
import type { VoicePrivacyIndicator } from "./voice-privacy-indicator.js";
import type { VoiceWakeMicrophoneResolution } from "./voice-wake-types.js";

export type {
  VoiceCaptureHandle,
  VoiceCaptureOwner,
  VoiceCaptureResult,
} from "./voice-capture-core.js";

export const voiceCapturePcmFrameChannel = "openpets:voice-capture-pcm-frame";
export const voiceCaptureEndedChannel = "openpets:voice-capture-ended";

const voiceCaptureEndedReasons = new Set(["track-ended", "track-muted", "stream-inactive", "audio-context-closed", "worklet-error"]);

class ElectronCaptureWindow implements VoiceCaptureWindowHandle {
  readonly #window: BrowserWindow;
  readonly #pagePath: string;

  constructor(window: BrowserWindow, pagePath: string) {
    this.#window = window;
    this.#pagePath = pagePath;
  }

  get senderId(): number {
    return this.#window.webContents.id;
  }

  load(): Promise<void> {
    return this.#window.loadFile(this.#pagePath);
  }

  execute<T>(source: string): Promise<T> {
    return this.#window.webContents.executeJavaScript(source, true) as Promise<T>;
  }

  isDestroyed(): boolean {
    return this.#window.isDestroyed();
  }

  destroy(): void {
    this.#window.destroy();
  }

  onUnexpectedEnd(listener: (reason: string) => void): () => void {
    let delivered = false;
    const deliver = (reason: string) => {
      if (delivered) return;
      delivered = true;
      listener(reason);
    };
    const onClosed = () => deliver("window-closed");
    const onGone = (_event: unknown, details: RenderProcessGoneDetails) => deliver("renderer-" + details.reason);
    const onUnresponsive = () => deliver("renderer-unresponsive");
    const onCaptureEnded = (event: Electron.IpcMainEvent, reason: unknown) => {
      if (event.sender.id !== this.#window.webContents.id) return;
      if (typeof reason !== "string" || !voiceCaptureEndedReasons.has(reason)) return;
      deliver(reason);
    };
    this.#window.on("closed", onClosed);
    this.#window.on("unresponsive", onUnresponsive);
    this.#window.webContents.on("render-process-gone", onGone);
    ipcMain.on(voiceCaptureEndedChannel, onCaptureEnded);
    return () => {
      this.#window.removeListener("closed", onClosed);
      this.#window.removeListener("unresponsive", onUnresponsive);
      this.#window.webContents.removeListener("render-process-gone", onGone);
      ipcMain.removeListener(voiceCaptureEndedChannel, onCaptureEnded);
    };
  }
}

class ElectronVoiceCaptureRuntime implements VoiceCaptureRuntime {
  now(): number {
    return Date.now();
  }

  newSessionToken(): string {
    return randomUUID();
  }

  preparePartition(partition: string): void {
    const captureSession = session.fromPartition(partition, { cache: false });
    captureSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "media"));
    captureSession.setPermissionCheckHandler((_contents, permission) => permission === "media");
  }

  clearPartition(partition: string): Promise<void> {
    return session.fromPartition(partition).clearStorageData();
  }

  createWindow(options: { readonly partition: string; readonly mode: VoiceCaptureWindowMode }): VoiceCaptureWindowHandle {
    const preload = options.mode === "wake-pcm"
      ? join(app.getAppPath(), "voice-capture-preload.cjs")
      : undefined;
    const window = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
        partition: options.partition,
        ...(preload ? { preload } : {}),
      },
    });
    return new ElectronCaptureWindow(window, join(app.getAppPath(), "voice-capture.html"));
  }

  async startFiniteWav(window: VoiceCaptureWindowHandle): Promise<void> {
    try {
      await electronWindow(window).execute<void>(finiteWavStartScript);
    } catch (error) {
      throw voiceCaptureStartError("finite-wav", error);
    }
  }

  finishFiniteWav(window: VoiceCaptureWindowHandle, cancelled: boolean): Promise<string> {
    return electronWindow(window).execute<string>(createFiniteWavFinishScript(cancelled));
  }

  async startWakePcm(window: VoiceCaptureWindowHandle, config: VoiceCaptureWakeStart): Promise<VoiceWakeMicrophoneResolution> {
    try {
      return await electronWindow(window).execute<VoiceWakeMicrophoneResolution>(createWakePcmStartScript(config));
    } catch (error) {
      throw voiceCaptureStartError("wake-pcm", error);
    }
  }

  stopWakePcm(window: VoiceCaptureWindowHandle): Promise<void> {
    return electronWindow(window).execute<void>(wakePcmStopScript);
  }

  onPcmFrame(listener: (message: VoiceCapturePcmMessage) => void): () => void {
    const handler = (event: Electron.IpcMainEvent, payload: unknown) => {
      listener({ senderId: event.sender.id, payload });
    };
    ipcMain.on(voiceCapturePcmFrameChannel, handler);
    return () => { ipcMain.removeListener(voiceCapturePcmFrameChannel, handler); };
  }
}

export class VoiceCaptureService extends VoiceCaptureServiceCore {
  constructor(indicator: VoicePrivacyIndicator) {
    super(indicator, new ElectronVoiceCaptureRuntime(), (message, fields) => debug("app", message, fields));
  }
}

function electronWindow(window: VoiceCaptureWindowHandle): ElectronCaptureWindow {
  if (!(window instanceof ElectronCaptureWindow)) throw new Error("Voice capture window runtime mismatch.");
  return window;
}

function voiceCaptureStartError(mode: VoiceCaptureWindowMode, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  const reason = normalized.includes("notallowed") || normalized.includes("permission") || normalized.includes("denied")
    ? "permission-denied"
    : normalized.includes("notfound") || normalized.includes("no device")
      ? "device-unavailable"
      : normalized.includes("mediadevices") || normalized.includes("getusermedia")
        ? "media-api-unavailable"
        : "capture-start-failed";
  debug("app", "voice capture could not start", { mode, reason });
  if (reason === "permission-denied") {
    return new Error("Microphone access was denied. Allow OpenPets to use the microphone in system settings, then try again.");
  }
  if (reason === "device-unavailable") {
    return new Error("No microphone is available. Connect or enable a microphone, then try again.");
  }
  return new Error("The microphone could not start. Restart OpenPets and try again.");
}

const finiteWavStartScript = [
  "(async () => {",
  "  let stream;",
  "  let audioContext;",
  "  let source;",
  "  let node;",
  "  let sink;",
  "  try {",
  "    stream = await navigator.mediaDevices.getUserMedia({ audio: " + JSON.stringify(getVoiceCaptureAudioConstraints("finite-wav")) + " });",
  "    audioContext = new AudioContext({ latencyHint: 'interactive' });",
  "    const processorSource = " + JSON.stringify(createVoiceCaptureWorkletSource()) + ";",
  "    const moduleUrl = URL.createObjectURL(new Blob([processorSource], { type: 'text/javascript' }));",
  "    try { await audioContext.audioWorklet.addModule(moduleUrl); } finally { URL.revokeObjectURL(moduleUrl); }",
  "    source = audioContext.createMediaStreamSource(stream);",
  "    node = new AudioWorkletNode(audioContext, " + JSON.stringify(voiceCaptureWorkletProcessorName) + ", {",
  "      numberOfInputs: 1,",
  "      numberOfOutputs: 1,",
  "      outputChannelCount: [1],",
  "      processorOptions: { frameSamples: 480 },",
  "    });",
  "    sink = audioContext.createGain();",
  "    sink.gain.value = 0;",
  "    source.connect(node);",
  "    node.connect(sink);",
  "    sink.connect(audioContext.destination);",
  "    const frames = [];",
  "    let stopped = false;",
  "    node.port.onmessage = (event) => {",
  "      if (!stopped && event.data instanceof Float32Array && event.data.length === 480) frames.push(event.data);",
  "    };",
  "    await audioContext.resume();",
  "    const stop = async () => {",
  "      if (stopped) return;",
  "      stopped = true;",
  "      node.port.onmessage = null;",
  "      try { source.disconnect(); } catch {}",
  "      try { node.disconnect(); } catch {}",
  "      try { sink.disconnect(); } catch {}",
  "      for (const track of stream.getTracks()) track.stop();",
  "      try { await audioContext.close(); } catch {}",
  "    };",
  "    window.__openPetsVoiceCapture = { frames, stop };",
  "  } catch (error) {",
  "    try { source?.disconnect(); } catch {}",
  "    try { node?.disconnect(); } catch {}",
  "    try { sink?.disconnect(); } catch {}",
  "    try { for (const track of stream?.getTracks?.() ?? []) track.stop(); } catch {}",
  "    try { await audioContext?.close(); } catch {}",
  "    throw error;",
  "  }",
  "})()",
].join("\n");

function createFiniteWavFinishScript(cancelled: boolean): string {
  return [
    "(async () => {",
    "  const state = window.__openPetsVoiceCapture;",
    "  if (!state) return '';",
    "  window.__openPetsVoiceCapture = undefined;",
    "  await state.stop();",
    "  if (" + (cancelled ? "true" : "false") + ") return '';",
    "  const sampleCount = state.frames.reduce((total, frame) => total + frame.length, 0);",
    "  const bytes = new Uint8Array(44 + sampleCount * 2);",
    "  const view = new DataView(bytes.buffer);",
    "  const text = (offset, value) => { for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index)); };",
    "  text(0, 'RIFF'); view.setUint32(4, 36 + sampleCount * 2, true); text(8, 'WAVE');",
    "  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);",
    "  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);",
    "  text(36, 'data'); view.setUint32(40, sampleCount * 2, true);",
    "  let sampleOffset = 44;",
    "  for (const frame of state.frames) {",
    "    for (const raw of frame) {",
    "      const sample = Math.max(-1, Math.min(1, Number.isFinite(raw) ? raw : 0));",
    "      view.setInt16(sampleOffset, sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767), true);",
    "      sampleOffset += 2;",
    "    }",
    "  }",
    "  let binary = '';",
    "  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));",
    "  return btoa(binary);",
    "})()",
  ].join("\n");
}

function createWakePcmStartScript(config: VoiceCaptureWakeStart): string {
  const frameSamples = config.frameMs === 20 ? 320 : 480;
  const baseConstraints = getVoiceCaptureAudioConstraints("wake-pcm");
  const requestedDeviceId = config.microphone?.deviceId ?? "";
  const requestedDeviceLabel = config.microphone?.label ?? "";
  return [
    "(async () => {",
    "  const bridge = window.openPetsVoiceCapture;",
    "  if (!bridge || typeof bridge.emitPcmFrame !== 'function' || typeof bridge.emitCaptureEnded !== 'function') throw new Error('Voice capture bridge is unavailable.');",
    "  let stream;",
    "  let audioContext;",
    "  let source;",
    "  let node;",
    "  let sink;",
    "  const requestedDeviceId = " + JSON.stringify(requestedDeviceId) + ";",
    "  const requestedDeviceLabel = " + JSON.stringify(requestedDeviceLabel) + ";",
    "  let usedDefault = !requestedDeviceId && !requestedDeviceLabel;",
    "  let fallbackReason;",
    "  try {",
    "    const baseConstraints = " + JSON.stringify(baseConstraints) + ";",
    "    if (requestedDeviceId || requestedDeviceLabel) {",
    "      const devices = await navigator.mediaDevices.enumerateDevices();",
    "      const inputs = devices.filter((device) => device.kind === 'audioinput');",
    "      const matched = inputs.find((device) => device.deviceId === requestedDeviceId) || inputs.find((device) => requestedDeviceLabel && device.label === requestedDeviceLabel);",
    "      try {",
    "        if (!matched?.deviceId) throw new Error('saved-device-unavailable');",
    "        stream = await navigator.mediaDevices.getUserMedia({ audio: { ...baseConstraints, deviceId: { exact: matched.deviceId } } });",
    "        usedDefault = false;",
    "      } catch {",
    "        stream = await navigator.mediaDevices.getUserMedia({ audio: baseConstraints });",
    "        usedDefault = true;",
    "        fallbackReason = 'saved-device-unavailable';",
    "      }",
    "    } else {",
    "      stream = await navigator.mediaDevices.getUserMedia({ audio: baseConstraints });",
    "    }",
    "    audioContext = new AudioContext({ latencyHint: 'interactive' });",
    "    const processorSource = " + JSON.stringify(createVoiceCaptureWorkletSource()) + ";",
    "    const moduleUrl = URL.createObjectURL(new Blob([processorSource], { type: 'text/javascript' }));",
    "    try { await audioContext.audioWorklet.addModule(moduleUrl); } finally { URL.revokeObjectURL(moduleUrl); }",
    "    source = audioContext.createMediaStreamSource(stream);",
    "    node = new AudioWorkletNode(audioContext, " + JSON.stringify(voiceCaptureWorkletProcessorName) + ", {",
    "      numberOfInputs: 1,",
    "      numberOfOutputs: 1,",
    "      outputChannelCount: [1],",
    "      processorOptions: { frameSamples: " + frameSamples + " },",
    "    });",
    "    sink = audioContext.createGain();",
    "    sink.gain.value = 0;",
    "    source.connect(node);",
    "    node.connect(sink);",
    "    sink.connect(audioContext.destination);",
    "    const queue = [];",
    "    let drainScheduled = false;",
    "    let stopped = false;",
    "    let muteTimer;",
    "    const tracks = stream.getTracks();",
    "    const notifyEnded = (reason) => { if (!stopped) bridge.emitCaptureEnded(reason); };",
    "    const onTrackEnded = () => notifyEnded('track-ended');",
    "    const onTrackMute = () => { clearTimeout(muteTimer); muteTimer = setTimeout(() => notifyEnded('track-muted'), 5000); };",
    "    const onTrackUnmute = () => { clearTimeout(muteTimer); muteTimer = undefined; };",
    "    const onStreamInactive = () => notifyEnded('stream-inactive');",
    "    const onContextStateChange = () => { if (audioContext.state === 'closed') notifyEnded('audio-context-closed'); };",
    "    for (const track of tracks) { track.addEventListener('ended', onTrackEnded); track.addEventListener('mute', onTrackMute); track.addEventListener('unmute', onTrackUnmute); }",
    "    stream.addEventListener('inactive', onStreamInactive);",
    "    audioContext.addEventListener('statechange', onContextStateChange);",
    "    node.onprocessorerror = () => notifyEnded('worklet-error');",
    "    const drain = () => {",
    "      drainScheduled = false;",
    "      if (stopped) { queue.length = 0; return; }",
    "      const samples = queue.shift();",
    "      if (samples) bridge.emitPcmFrame({ generation: " + config.generation + ", sessionToken: " + JSON.stringify(config.sessionToken) + ", frameMs: " + config.frameMs + ", capturedAt: Date.now(), samples });",
    "      if (queue.length > 0) { drainScheduled = true; setTimeout(drain, 0); }",
    "    };",
    "    node.port.onmessage = (event) => {",
    "      if (stopped || !(event.data instanceof Float32Array) || event.data.length !== " + frameSamples + ") return;",
    "      if (queue.length >= 3) queue.shift();",
    "      queue.push(event.data);",
    "      if (!drainScheduled) { drainScheduled = true; setTimeout(drain, 0); }",
    "    };",
    "    await audioContext.resume();",
    "    const stop = async () => {",
    "      if (stopped) return;",
    "      stopped = true;",
    "      queue.length = 0;",
    "      clearTimeout(muteTimer);",
    "      muteTimer = undefined;",
    "      node.port.onmessage = null;",
    "      node.onprocessorerror = null;",
    "      for (const track of tracks) { track.removeEventListener('ended', onTrackEnded); track.removeEventListener('mute', onTrackMute); track.removeEventListener('unmute', onTrackUnmute); }",
    "      stream.removeEventListener('inactive', onStreamInactive);",
    "      audioContext.removeEventListener('statechange', onContextStateChange);",
    "      try { source.disconnect(); } catch {}",
    "      try { node.disconnect(); } catch {}",
    "      try { sink.disconnect(); } catch {}",
    "      for (const track of tracks) track.stop();",
    "      try { await audioContext.close(); } catch {}",
    "    };",
    "    window.__openPetsVoiceCapture = { stream, audioContext, source, node, sink, stop };",
    "    return { requestedDevice: Boolean(requestedDeviceId || requestedDeviceLabel), usedDefault, ...(fallbackReason ? { fallbackReason } : {}) };",
    "  } catch (error) {",
    "    try { source?.disconnect(); } catch {}",
    "    try { node?.disconnect(); } catch {}",
    "    try { sink?.disconnect(); } catch {}",
    "    try { for (const track of stream?.getTracks?.() ?? []) track.stop(); } catch {}",
    "    try { await audioContext?.close(); } catch {}",
    "    throw error;",
    "  }",
    "})()",
  ].join("\n");
}

const wakePcmStopScript = [
  "(async () => {",
  "  const state = window.__openPetsVoiceCapture;",
  "  window.__openPetsVoiceCapture = undefined;",
  "  if (state && typeof state.stop === 'function') await state.stop();",
  "})()",
].join("\n");
