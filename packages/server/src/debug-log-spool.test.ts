import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { createDebugLogSpool } from "./debug-log-spool.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

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
