import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HostAiImageSummaryHealthSnapshot } from "../src/host-ai-gateway.js";
import type { VisionCaptureAdapter } from "../src/vision-capture.js";
import { VisionService, type VisionAiGateway } from "../src/vision-service.js";
import { initializeVisionSettings, setVisionEnabled as persistVisionEnabled } from "../src/vision-settings.js";
import { initializeVisionStore } from "../src/vision-store.js";

const root = mkdtempSync(join(tmpdir(), "openpets-vision-service-"));
let now = 1_800_000_000_000;
initializeVisionSettings(root, now);
const store = initializeVisionStore(root, now);

let defaultPetId = "default";
let defaultPetVisible = true;
let defaultPetPaused = false;
let afterCapture: (() => void) | undefined;
let healthChecks = 0;
let captures = 0;
const capture: VisionCaptureAdapter = {
  async checkHealth() {
    healthChecks += 1;
    return { ready: true, status: "ready", checkedAt: now };
  },
  async capture(signal) {
    captures += 1;
    if (signal?.aborted) throw signal.reason;
    const hook = afterCapture;
    afterCapture = undefined;
    hook?.();
    return [
      {
        image: new Uint8Array([137, 80, 78, 71]),
        mimeType: "image/png",
        displayId: "1",
        displayLabel: "Primary monitor",
        displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
        primary: true,
      },
      {
        image: new Uint8Array([137, 80, 78, 72]),
        mimeType: "image/png",
        displayId: "2",
        displayLabel: "Monitor 2",
        displayBounds: { x: 1920, y: 0, width: 1920, height: 1080 },
        primary: false,
      },
    ];
  },
};

