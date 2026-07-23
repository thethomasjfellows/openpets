import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import { hostAiProviderIds, type AiBrainProviderKind } from "./host-ai-settings.js";
import { assertSafeCompanionPetId } from "./companion-settings.js";

export type VisionStoredEntry = {
  readonly id: string;
  readonly petId: string;
  readonly capturedAt: number;
  readonly expiresAt: number;
  readonly screenshotFileName: string;
  readonly screenshotBytes: number;
  readonly mimeType: "image/png" | "image/jpeg";
  readonly summaryText: string;
  readonly summaryCreatedAt: number;
  readonly provider: AiBrainProviderKind;
  readonly model: string;
};

export type VisionContextSummary = {
  readonly id: string;
  readonly capturedAt: number;
  readonly summaryText: string;
};

export type VisionStoreSnapshot = {
  readonly version: 1;
  readonly entries: readonly VisionStoredEntry[];
  readonly screenshotBytes: number;
  readonly oldestAt?: number;
  readonly newestAt?: number;
  readonly lastPurgeAt?: number;
  readonly deleteError: boolean;
  readonly persisted: boolean;
};

export type AddVisionEntryInput = {
  readonly id?: string;
  readonly petId: string;
  readonly capturedAt?: number;
  readonly screenshot: Uint8Array;
  readonly mimeType?: "image/png" | "image/jpeg";
  readonly summaryText: string;
  readonly summaryCreatedAt?: number;
  readonly provider: AiBrainProviderKind;
  readonly model: string;
};

export const visionRetentionMs = 24 * 60 * 60 * 1_000;
export const maxVisionEntries = 72;
export const maxVisionScreenshotBytes = 1 * 1_024 * 1_024;
export const maxVisionRetainedScreenshotBytes = 48 * 1_024 * 1_024;
export const maxVisionSummaryCharacters = 900;
export const maxVisionIndexBytes = 512 * 1_024;
export const visionStorageDirectoryName = "openpets-vision";

const maxFutureSkewMs = 5 * 60 * 1_000;
const safeEntryIdPattern = /^[A-Za-z0-9._:-]{1,120}$/;
const visionIndexTempPattern = /^openpets-vision-index\.json\.\d+\.tmp$/;
const providers = new Set<AiBrainProviderKind>(["none", ...hostAiProviderIds, "codex"]);

export class VisionStore {
  readonly storageDirectory: string;
  readonly screenshotsDirectory: string;
  readonly indexPath: string;

  #entries: VisionStoredEntry[] = [];
  #lastPurgeAt: number | undefined;
  #deleteError = false;
  #persisted = true;

  constructor(userDataPath: string, now = Date.now()) {
    this.storageDirectory = join(userDataPath, visionStorageDirectoryName);
    this.screenshotsDirectory = join(this.storageDirectory, "screenshots");
    this.indexPath = join(this.storageDirectory, "openpets-vision-index.json");
    mkdirSync(this.screenshotsDirectory, { recursive: true, mode: 0o700 });
    this.#cleanupIndexTemps();
    this.#entries = this.#readEntries();
    this.prune(now);
  }

