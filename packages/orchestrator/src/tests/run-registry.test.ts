import { describe, expect, test } from "bun:test";

import {
  createRunRegistry,
  RunAlreadyActiveError,
  type RunProbeResult,
} from "../run-registry.js";
import { isActiveRunStatus, type RunRecord, type RunStore } from "../run-store.js";

const input = {
  workspaceId: "ws-a",
  conversationId: "conv-a",
  runId: "run-a",
  engineSessionId: "sess-a",
  directory: "/tmp/workspace-a",
  kind: "prompt" as const,
};

function createMemoryRunStore(): RunStore {
  const records = new Map<string, RunRecord>();
  const key = (workspaceId: string, runId: string) => `${workspaceId}:${runId}`;

  return {
    insert(record) {
      records.set(key(record.workspaceId, record.runId), { ...record });
    },

    update(workspaceId, runId, patch) {
      const current = records.get(key(workspaceId, runId));
      if (!current) return null;
      const next = { ...current, ...patch };
      records.set(key(workspaceId, runId), next);
      return next;
    },

    get(workspaceId, runId) {
      return records.get(key(workspaceId, runId)) ?? null;
    },

    latestForConversation(workspaceId, conversationId) {
      return [...records.values()]
        .filter((record) => record.workspaceId === workspaceId && record.conversationId === conversationId)
        .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
    },

    activeForConversation(workspaceId, conversationId) {
      return [...records.values()]
        .filter((record) =>
          record.workspaceId === workspaceId &&
          record.conversationId === conversationId &&
          isActiveRunStatus(record.status)
        )
        .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
    },

    hasActiveForWorkspace(workspaceId, createdSince) {
      return [...records.values()].some((record) =>
        record.workspaceId === workspaceId &&
        isActiveRunStatus(record.status) &&
        record.createdAt >= createdSince
      );
    },
  };
}

function createRegistry(probe: (record: RunRecord) => Promise<RunProbeResult> | RunProbeResult) {
  const store = createMemoryRunStore();
  return {
    store,
    registry: createRunRegistry({
      store,
      probeRunActivity: async (record) => probe(record),
      now: (() => {
        let current = 1_000;
        return () => current += 100;
      })(),
    }),
  };
}

describe("run registry", () => {
  test("register stores a running run", async () => {
    const { registry } = createRegistry(() => ({ active: true }));

    const record = await registry.register(input);

    expect(record.status).toBe("running");
    expect(typeof record.startedAt).toBe("number");
  });

  test("second concurrent register throws while active remains active", async () => {
    const { registry } = createRegistry(() => ({ active: true }));
    await registry.register(input);

    await expect(registry.register({ ...input, runId: "run-b" })).rejects.toThrow(RunAlreadyActiveError);
  });

  test("register reconciles a stale active run before rejecting", async () => {
    const { registry } = createRegistry(() => ({ active: false }));
    await registry.register(input);

    const second = await registry.register({ ...input, runId: "run-b" });

    expect(second.runId).toBe("run-b");
    expect((await registry.get("ws-a", "run-a"))?.record.status).toBe("completed");
  });

  test("register keeps blocking when an active run probe is unreachable", async () => {
    const { registry } = createRegistry(() => ({ unreachable: true }));
    await registry.register(input);

    await expect(registry.register({ ...input, runId: "run-b" })).rejects.toThrow(RunAlreadyActiveError);

    const active = await registry.latest("ws-a", "conv-a");
    expect(active?.record.runId).toBe("run-a");
    expect(active?.record.status).toBe("running");
    expect(active?.stale).toBe(true);
  });

  test("abort intent is metadata and inactive reconcile completes the run", async () => {
    const { registry } = createRegistry(() => ({ active: false }));
    await registry.register(input);
    registry.markAbortRequested("ws-a", "run-a");

    const reconciled = await registry.get("ws-a", "run-a");

    expect(reconciled?.record.status).toBe("completed");
    expect(reconciled?.record.abortRequested).toBe(true);
  });

  test("unreachable probe keeps last status stale", async () => {
    const { registry } = createRegistry(() => ({ unreachable: true }));
    await registry.register(input);

    const reconciled = await registry.latest("ws-a", "conv-a");

    expect(reconciled?.record.status).toBe("running");
    expect(reconciled?.stale).toBe(true);
  });
});