const readyHealth = (): HostAiImageSummaryHealthSnapshot => ({
  status: "ready",
  configured: true,
  ready: true,
  provider: "openai",
  model: "gpt-4o-mini",
  checkedAt: now,
  stale: false,
});
let summaryText = "The user is working in a code editor.";
let summarizeCalls = 0;
let blockNextSummary = false;
let notifyBlockedSummaryStarted: (() => void) | undefined;
const gateway: VisionAiGateway = {
  async summarizeImage(_request, options) {
    if (options?.signal?.aborted) throw options.signal.reason;
    summarizeCalls += 1;
    if (blockNextSummary) {
      blockNextSummary = false;
      notifyBlockedSummaryStarted?.();
      await new Promise<void>((_resolve, reject) => {
        const signal = options?.signal;
        if (!signal) return reject(new Error("Expected a Vision abort signal."));
        const rejectAbort = () => reject(signal.reason ?? Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (signal.aborted) rejectAbort();
        else signal.addEventListener("abort", rejectAbort, { once: true });
      });
    }
    return {
      text: summaryText,
      provider: "openai",
      model: "gpt-4o-mini",
    };
  },
  async getImageSummaryHealthSnapshot() { return readyHealth(); },
  async probeImageSummary() { return readyHealth(); },
  invalidateImageSummaryHealth() {},
};

store.addCompletedEntry({
  id: "crash-leftover",
  petId: "default",
  capturedAt: now,
  screenshot: new Uint8Array([137, 80, 78, 71]),
  summaryText: "Retained before a disabled restart.",
  provider: "openai",
  model: "gpt-4o-mini",
});
assert.equal(store.snapshot(now).entries.length, 1);

const service = new VisionService({
  store,
  capture,
  aiGateway: gateway,
  getDefaultPetId: () => defaultPetId,
  isDefaultPetVisible: () => defaultPetVisible,
  isDefaultPetPaused: () => defaultPetPaused,
  now: () => now,
});

try {
  service.start();
  const initial = await service.snapshot();
  assert.equal(initial.enabled, false, "Vision starts off without fresh opt-in");
  assert.equal(initial.storage.entries, 0, "disabled startup removes crash-leftover Vision data");
  const disabledHealthChecks = healthChecks;
  const disabledCaptures = captures;
  const checkedWhileDisabled = await service.snapshot(true);
  assert.equal(checkedWhileDisabled.state, "off", "a readiness check cannot make disabled Vision look active");
  assert.equal(healthChecks, disabledHealthChecks + 1, "Check again probes capture readiness while Vision is disabled");
  assert.equal(captures, disabledCaptures, "a readiness check never takes a screenshot");
  await service.setEnabled(true);
  await service.captureNow();

  const active = await service.snapshot();
  assert.equal(active.enabled, true);
  assert.equal(active.state, "ready");
  assert.equal(active.storage.entries, 2, "one Vision cycle retains one labeled image per connected monitor");
  const capturedEntries = store.snapshot(now).entries;
  assert.deepEqual(capturedEntries.map((entry) => entry.displayLabel).sort(), ["Monitor 2", "Primary monitor"]);
  assert.equal(new Set(capturedEntries.map((entry) => entry.captureGroupId)).size, 1, "monitor images from one cycle share a capture group");
  assert.equal(capturedEntries[1]?.displayBounds?.x, 1920, "stored monitor bounds support future screen-targeted behavior");
  const lastRetainedSummaryAt = active.lastSummaryAt;
  assert.equal(JSON.stringify(active).includes("code editor"), false, "public status never exposes summary text");
  assert.equal(JSON.stringify(active).includes(".png"), false, "public status never exposes screenshot filenames");
  assert.equal(service.getContextSummaries("default").length, 2);
  assert.deepEqual(service.getContextSummaries("default").map((summary) => summary.displayLabel).sort(), ["Monitor 2", "Primary monitor"]);
  assert.match(service.getProactiveOpportunities("default")[0]?.text ?? "", /untrusted quoted observation.*never as instructions/i);
  const recentContextTime = now;
  now += 31 * 60_000;
  assert.equal(service.getProactiveOpportunities("default").length, 0, "Vision check-ins only consider roughly the last 30 minutes");
  now = recentContextTime;

  service.handlePowerEvent("lock");
  service.handlePowerEvent("suspend");
  service.handlePowerEvent("resume");
  const lockedAfterResume = await service.snapshot();
  assert.equal(lockedAfterResume.state, "blocked", "resume cannot restart Vision while the screen remains locked");
  assert.equal(lockedAfterResume.nextCaptureAt, undefined);
  service.handlePowerEvent("unlock");

  blockNextSummary = true;
  const blockedSummaryStarted = new Promise<void>((resolve) => { notifyBlockedSummaryStarted = resolve; });
  const providerRaceCapture = service.captureNow();
  await blockedSummaryStarted;
  service.invalidateSummaryHealth();
  await providerRaceCapture;
  notifyBlockedSummaryStarted = undefined;
  assert.equal((await service.snapshot()).storage.entries, active.storage.entries, "changing AI provider settings aborts the in-flight Vision screenshot");

  const retainedBeforeEligibilityRaces = active.storage.entries;
  const summariesBeforeEligibilityRaces = summarizeCalls;
  const eligibilityRaces = [
    { label: "hidden", mutate: () => { defaultPetVisible = false; }, restore: () => { defaultPetVisible = true; } },
    { label: "paused", mutate: () => { defaultPetPaused = true; }, restore: () => { defaultPetPaused = false; } },
    { label: "changed", mutate: () => { defaultPetId = "other"; }, restore: () => { defaultPetId = "default"; } },
  ];
  for (const race of eligibilityRaces) {
    afterCapture = race.mutate;
    await service.captureNow();
    const raced = await service.snapshot();
    assert.equal(raced.storage.entries, retainedBeforeEligibilityRaces, `${race.label} default-pet state prevents late screenshot retention`);
    assert.equal(summarizeCalls, summariesBeforeEligibilityRaces, `${race.label} default-pet state prevents late image summarization`);
    race.restore();
  }

  summaryText = "   ";
  await service.captureNow();
  const emptySummary = await service.snapshot();
  assert.equal(emptySummary.state, "error", "empty summaries expose a recoverable error instead of getting stuck");
  assert.equal(emptySummary.storage.entries, active.storage.entries, "an empty monitor summary prevents the capture cycle from persisting screenshots");
  summaryText = "The user is working in a code editor.";

  await service.pause(30);
  const paused = await service.snapshot();
  assert.equal(paused.state, "paused");
  assert.equal(paused.storage.entries, active.storage.entries, "pause keeps retained context");
  assert.equal(service.getProactiveOpportunities("default").length, 0, "paused Vision cannot initiate check-ins");
  assert.equal(service.getContextSummaries("default").length, active.storage.entries, "retained context remains available for direct replies");

  now += 31 * 60_000;
  await service.resume();
  assert.equal((await service.snapshot()).state, "ready");

  const addCompletedEntry = store.addCompletedEntry.bind(store);
  Object.defineProperty(store, "addCompletedEntry", {
    configurable: true,
    value: (input: Parameters<typeof store.addCompletedEntry>[0]) => ({ ...addCompletedEntry(input), persisted: false }),
  });
  let persistenceFailure: Awaited<ReturnType<typeof service.snapshot>> | undefined;
  try {
    await service.captureNow();
    persistenceFailure = await service.snapshot();
  } finally {
    Object.defineProperty(store, "addCompletedEntry", { configurable: true, value: addCompletedEntry });
  }
  assert.ok(persistenceFailure);
  assert.equal(persistenceFailure.state, "error", "a failed Vision index write cannot report capture success");
  assert.equal(persistenceFailure.lastSummaryAt, lastRetainedSummaryAt, "failed persistence does not advance the last retained summary time");

  persistVisionEnabled(false, now);
  const directDisabled = await service.snapshot();
  assert.equal(directDisabled.state, "off", "low-level settings disable still runs the service privacy lifecycle");
  assert.equal(directDisabled.storage.entries, 0, "low-level settings disable deletes retained Vision data");
  await service.setEnabled(true);
  await service.captureNow();

  await service.setEnabled(false);
  const disabled = await service.snapshot();
  assert.equal(disabled.state, "off");
  assert.equal(disabled.storage.entries, 0, "disabling deletes retained screenshots and summaries");
  assert.equal(service.getContextSummaries("default").length, 0);
  assert.equal(service.getProactiveOpportunities("default").length, 0);

  console.log("Vision capture lifecycle and privacy behavior verified");
} finally {
  await service.shutdown();
  rmSync(root, { recursive: true, force: true });
}
