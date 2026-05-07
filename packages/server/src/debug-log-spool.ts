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
}

export function createDebugLogSpool(input: { dir: string; maxBytes: number }): DebugLogSpool {
  const eventDir = join(input.dir, EVENT_DIR_NAME);
  const manifestPath = join(input.dir, MANIFEST_FILE_NAME);

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
    let total = 0;
    for (const fileName of await listEventFiles()) {
      const info = await stat(join(eventDir, fileName));
      total += info.size;
    }
    if (await exists(manifestPath)) {
      total += (await stat(manifestPath)).size;
    }
    return total;
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
      if ((await currentSpoolBytes()) + newBytes > input.maxBytes) {
        throw new Error("Debug log spool is full");
      }

      await Promise.all(
        serialized.map((raw, index) => {
          const fileName = `${Date.now()}-${String(index).padStart(6, "0")}-${randomUUID()}.json`;
          return writeFile(join(eventDir, fileName), raw, "utf8");
        }),
      );
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
      const manifest = await readManifest();
      const leasedFiles = new Set(Object.values(manifest.leases).flatMap((lease) => lease.files));
      const candidates = (await listEventFiles()).filter((fileName) => !leasedFiles.has(fileName));
      const target = candidates.slice(0, maxCount);
      await Promise.all(target.map((fileName) => rm(join(eventDir, fileName), { force: true })));
      return target.length;
    },
  };
}
