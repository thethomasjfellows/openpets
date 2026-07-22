const { contextBridge, ipcRenderer } = require("electron");

const pcmFrameChannel = "openpets:voice-capture-pcm-frame";
const captureEndedChannel = "openpets:voice-capture-ended";
const captureEndedReasons = new Set(["track-ended", "track-muted", "stream-inactive", "audio-context-closed", "worklet-error"]);

function emitPcmFrame(payload) {
  if (!isValidPayload(payload)) return false;
  ipcRenderer.send(pcmFrameChannel, payload);
  return true;
}

function emitCaptureEnded(reason) {
  if (!captureEndedReasons.has(reason)) return false;
  ipcRenderer.send(captureEndedChannel, reason);
  return true;
}

function isValidPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  if (!Number.isInteger(payload.generation) || payload.generation < 1) return false;
  if (typeof payload.sessionToken !== "string" || payload.sessionToken.length < 1 || payload.sessionToken.length > 128) return false;
  if (payload.frameMs !== 20 && payload.frameMs !== 30) return false;
  if (!Number.isFinite(payload.capturedAt) || payload.capturedAt < 0) return false;
  if (!(payload.samples instanceof Float32Array)) return false;
  return payload.samples.length === (payload.frameMs === 20 ? 320 : 480);
}

contextBridge.exposeInMainWorld("openPetsVoiceCapture", Object.freeze({ emitPcmFrame, emitCaptureEnded }));
