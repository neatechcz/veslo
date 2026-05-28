import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDebugLogPipeline } from "./debug-log-pipeline.js";
import type { DebugLogConfig } from "./types.js";
import type { DebugLogEvent } from "./debug-log-events.js";

function makeEvent(overrides: Partial<DebugLogEvent> = {}): DebugLogEvent {
  return {
    id: overrides.id ?? `evt-${Math.random().toString(36).slice(2)}`,
    userId: "u1",
    orgId: "o1",
    workspaceId: "w1",
    source: "test",
    stream: "stdout",
    timestamp: Date.now() * 1_000_000,
    sequenceNo: 0,
    payload: { line: "hello" },
    ...overrides,
  };
}

function makeConfig(overrides: Partial<DebugLogConfig> = {}): DebugLogConfig {
  return {
    enabled: false,
    ingestUrl: null,
    ingestToken: null,
    batchMaxEvents: 100,
    batchMaxBytes: 64 * 1024,
    spoolMaxBytes: 1 * 1024 * 1024,
    flushIntervalMs: 60_000,
    ...overrides,
  };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "vslo-174-pipeline-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("debug-log-pipeline", () => {
  test("disabled pipeline appends to spool but never calls fetch", async () => {
    await withTempDir(async (dir) => {
      let fetchCalls = 0;
      const fetchImpl = (async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ acceptedBatchIds: [] }), { status: 200 });
      }) as unknown as typeof fetch;

      const pipeline = createDebugLogPipeline({
        config: makeConfig({ enabled: false }),
        spoolDir: dir,
        fetchImpl,
      });

      await pipeline.append(makeEvent());
      await pipeline.flushNow();
      expect(fetchCalls).toBe(0);
      expect(pipeline.isEnabled()).toBe(false);

      await pipeline.shutdown();
    });
  });

  test("enabled pipeline uploads via uploader and acks the batch", async () => {
    await withTempDir(async (dir) => {
      const acceptedBatches: string[] = [];
      const fetchImpl = (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { batchId: string };
        acceptedBatches.push(body.batchId);
        return new Response(JSON.stringify({ acceptedBatchIds: [body.batchId] }), { status: 200 });
      }) as typeof fetch;

      const pipeline = createDebugLogPipeline({
        config: makeConfig({
          enabled: true,
          ingestUrl: "https://den.example/v1/internal/debug-logs",
          ingestToken: "tok",
          flushIntervalMs: 60_000,
        }),
        spoolDir: dir,
        fetchImpl,
      });

      await pipeline.append([makeEvent({ id: "a" }), makeEvent({ id: "b" })]);
      await pipeline.flushNow();
      expect(acceptedBatches.length).toBe(1);
      expect(pipeline.isEnabled()).toBe(true);

      // Spool should be empty after ack — flushing again does nothing.
      await pipeline.flushNow();
      expect(acceptedBatches.length).toBe(1);

      await pipeline.shutdown();
    });
  });

  test("retention drops oldest events when spool exceeds high-water threshold", async () => {
    await withTempDir(async (dir) => {
      const droppedWarnings: string[] = [];
      const logger = {
        log: (level: "info" | "warn" | "error", message: string) => {
          if (level === "warn") droppedWarnings.push(message);
        },
      };

      // tiny spool: 16 KB, with retention thresholds 90%/70%.
      const fetchImpl = (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { batchId: string };
        return new Response(JSON.stringify({ acceptedBatchIds: [body.batchId] }), { status: 200 });
      }) as typeof fetch;

      const pipeline = createDebugLogPipeline({
        config: makeConfig({
          enabled: true,
          ingestUrl: "https://den.example/v1/internal/debug-logs",
          ingestToken: "tok",
          spoolMaxBytes: 16 * 1024,
        }),
        spoolDir: dir,
        logger,
        fetchImpl,
      });

      // ~512 bytes per event payload → 100 events ~50 KB → far over 16 KB.
      const filler = "x".repeat(450);
      for (let i = 0; i < 100; i += 1) {
        await pipeline.append(makeEvent({ id: `e${i}`, payload: { filler } }));
      }

      // At least one retention warning should have been logged.
      expect(droppedWarnings.some((msg) => msg.includes("retention"))).toBe(true);

      await pipeline.shutdown();
    });
  });

  test("shutdown is idempotent and stops the flush loop", async () => {
    await withTempDir(async (dir) => {
      const pipeline = createDebugLogPipeline({
        config: makeConfig(),
        spoolDir: dir,
      });
      await pipeline.shutdown();
      await pipeline.shutdown();
    });
  });
});
