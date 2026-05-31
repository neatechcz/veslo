import { randomUUID } from "node:crypto";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DebugLogBatch, DebugLogBatchLimits, DebugLogEvent } from "./debug-log-events.js";
import { parseDebugLogEvent, serializeDebugLogEvent } from "./debug-log-events.js";
import { ensureDir, exists, readJsonFile } from "./utils.js";

const EVENT_DIR_NAME = "events";
const MANIFEST_FILE_NAME = "manifest.json";
const DEFAULT_LEASE_TTL_MS = 60_000;

interface DebugLogSpoolManifest {
  leases: Record<string, { files: string[]; leasedAt: number }>;
}

interface DebugLogSpool {
  append(events: DebugLogEvent[]): Promise<void>;
  nextBatch(limits: DebugLogBatchLimits): Promise<DebugLogBatch | null>;
  ackBatch(batchId: string): Promise<void>;
  currentBytes(): Promise<number>;
  dropOldest(maxCount: number): Promise<number>;
  dropOldestUntilBelow(targetBytes: number): Promise<{ dropped: number; bytes: number }>;
}

export function createDebugLogSpool(input: { dir: string; maxBytes: number }): DebugLogSpool {
  const eventDir = join(input.dir, EVENT_DIR_NAME);
  const manifestPath = join(input.dir, MANIFEST_FILE_NAME);
  let cachedBytes: number | null = null;

  async function ensureLayout(): Promise<void> {
    await ensureDir(eventDir);
  }

  async function readManifest(): Promise<DebugLogSpoolManifest> {
    const manifest = await readJsonFile<DebugLogSpoolManifest>(manifestPath);
    return {
      leases: manifest?.leases ?? {},
    };
  }

  async function writeManifest(manifest: DebugLogSpoolManifest): Promise<void> {
    await ensureLayout();
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    cachedBytes = null;
  }

  async function listEventFiles(): Promise<string[]> {
    if (!(await exists(eventDir))) return [];
    const entries = await readdir(eventDir);
    return entries.filter((entry) => entry.endsWith(".json")).sort();
  }

  async function readEventsForFiles(fileNames: string[]): Promise<DebugLogEvent[]> {
    return Promise.all(
      fileNames.map(async (fileName) => {
        const raw = await readFile(join(eventDir, fileName), "utf8");
        return parseDebugLogEvent(raw);
      }),
    );
  }

  async function currentSpoolBytes(): Promise<number> {
    if (cachedBytes !== null) return cachedBytes;

    let total = 0;
    for (const fileName of await listEventFiles()) {
      try {
        const info = await stat(join(eventDir, fileName));
        total += info.size;
      } catch {
        continue;
      }
    }
    if (await exists(manifestPath)) {
      try {
        total += (await stat(manifestPath)).size;
      } catch {
        // The spool is best-effort; tolerate concurrent test or process cleanup.
      }
    }
    cachedBytes = total;
    return total;
  }

  async function removeEventFiles(fileNames: string[]): Promise<{ removed: number; removedBytes: number }> {
    let removed = 0;
    let removedBytes = 0;

    for (const fileName of fileNames) {
      const path = join(eventDir, fileName);
      let size = 0;
      try {
        size = (await stat(path)).size;
      } catch {
        continue;
      }
      await rm(path, { force: true });
      removed += 1;
      removedBytes += size;
    }

    if (cachedBytes !== null && removedBytes > 0) {
      cachedBytes = Math.max(0, cachedBytes - removedBytes);
    }

    return { removed, removedBytes };
  }

  async function leasedFileSet(): Promise<Set<string>> {
    const manifest = await readManifest();
    return new Set(Object.values(manifest.leases).flatMap((lease) => lease.files));
  }

  function pruneExpiredLeases(manifest: DebugLogSpoolManifest, now: number): DebugLogSpoolManifest {
    const leases = Object.fromEntries(
      Object.entries(manifest.leases).filter(([, lease]) => now - lease.leasedAt < DEFAULT_LEASE_TTL_MS),
    );
    return { leases };
  }

  return {
    async append(events) {
      if (events.length === 0) return;

      await ensureLayout();
      const serialized = events.map((event) => serializeDebugLogEvent(event));
      const newBytes = serialized.reduce((total, raw) => total + Buffer.byteLength(raw, "utf8"), 0);

      await Promise.all(
        serialized.map((raw, index) => {
          const fileName = `${Date.now()}-${String(index).padStart(6, "0")}-${randomUUID()}.json`;
          return writeFile(join(eventDir, fileName), raw, "utf8");
        }),
      );
      if (cachedBytes !== null) {
        cachedBytes += newBytes;
      }
    },

    async nextBatch(limits) {
      await ensureLayout();
      const now = Date.now();
      const manifest = pruneExpiredLeases(await readManifest(), now);
      const existingLease = Object.entries(manifest.leases).sort((left, right) => left[1].leasedAt - right[1].leasedAt)[0];
      if (existingLease) {
        const [batchId, lease] = existingLease;
        return {
          batchId,
          events: await readEventsForFiles(lease.files),
        };
      }

      const leasedFiles = new Set(Object.values(manifest.leases).flatMap((lease) => lease.files));
      const pendingFiles = (await listEventFiles()).filter((fileName) => !leasedFiles.has(fileName));

      const selectedFiles: string[] = [];
      let totalBytes = 0;

      for (const fileName of pendingFiles) {
        const raw = await readFile(join(eventDir, fileName), "utf8");
        const eventBytes = Buffer.byteLength(raw, "utf8");
        if (
          selectedFiles.length > 0 &&
          (selectedFiles.length + 1 > limits.maxEvents || totalBytes + eventBytes > limits.maxBytes)
        ) {
          break;
        }

        selectedFiles.push(fileName);
        totalBytes += eventBytes;
      }

      if (selectedFiles.length === 0) {
        if (Object.keys(manifest.leases).length > 0 || (await exists(manifestPath))) {
          await writeManifest(manifest);
        }
        return null;
      }

      const batchId = randomUUID();
      manifest.leases[batchId] = { files: selectedFiles, leasedAt: now };
      await writeManifest(manifest);
      return {
        batchId,
        events: await readEventsForFiles(selectedFiles),
      };
    },

    async ackBatch(batchId) {
      const manifest = await readManifest();
      const lease = manifest.leases[batchId];
      if (!lease) return;

      await Promise.all(lease.files.map((fileName) => rm(join(eventDir, fileName), { force: true })));
      delete manifest.leases[batchId];
      await writeManifest(manifest);
    },

    async currentBytes() {
      return currentSpoolBytes();
    },

    async dropOldest(maxCount) {
      if (maxCount <= 0) return 0;
      const leasedFiles = await leasedFileSet();
      const candidates = (await listEventFiles()).filter((fileName) => !leasedFiles.has(fileName));
      const target = candidates.slice(0, maxCount);
      const { removed } = await removeEventFiles(target);
      return removed;
    },

    async dropOldestUntilBelow(targetBytes) {
      const target = Math.max(0, targetBytes);
      let bytes = await currentSpoolBytes();
      if (bytes <= target) return { dropped: 0, bytes };

      const leasedFiles = await leasedFileSet();
      const candidates = (await listEventFiles()).filter((fileName) => !leasedFiles.has(fileName));
      const selected: string[] = [];
      let selectedBytes = 0;

      for (const fileName of candidates) {
        if (bytes - selectedBytes <= target) break;
        try {
          const info = await stat(join(eventDir, fileName));
          selected.push(fileName);
          selectedBytes += info.size;
        } catch {
          selected.push(fileName);
        }
      }

      const { removed, removedBytes } = await removeEventFiles(selected);
      bytes = Math.max(0, bytes - removedBytes);
      if (cachedBytes !== null) {
        bytes = cachedBytes;
      }
      return { dropped: removed, bytes };
    },
  };
}
