import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import type { DebugLogEvent } from "../debug-log-events.js";
import { createDebugLogSpool } from "../debug-log-spool.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function event(id: string, payload: Record<string, unknown> = { text: "hello" }): DebugLogEvent {
  return {
    id,
    userId: "usr_1",
    orgId: "org_1",
    workspaceId: "ws_1",
    source: "engine",
    stream: "stdout",
    timestamp: 100,
    sequenceNo: 1,
    payload,
  };
}

test("spool persists queued events and acknowledges uploaded batches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "veslo-debug-log-spool-"));
  tempDirs.push(dir);

  const spool = createDebugLogSpool({ dir, maxBytes: 1024 * 1024 });
  await spool.append([
    {
      id: "evt-1",
      userId: "usr_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      source: "engine",
      stream: "stdout",
      timestamp: 100,
      sequenceNo: 1,
      payload: { text: "hello" },
    },
  ]);

  const batch = await spool.nextBatch({ maxEvents: 10, maxBytes: 64 * 1024 });
  expect(batch?.events.map((entry) => entry.id)).toEqual(["evt-1"]);

  await spool.ackBatch(batch!.batchId);
  const next = await spool.nextBatch({ maxEvents: 10, maxBytes: 64 * 1024 });
  expect(next).toBeNull();
});

test("spool resumes an existing lease with the same batch id after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "veslo-debug-log-spool-"));
  tempDirs.push(dir);

  const spool = createDebugLogSpool({ dir, maxBytes: 1024 * 1024 });
  await spool.append([
    {
      id: "evt-1",
      userId: "usr_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      source: "engine",
      stream: "stdout",
      timestamp: 100,
      sequenceNo: 1,
      payload: { text: "hello" },
    },
  ]);

  const firstBatch = await spool.nextBatch({ maxEvents: 10, maxBytes: 64 * 1024 });
  const restartedSpool = createDebugLogSpool({ dir, maxBytes: 1024 * 1024 });
  const resumedBatch = await restartedSpool.nextBatch({ maxEvents: 10, maxBytes: 64 * 1024 });

  expect(resumedBatch?.batchId).toBe(firstBatch?.batchId);
  expect(resumedBatch?.events.map((entry) => entry.id)).toEqual(["evt-1"]);
});

test("spool append accepts events even when the local backlog is already over the byte cap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "veslo-debug-log-spool-"));
  tempDirs.push(dir);

  const spool = createDebugLogSpool({ dir, maxBytes: 512 });
  await spool.append([event("evt-large", { filler: "x".repeat(900) })]);
  await spool.append([event("evt-next", { text: "accepted while retention catches up" })]);

  const batch = await spool.nextBatch({ maxEvents: 10, maxBytes: 64 * 1024 });
  expect(batch?.events.map((entry) => entry.id)).toContain("evt-next");
});

test("spool drops old unleased events to a target byte size in one retention call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "veslo-debug-log-spool-"));
  tempDirs.push(dir);

  const spool = createDebugLogSpool({ dir, maxBytes: 512 * 1024 });
  const filler = "x".repeat(900);
  await spool.append(
    Array.from({ length: 90 }, (_value, index) =>
      event(`evt-${String(index).padStart(3, "0")}`, { filler }),
    ),
  );

  const leasedBatch = await spool.nextBatch({ maxEvents: 3, maxBytes: 64 * 1024 });
  const leasedIds = leasedBatch?.events.map((entry) => entry.id);
  expect(leasedIds).toHaveLength(3);

  const result = await spool.dropOldestUntilBelow(18 * 1024);

  expect(result.dropped).toBeGreaterThan(0);
  expect(result.bytes).toBeLessThanOrEqual(18 * 1024);
  const resumedBatch = await spool.nextBatch({ maxEvents: 10, maxBytes: 64 * 1024 });
  expect(resumedBatch?.batchId).toBe(leasedBatch?.batchId);
  expect(resumedBatch?.events.map((entry) => entry.id)).toEqual(leasedIds);
});
