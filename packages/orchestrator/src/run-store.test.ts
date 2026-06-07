import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { createRunStore, type RunRecord } from "./run-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

async function createTempStore() {
  const dir = await mkdtemp(join(tmpdir(), "veslo-run-store-"));
  tempDirs.push(dir);
  return createRunStore({ dbPath: join(dir, "runs.sqlite") });
}

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    workspaceId: "ws-a",
    conversationId: "conv-a",
    runId: "run-a",
    engineSessionId: "sess-a",
    directory: "/tmp/workspace-a",
    kind: "prompt",
    status: "running",
    abortRequested: false,
    createdAt: 1_000,
    startedAt: 1_000,
    completedAt: null,
    error: null,
    ...overrides,
  };
}

describe("run store", () => {
  test("activeForConversation excludes terminal records", async () => {
    const store = await createTempStore();
    store.insert(record());

    expect(store.activeForConversation("ws-a", "conv-a")?.runId).toBe("run-a");

    store.update("ws-a", "run-a", {
      status: "completed",
      completedAt: 2_000,
    });

    expect(store.activeForConversation("ws-a", "conv-a")).toBeNull();
  });

  test("sqlite enforces one active run per conversation", async () => {
    const store = await createTempStore();
    store.insert(record());

    expect(() => store.insert(record({
      runId: "run-b",
      engineSessionId: "sess-b",
      createdAt: 1_100,
      startedAt: 1_100,
    }))).toThrow();
  });
});
