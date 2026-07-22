import assert from "node:assert/strict";

import {
  createDesktopPermissionRestartController,
  desktopPermissionRestartMarker,
  DesktopPermissionService,
  isDesktopPermissionRestart,
  type DesktopPermissionDependencies,
} from "../src/desktop-permissions.js";

let microphoneStatus = "not-determined";
let screenStatus = "denied";
let microphoneRequests = 0;
let screenRequests = 0;
const opened: string[] = [];

const deps: DesktopPermissionDependencies = {
  platform: "darwin",
  executablePath: "/Users/test/openpets/apps/desktop/dist-electron/mac-arm64/OpenPets.app/Contents/MacOS/OpenPets",
  getMediaAccessStatus(kind) {
    return kind === "microphone" ? microphoneStatus : screenStatus;
  },
  async askForMicrophone() {
    microphoneRequests += 1;
    return false;
  },
  async requestScreenCapture() {
    screenRequests += 1;
    throw new Error("screen capture denied");
  },
  async openExternal(url) {
    opened.push(url);
  },
};

const service = new DesktopPermissionService(deps);
const initial = service.snapshot();
assert.equal(initial.appLocation, "development");
assert.equal(initial.permissions.microphone.status, "not-determined");
assert.equal(initial.permissions.microphone.requiresRestartAfterGrant, false, "microphone access takes effect without forcing an unnecessary relaunch");
assert.equal(initial.permissions["screen-recording"].requiresRestartAfterGrant, true);

await service.request("microphone");
assert.equal(microphoneRequests, 1);
assert.match(opened.at(-1) ?? "", /Privacy_Microphone/);

await service.request("screen-recording");
assert.equal(screenRequests, 1);
assert.match(opened.at(-1) ?? "", /Privacy_ScreenCapture/, "a denied capture probe still opens the exact recovery pane");

microphoneStatus = "granted";
screenStatus = "granted";
opened.length = 0;
await service.request("screen-recording");
assert.equal(opened.length, 0, "already-granted screen access does not reopen System Settings");
assert.equal(service.snapshot().permissions.microphone.status, "granted");

const probedService = new DesktopPermissionService({
  ...deps,
  getMediaAccessStatus: (kind) => kind === "screen" ? "denied" : "granted",
  probeScreenAccess: async () => "granted",
});
assert.equal(probedService.snapshot().permissions["screen-recording"].status, "denied");
assert.equal(
  (await probedService.refresh()).permissions["screen-recording"].status,
  "granted",
  "a successful real capture probe overrides a stale macOS status value",
);

const failedProbeOpened: string[] = [];
const failedProbeService = new DesktopPermissionService({
  ...deps,
  getMediaAccessStatus: (kind) => kind === "screen" ? "granted" : "granted",
  probeScreenAccess: async () => "denied",
  requestScreenCapture: async () => { throw new Error("current executable cannot capture"); },
  openExternal: async (url) => { failedProbeOpened.push(url); },
});
assert.equal(
  (await failedProbeService.refresh()).permissions["screen-recording"].status,
  "denied",
  "a failed real capture probe overrides stale granted metadata",
);
await failedProbeService.request("screen-recording");
assert.match(failedProbeOpened.at(-1) ?? "", /Privacy_ScreenCapture/, "failed real capture opens the recovery pane even when raw status says granted");

const relaunches: Array<{ readonly args: readonly string[] }> = [];
let exits = 0;
const restart = createDesktopPermissionRestartController({
  argv: ["/Applications/OpenPets.app/Contents/MacOS/openpets", "--existing"],
  relaunch(options) { relaunches.push(options); },
  exit() { exits += 1; },
});
assert.equal(restart.restart(), true);
assert.equal(restart.restart(), false, "repeated clicks must not schedule competing relaunches");
assert.deepEqual(relaunches, [{ args: ["--existing", desktopPermissionRestartMarker] }]);
assert.equal(exits, 1);
assert.equal(isDesktopPermissionRestart(relaunches[0]?.args ?? []), true);

console.log("Desktop permission workflow passed.");
