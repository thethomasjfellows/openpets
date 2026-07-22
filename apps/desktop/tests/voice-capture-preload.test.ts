import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

type CaptureBridgeApi = {
  emitPcmFrame(payload: unknown): boolean;
  emitCaptureEnded(reason: unknown): boolean;
};

const desktopRoot = process.env.OPENPETS_DESKTOP_ROOT;
assert.ok(desktopRoot, "desktop test root is configured");
const preloadPath = join(desktopRoot, "voice-capture-preload.cjs");
const source = readFileSync(preloadPath, "utf8");
const sends: Array<{ channel: string; payload: unknown }> = [];
let exposedName = "";
let exposedApi: CaptureBridgeApi | null = null;

vm.runInNewContext(source, {
  Array,
  Float32Array,
  Number,
  Object,
  require(specifier: string) {
    assert.equal(specifier, "electron");
    return {
      contextBridge: {
        exposeInMainWorld(name: string, api: CaptureBridgeApi) {
          exposedName = name;
          exposedApi = api;
        },
      },
      ipcRenderer: {
        send(channel: string, payload: unknown) {
          sends.push({ channel, payload });
        },
      },
    };
  },
}, { filename: preloadPath });

assert.equal(exposedName, "openPetsVoiceCapture");
const api = exposedApi as CaptureBridgeApi | null;
assert.ok(api);
assert.equal(Object.isFrozen(api), true);

const valid = {
  generation: 1,
  sessionToken: "bounded-token",
  frameMs: 20,
  capturedAt: 1_000,
  samples: new Float32Array(320),
};
assert.equal(api.emitPcmFrame(valid), true);
assert.equal(sends.length, 1);
assert.equal(sends[0]?.channel, "openpets:voice-capture-pcm-frame");

assert.equal(api.emitCaptureEnded("track-ended"), true);
assert.equal(sends.length, 2);
assert.equal(sends[1]?.channel, "openpets:voice-capture-ended");
assert.equal(sends[1]?.payload, "track-ended");
assert.equal(api.emitCaptureEnded("arbitrary-reason"), false);
assert.equal(api.emitCaptureEnded({ reason: "track-ended" }), false);

assert.equal(api.emitPcmFrame({ ...valid, generation: 0 }), false);
assert.equal(api.emitPcmFrame({ ...valid, sessionToken: "" }), false);
assert.equal(api.emitPcmFrame({ ...valid, sessionToken: "x".repeat(129) }), false);
assert.equal(api.emitPcmFrame({ ...valid, frameMs: 30 }), false);
assert.equal(api.emitPcmFrame({ ...valid, capturedAt: Number.NaN }), false);
assert.equal(api.emitPcmFrame({ ...valid, samples: new Float32Array(319) }), false);
assert.equal(api.emitPcmFrame({ ...valid, samples: Array.from(valid.samples) }), false);
assert.equal(sends.length, 2, "invalid renderer payloads never reach Electron IPC");

console.log("wake PCM preload boundary verified");
