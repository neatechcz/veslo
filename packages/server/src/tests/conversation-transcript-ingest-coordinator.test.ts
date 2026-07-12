import { expect, test } from "bun:test";

import { createTranscriptIngestCoordinator } from "../conversation-transcript-ingest-coordinator.js";

const identity = {
  workspaceId: "ws-a",
  directory: "c:/work/repo",
  opencodeSessionId: "ses-a",
};

test("transcript ingest coordinator serializes concurrent requests into one follow-up read", async () => {
  let resolveRead: () => void = () => {
    throw new Error("read gate was not initialized");
  };
  const readGate = new Promise<void>((resolve) => {
    resolveRead = resolve;
  });
  let reads = 0;
  let writes = 0;
  let invalidations = 0;
  const coordinator = createTranscriptIngestCoordinator({
    readCanonicalTranscript: async () => {
      reads += 1;
      await readGate;
      return { complete: true, messages: [{ id: "msg-a" }], partsByMessageId: {} };
    },
    persistCanonicalTranscript: async () => {
      writes += 1;
    },
    invalidateTranscriptCaches: () => {
      invalidations += 1;
    },
  });

  const first = coordinator.request({ ...identity, trigger: "terminal-lifecycle", runId: "run-a" });
  const second = coordinator.request({ ...identity, trigger: "recovery" });
  resolveRead();

  await expect(first).resolves.toEqual({ kind: "unchanged", generation: 2 });
  await expect(second).resolves.toEqual({ kind: "unchanged", generation: 2 });
  expect(reads).toBe(2);
  expect(writes).toBe(1);
  expect(invalidations).toBe(1);
});

test("transcript ingest coordinator retries an incomplete canonical read with bounded delays and never persists it", async () => {
  let writes = 0;
  let reads = 0;
  const delays: number[] = [];
  const coordinator = createTranscriptIngestCoordinator({
    readCanonicalTranscript: async () => {
      reads += 1;
      return { complete: false, messages: [{ id: "partial" }], partsByMessageId: {} };
    },
    persistCanonicalTranscript: async () => {
      writes += 1;
    },
    invalidateTranscriptCaches: () => {},
    sleep: async (delayMs) => {
      delays.push(delayMs);
    },
  });

  await expect(coordinator.request({ ...identity, trigger: "recovery" })).resolves.toEqual({
    kind: "exhausted",
    generation: 1,
  });
  expect(reads).toBe(3);
  expect(delays).toEqual([2_000, 8_000]);
  expect(writes).toBe(0);
});

test("concurrent incomplete transcript requests exhaust the latest generation without looping", async () => {
  let releaseFirstRead: () => void = () => {
    throw new Error("read gate was not initialized");
  };
  const firstReadGate = new Promise<void>((resolve) => {
    releaseFirstRead = resolve;
  });
  let reads = 0;
  const coordinator = createTranscriptIngestCoordinator({
    readCanonicalTranscript: async () => {
      reads += 1;
      if (reads === 1) await firstReadGate;
      return { complete: false, messages: [], partsByMessageId: {} };
    },
    persistCanonicalTranscript: async () => {
      throw new Error("incomplete transcripts must not be persisted");
    },
    invalidateTranscriptCaches: () => {},
    retryDelaysMs: [0],
  });

  const first = coordinator.request({ ...identity, trigger: "terminal-lifecycle", runId: "run-a" });
  const second = coordinator.request({ ...identity, trigger: "recovery", runId: "run-a" });
  releaseFirstRead();

  await expect(first).resolves.toEqual({ kind: "exhausted", generation: 2 });
  await expect(second).resolves.toEqual({ kind: "exhausted", generation: 2 });
  expect(reads).toBe(2);
});

test("transcript ingest coordinator uses payload changes, not timestamps, for its watermark", async () => {
  let text = "partial";
  let writes = 0;
  const coordinator = createTranscriptIngestCoordinator({
    readCanonicalTranscript: async () => ({
      complete: true,
      messages: [{ id: "msg-a", updatedAt: 1 }],
      partsByMessageId: { "msg-a": [{ id: "part-a", text, updatedAt: 1 }] },
    }),
    persistCanonicalTranscript: async () => {
      writes += 1;
    },
    invalidateTranscriptCaches: () => {},
  });

  await coordinator.request({ ...identity, trigger: "terminal-lifecycle" });
  text = "final";
  await coordinator.request({ ...identity, trigger: "recovery" });

  expect(writes).toBe(2);
});
