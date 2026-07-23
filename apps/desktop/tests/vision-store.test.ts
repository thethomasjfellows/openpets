import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  initializeVisionStore,
  maxVisionEntries,
  visionRetentionMs,
} from "../src/vision-store.js";

const root = mkdtempSync(join(tmpdir(), "openpets-vision-store-"));
const now = 1_800_000_000_000;

try {
  const store = initializeVisionStore(root, now);
  assert.equal(store.snapshot(now).entries.length, 0);
  const malformedOrphan = join(store.screenshotsDirectory, "legacy-capture.tmp");
  writeFileSync(malformedOrphan, "orphan");
  store.prune(now);
  assert.equal(existsSync(malformedOrphan), false, "the Vision-owned store removes malformed orphan files");
  const crashTempIndex = join(store.storageDirectory, "openpets-vision-index.json.123.tmp");
  writeFileSync(crashTempIndex, JSON.stringify({ entries: [{ summaryText: "sensitive crash leftover" }] }));
  store.prune(now);
  assert.equal(existsSync(crashTempIndex), false, "pruning removes crash-leftover Vision index temp files");

  const first = store.addCompletedEntry({
    id: "first",
    petId: "default",
    capturedAt: now - 1_000,
    screenshot: new Uint8Array([137, 80, 78, 71]),
    summaryText: "The user is working in a code editor.",
    provider: "openai",
    model: "gpt-4o-mini",
  });
  assert.equal(first.persisted, true);
  assert.equal(store.getContextSummaries({ petId: "default", now }).length, 1);
  const context = store.getContextSummaries({ petId: "default", now })[0]!;
  assert.deepEqual(Object.keys(context).sort(), ["capturedAt", "id", "summaryText"], "context never exposes screenshot paths or bytes");
  assert.throws(() => store.addCompletedEntry({
    id: "first",
    petId: "default",
    capturedAt: now,
    screenshot: new Uint8Array([1, 2, 3, 4]),
    summaryText: "A colliding entry must not replace retained context.",
    provider: "openai",
    model: "gpt-4o-mini",
  }), /already exists/);
  assert.equal(existsSync(join(store.screenshotsDirectory, "first.png")), true, "rejecting an id collision preserves the retained screenshot");
  assert.equal(store.getContextSummaries({ petId: "default", now })[0]?.summaryText, "The user is working in a code editor.");

  const compressed = store.addCompletedEntry({
    id: "compressed",
    petId: "default",
    capturedAt: now,
    screenshot: new Uint8Array([255, 216, 255, 217]),
    mimeType: "image/jpeg",
    summaryText: "The user is reviewing a dashboard.",
    provider: "openrouter",
    model: "provider/vision-model",
  });
  assert.equal(compressed.entry.screenshotFileName, "compressed.jpg");
  assert.equal(compressed.entry.mimeType, "image/jpeg");
  assert.equal(compressed.entry.provider, "openrouter", "OpenRouter Vision context remains valid after persistence");
  assert.equal(existsSync(join(store.screenshotsDirectory, "compressed.jpg")), true);

  store.addCompletedEntry({
    id: "expired",
    petId: "default",
    capturedAt: now - visionRetentionMs - 1,
    screenshot: new Uint8Array([1, 2, 3, 4]),
    summaryText: "Expired context.",
    provider: "openai",
    model: "gpt-4o-mini",
  });
  store.prune(now);
  assert.equal(store.snapshot(now).entries.some((entry) => entry.id === "expired"), false);
  assert.equal(existsSync(join(store.screenshotsDirectory, "expired.png")), false, "expired screenshots are deleted");

  for (let index = 0; index < maxVisionEntries + 4; index += 1) {
    store.addCompletedEntry({
      id: `bounded-${index}`,
      petId: "default",
      capturedAt: now + index,
      screenshot: new Uint8Array([index % 255 || 1]),
      summaryText: `Bounded summary ${index}`,
      provider: "openai",
      model: "gpt-4o-mini",
    });
  }
  assert.equal(store.snapshot(now + maxVisionEntries + 4).entries.length, maxVisionEntries, "retention is entry bounded");

  const disableTempIndex = join(store.storageDirectory, "openpets-vision-index.json.456.tmp");
  writeFileSync(disableTempIndex, JSON.stringify({ entries: [{ summaryText: "sensitive disable leftover" }] }));
  const cleared = store.deleteAll();
  assert.equal(cleared.entries.length, 0);
  assert.equal(existsSync(disableTempIndex), false, "disable removes crash-leftover Vision index temp files");
  assert.deepEqual(readdirSync(store.screenshotsDirectory), [], "disable/delete-all removes retained screenshots");

  console.log("Vision store retention and privacy behavior verified");
} finally {
  rmSync(root, { recursive: true, force: true });
}