  snapshot(now = Date.now()): VisionStoreSnapshot {
    this.prune(now);
    const screenshotBytes = this.#entries.reduce((total, entry) => total + entry.screenshotBytes, 0);
    return {
      version: 1,
      entries: this.#entries.map((entry) => ({ ...entry })),
      screenshotBytes,
      ...(this.#entries[0] ? { oldestAt: this.#entries[0].capturedAt } : {}),
      ...(this.#entries.at(-1) ? { newestAt: this.#entries.at(-1)!.capturedAt } : {}),
      ...(this.#lastPurgeAt === undefined ? {} : { lastPurgeAt: this.#lastPurgeAt }),
      deleteError: this.#deleteError,
      persisted: this.#persisted,
    };
  }

  addCompletedEntry(input: AddVisionEntryInput): { readonly entry: VisionStoredEntry; readonly persisted: boolean } {
    assertSafeCompanionPetId(input.petId);
    const id = input.id ?? randomUUID();
    if (!safeEntryIdPattern.test(id)) throw new Error("Invalid Vision entry id.");
    if (this.#entries.some((entry) => entry.id === id)) throw new Error("Vision entry id already exists.");
    if (!(input.screenshot instanceof Uint8Array) || input.screenshot.byteLength === 0
      || input.screenshot.byteLength > maxVisionScreenshotBytes) {
      throw new Error("Vision screenshot is empty or exceeds the local size limit.");
    }
    const summaryText = normalizeSummary(input.summaryText);
    if (!summaryText) throw new Error("Vision summary is required.");
    const capturedAt = normalizeTimestamp(input.capturedAt ?? Date.now());
    const summaryCreatedAt = normalizeTimestamp(input.summaryCreatedAt ?? capturedAt);
    const mimeType = input.mimeType ?? "image/png";
    const screenshotFileName = `${id}.${mimeType === "image/jpeg" ? "jpg" : "png"}`;
    const screenshotPath = join(this.screenshotsDirectory, screenshotFileName);
    const temporaryPath = `${screenshotPath}.${process.pid}.tmp`;
    const entry: VisionStoredEntry = {
      id,
      petId: input.petId,
      capturedAt,
      expiresAt: capturedAt + visionRetentionMs,
      screenshotFileName,
      screenshotBytes: input.screenshot.byteLength,
      mimeType,
      summaryText,
      summaryCreatedAt,
      provider: providers.has(input.provider) ? input.provider : "none",
      model: normalizeModel(input.model),
    };

    mkdirSync(this.screenshotsDirectory, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(temporaryPath, input.screenshot, { mode: 0o600 });
      renameSync(temporaryPath, screenshotPath);
      const previous = this.#entries;
      const next = this.#normalizeEntries([...previous, entry], capturedAt);
      this.#entries = next;
      const persisted = this.#persist();
      if (!persisted) {
        this.#entries = previous;
        this.#removeScreenshot(screenshotFileName);
        return { entry, persisted: false };
      }
      this.#cleanupOrphans();
      return { entry, persisted: true };
    } catch (error) {
      try { rmSync(temporaryPath, { force: true }); } catch { /* best effort */ }
      this.#removeScreenshot(screenshotFileName);
      throw error;
    }
  }

  getContextSummaries(input: {
    readonly petId: string;
    readonly now?: number;
    readonly limit?: number;
  }): readonly VisionContextSummary[] {
    assertSafeCompanionPetId(input.petId);
    const now = input.now ?? Date.now();
    this.prune(now);
    const limit = Math.max(0, Math.min(8, Math.floor(input.limit ?? 4)));
    if (limit === 0) return [];
    return this.#entries
      .filter((entry) => entry.petId === input.petId)
      .slice(-limit)
      .map((entry) => ({ id: entry.id, capturedAt: entry.capturedAt, summaryText: entry.summaryText }));
  }

  prune(now = Date.now()): VisionStoreSnapshot {
    const normalizedNow = normalizeTimestamp(now);
    const previousFiles = new Map(this.#entries.map((entry) => [entry.id, entry.screenshotFileName]));
    const next = this.#normalizeEntries(this.#entries, normalizedNow);
    const nextIds = new Set(next.map((entry) => entry.id));
    this.#entries = next;
    for (const [id, fileName] of previousFiles) {
      if (!nextIds.has(id)) this.#removeScreenshot(fileName);
    }
    this.#cleanupOrphans();
    this.#cleanupIndexTemps();
    this.#lastPurgeAt = normalizedNow;
    this.#persist();
    return this.#snapshotWithoutPrune();
  }

  deleteAll(): VisionStoreSnapshot {
    this.#entries = [];
    this.#deleteError = false;
    try {
      rmSync(this.screenshotsDirectory, { recursive: true, force: true });
      mkdirSync(this.screenshotsDirectory, { recursive: true, mode: 0o700 });
    } catch {
      this.#deleteError = true;
    }
    this.#cleanupIndexTemps();
    this.#persist();
    return this.#snapshotWithoutPrune();
  }

  #snapshotWithoutPrune(): VisionStoreSnapshot {
    const screenshotBytes = this.#entries.reduce((total, entry) => total + entry.screenshotBytes, 0);
    return {
      version: 1,
      entries: this.#entries.map((entry) => ({ ...entry })),
      screenshotBytes,
      ...(this.#entries[0] ? { oldestAt: this.#entries[0].capturedAt } : {}),
      ...(this.#entries.at(-1) ? { newestAt: this.#entries.at(-1)!.capturedAt } : {}),
      ...(this.#lastPurgeAt === undefined ? {} : { lastPurgeAt: this.#lastPurgeAt }),
      deleteError: this.#deleteError,
      persisted: this.#persisted,
    };
  }

  #readEntries(): VisionStoredEntry[] {
    try {
      if (!existsSync(this.indexPath) || statSync(this.indexPath).size > maxVisionIndexBytes) return [];
      const parsed = JSON.parse(readFileSync(this.indexPath, "utf8")) as unknown;
      if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return [];
      return this.#normalizeEntries(parsed.entries, Date.now());
    } catch {
      return [];
    }
  }

  #normalizeEntries(value: readonly unknown[], now: number): VisionStoredEntry[] {
    const cutoff = now - visionRetentionMs;
    const futureLimit = now + maxFutureSkewMs;
    const candidates: VisionStoredEntry[] = [];

    for (const item of value) {
      if (!isRecord(item)
        || typeof item.id !== "string"
        || !safeEntryIdPattern.test(item.id)
        || typeof item.petId !== "string"
        || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(item.petId)
        || typeof item.capturedAt !== "number"
        || !Number.isFinite(item.capturedAt)
        || typeof item.screenshotFileName !== "string"
        || typeof item.summaryCreatedAt !== "number"
        || !Number.isFinite(item.summaryCreatedAt)
        || typeof item.provider !== "string"
        || !providers.has(item.provider as AiBrainProviderKind)) continue;
      const mimeType = item.mimeType === "image/jpeg" && item.screenshotFileName === `${item.id}.jpg`
        ? "image/jpeg" as const
        : (item.mimeType === "image/png" || item.mimeType === undefined) && item.screenshotFileName === `${item.id}.png`
          ? "image/png" as const
          : undefined;
      if (!mimeType) continue;
      const capturedAt = Math.floor(item.capturedAt);
      if (capturedAt < cutoff || capturedAt > futureLimit) continue;
      const summaryText = normalizeSummary(item.summaryText);
      const screenshotPath = join(this.screenshotsDirectory, item.screenshotFileName);
      if (!summaryText || basename(screenshotPath) !== item.screenshotFileName || !existsSync(screenshotPath)) continue;
      let screenshotBytes = 0;
      try { screenshotBytes = statSync(screenshotPath).size; } catch { continue; }
      if (screenshotBytes <= 0 || screenshotBytes > maxVisionScreenshotBytes) continue;
      candidates.push({
        id: item.id,
        petId: item.petId,
        capturedAt,
        expiresAt: capturedAt + visionRetentionMs,
        screenshotFileName: item.screenshotFileName,
        screenshotBytes,
        mimeType,
        summaryText,
        summaryCreatedAt: Math.floor(item.summaryCreatedAt),
        provider: item.provider as AiBrainProviderKind,
        model: normalizeModel(item.model),
      });
    }

    candidates.sort((left, right) => left.capturedAt - right.capturedAt || left.id.localeCompare(right.id));
    const kept: VisionStoredEntry[] = [];
    let totalBytes = 0;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const entry = candidates[index]!;
      if (kept.length >= maxVisionEntries || totalBytes + entry.screenshotBytes > maxVisionRetainedScreenshotBytes) continue;
      kept.push(entry);
      totalBytes += entry.screenshotBytes;
    }
    kept.reverse();
    return kept;
  }

  #cleanupIndexTemps(): void {
    let names: string[] = [];
    try { names = readdirSync(this.storageDirectory); } catch { return; }
    for (const name of names) {
      if (!visionIndexTempPattern.test(name)) continue;
      try {
        rmSync(join(this.storageDirectory, name), { force: true });
      } catch {
        this.#deleteError = true;
      }
    }
  }

  #cleanupOrphans(): void {
    const retained = new Set(this.#entries.map((entry) => entry.screenshotFileName));
    let names: string[] = [];
    try { names = readdirSync(this.screenshotsDirectory); } catch { return; }
    for (const name of names) {
      if (!retained.has(name)) this.#removeOrphan(name);
    }
  }

  #removeOrphan(name: string): void {
    if (!name || name === "." || name === ".." || basename(name) !== name) return;
    try {
      rmSync(join(this.screenshotsDirectory, name), { recursive: true, force: true });
    } catch {
      this.#deleteError = true;
    }
  }

  #removeScreenshot(fileName: string): void {
    if (!/^[A-Za-z0-9._:-]{1,120}\.(?:png|jpg)$/.test(fileName)) return;
    try {
      rmSync(join(this.screenshotsDirectory, fileName), { force: true });
    } catch {
      this.#deleteError = true;
    }
  }

  #persist(): boolean {
    const temporaryPath = `${this.indexPath}.${process.pid}.tmp`;
    try {
      mkdirSync(this.storageDirectory, { recursive: true, mode: 0o700 });
      const serialized = `${JSON.stringify({ version: 1, entries: this.#entries }, null, 2)}\n`;
      if (Buffer.byteLength(serialized, "utf8") > maxVisionIndexBytes) {
        this.#persisted = false;
        return false;
      }
      writeFileSync(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
      renameSync(temporaryPath, this.indexPath);
      this.#persisted = true;
      return true;
    } catch {
      try { rmSync(temporaryPath, { force: true }); } catch { /* best effort */ }
      this.#persisted = false;
      return false;
    }
  }
}

export function initializeVisionStore(userDataPath: string, now = Date.now()): VisionStore {
  return new VisionStore(userDataPath, now);
}

function normalizeSummary(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\0/g, "").replace(/\s+/g, " ").trim().slice(0, maxVisionSummaryCharacters)
    : "";
}

function normalizeModel(value: unknown): string {
  return typeof value === "string" ? value.replace(/\0/g, "").trim().slice(0, 120) : "";
}

function normalizeTimestamp(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Invalid Vision timestamp.");
  return Math.floor(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
