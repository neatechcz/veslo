import { describe, expect, test } from "bun:test";

import {
  createRunRegistry,
  MODEL_RETRY_NO_PROGRESS_HARD_MS,
  MODEL_RETRY_NO_PROGRESS_TIMEOUT,
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

    migrateWorkspaceId(sourceWorkspaceId, targetWorkspaceId) {
      return {
        migrated: false,
        sourceWorkspaceId,
        targetWorkspaceId,
        updated: 0,
        reason: "source_missing",
      };
    },

    activeForEngineOwner(engineOwnerId) {
      return [...records.values()]
        .filter((record) =>
          record.engineOwnerId === engineOwnerId &&
          isActiveRunStatus(record.status)
        )
        .sort((a, b) => a.createdAt - b.createdAt);
    },

    activeCreatedBefore(createdBefore, limit = 200) {
      return [...records.values()]
        .filter((record) =>
          isActiveRunStatus(record.status) &&
          record.createdAt < createdBefore
        )
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, limit);
    },
  };
}

function createRegistry(
  probe: (record: RunRecord) => Promise<RunProbeResult> | RunProbeResult,
  options: { modelRetryNoProgressHardMs?: number } = {},
) {
  const store = createMemoryRunStore();
  return {
    store,
    registry: createRunRegistry({
      store,
      probeRunActivity: async (record) => probe(record),
      ...(options.modelRetryNoProgressHardMs !== undefined
        ? { modelRetryNoProgressHardMs: options.modelRetryNoProgressHardMs }
        : {}),
      now: (() => {
        let current = MODEL_RETRY_NO_PROGRESS_HARD_MS + 10_000;
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

  test("active read reconciles stale active rows and returns no active run after completion", async () => {
    const { registry, store } = createRegistry(() => ({ active: false }));
    await registry.register(input);

    const active = await registry.active("ws-a", "conv-a");

    expect(active).toBeNull();
    expect(store.get("ws-a", "run-a")?.status).toBe("completed");
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

  test("markAborted terminalizes the run and releases the active lock", async () => {
    const { registry } = createRegistry(() => ({ active: true }));
    await registry.register(input);

    const aborted = registry.markAborted("ws-a", "run-a", "user abort reconciled");
    const next = await registry.register({ ...input, runId: "run-b" });

    expect(aborted?.status).toBe("aborted");
    expect(aborted?.abortRequested).toBe(true);
    expect(aborted?.error).toBe("user abort reconciled");
    expect(typeof aborted?.completedAt).toBe("number");
    expect(next.runId).toBe("run-b");
  });

  test("markEngineLost terminalizes only active runs from the lost engine generation", async () => {
    const { registry } = createRegistry(() => ({ active: true }));
    const engineOwner = {
      engineOwnerId: "ws-a",
      enginePid: 42,
      engineStartedAt: 7_000,
      engineBaseUrl: "http://127.0.0.1:5000",
    };
    await registry.register({ ...input, ...engineOwner });
    await registry.register({
      ...input,
      conversationId: "conv-b",
      runId: "run-b",
      engineSessionId: "sess-b",
      ...engineOwner,
    });
    await registry.register({
      ...input,
      conversationId: "conv-c",
      runId: "run-c",
      engineSessionId: "sess-c",
      enginePid: 99,
      engineStartedAt: 8_000,
      engineBaseUrl: "http://127.0.0.1:5001",
      engineOwnerId: "ws-a",
    });
    registry.markAbortRequested("ws-a", "run-b");

    const terminalized = registry.markEngineLost({
      ...engineOwner,
      error: "engine process lost",
    });

    expect(terminalized.map((item) => [item.runId, item.status])).toEqual([
      ["run-a", "failed"],
      ["run-b", "aborted"],
    ]);
    expect((await registry.get("ws-a", "run-a"))?.record.error).toBe("engine process lost");
    expect((await registry.get("ws-a", "run-b"))?.record.error).toContain("engine process lost");
    expect((await registry.get("ws-a", "run-c"))?.record.status).toBe("running");
  });

  test("startup sweep terminalizes only old active runs", async () => {
    const { registry, store } = createRegistry(() => ({ active: true }));
    await registry.register(input);
    await registry.register({
      ...input,
      conversationId: "conv-abort",
      runId: "run-abort",
      engineSessionId: "sess-abort",
    });
    await registry.register({
      ...input,
      conversationId: "conv-recent",
      runId: "run-recent",
      engineSessionId: "sess-recent",
    });
    store.update("ws-a", "run-a", { createdAt: 100, startedAt: 100 });
    store.update("ws-a", "run-abort", {
      createdAt: 200,
      startedAt: 200,
      abortRequested: true,
    });
    store.update("ws-a", "run-recent", { createdAt: 900, startedAt: 900 });

    const terminalized = registry.sweepLegacyActiveRuns({
      createdBefore: 500,
      error: "legacy startup sweep",
    });

    expect(terminalized.map((item) => [item.runId, item.status])).toEqual([
      ["run-a", "failed"],
      ["run-abort", "aborted"],
    ]);
    expect(store.get("ws-a", "run-a")).toMatchObject({
      status: "failed",
      error: "legacy startup sweep",
    });
    expect(store.get("ws-a", "run-abort")).toMatchObject({
      status: "aborted",
      abortRequested: true,
    });
    expect(store.get("ws-a", "run-recent")?.status).toBe("running");
  });

  test("attachEngineOwner binds active runs to the real engine generation", async () => {
    const { registry } = createRegistry(() => ({ active: true }));
    await registry.register(input);
    const engineOwner = {
      engineOwnerId: "ws-a",
      enginePid: 42,
      engineStartedAt: 7_000,
      engineBaseUrl: "http://127.0.0.1:5000",
    };

    const attached = registry.attachEngineOwner("ws-a", "run-a", engineOwner);
    const terminalized = registry.markEngineLost({
      ...engineOwner,
      error: "engine process lost",
    });

    expect(attached).toMatchObject(engineOwner);
    expect(terminalized.map((item) => [item.runId, item.status])).toEqual([["run-a", "failed"]]);
  });

  test("attachEngineOwner ignores terminal runs", async () => {
    const { registry } = createRegistry(() => ({ active: false }));
    await registry.register(input);
    await registry.get("ws-a", "run-a");

    const attached = registry.attachEngineOwner("ws-a", "run-a", {
      engineOwnerId: "ws-a",
      enginePid: 42,
      engineStartedAt: 7_000,
      engineBaseUrl: "http://127.0.0.1:5000",
    });

    expect(attached).toBeNull();
    expect((await registry.get("ws-a", "run-a"))?.record.engineOwnerId).toBeNull();
  });

  test("unreachable probe keeps last status stale", async () => {
    const { registry } = createRegistry(() => ({ unreachable: true }));
    await registry.register(input);

    const reconciled = await registry.latest("ws-a", "conv-a");

    expect(reconciled?.record.status).toBe("running");
    expect(reconciled?.stale).toBe(true);
  });

  test("active read remains active when the probe is unreachable", async () => {
    const { registry } = createRegistry(() => ({ unreachable: true }));
    await registry.register(input);

    const active = await registry.active("ws-a", "conv-a");

    expect(active?.record.runId).toBe("run-a");
    expect(active?.record.status).toBe("running");
    expect(active?.stale).toBe(true);
  });

  test("model retry no-output diagnostics persist without releasing the active lock", async () => {
    const { registry, store } = createRegistry(() => ({
      active: true,
      activityKind: "model_retry",
      waitReason: "model_retry_no_output",
      progressSignature: "assistant:empty",
    }));
    await registry.register(input);

    const active = await registry.active("ws-a", "conv-a");

    expect(active?.record.status).toBe("running");
    expect(active?.record.activityKind).toBe("model_retry");
    expect(active?.record.waitReason).toBe("model_retry_no_output");
    expect(typeof active?.record.retrySince).toBe("number");
    expect(active?.noProgressSeconds).toBe(0);
    await expect(registry.register({ ...input, runId: "run-b" })).rejects.toThrow(RunAlreadyActiveError);
    expect(store.activeForConversation("ws-a", "conv-a")?.runId).toBe("run-a");
  });

  test("model retry no-output hard threshold marks the run blocked but keeps queue admission locked", async () => {
    const { registry, store } = createRegistry(() => ({
      active: true,
      activityKind: "model_retry",
      waitReason: "model_retry_no_output",
      progressSignature: "assistant:empty",
    }));
    await registry.register(input);
    const first = await registry.active("ws-a", "conv-a");
    const retrySince = first?.record.retrySince;
    if (typeof retrySince !== "number") throw new Error("retrySince was not recorded");
    store.update("ws-a", "run-a", {
      retrySince: retrySince - MODEL_RETRY_NO_PROGRESS_HARD_MS - 1_000,
    });

    const blocked = await registry.active("ws-a", "conv-a");

    expect(blocked?.record.status).toBe("blocked");
    expect(blocked?.record.error).toBe(MODEL_RETRY_NO_PROGRESS_TIMEOUT);
    expect(blocked?.record.completedAt).toBeNull();
    expect(blocked?.noProgressSeconds).toBeGreaterThanOrEqual(601);
    await expect(registry.register({ ...input, runId: "run-b" })).rejects.toThrow(RunAlreadyActiveError);
  });

  test("model retry no-output hard threshold can be shortened by registry configuration", async () => {
    const { registry, store } = createRegistry(() => ({
      active: true,
      activityKind: "model_retry",
      waitReason: "model_retry_no_output",
      progressSignature: "assistant:empty",
    }), { modelRetryNoProgressHardMs: 1_000 });
    await registry.register(input);
    const first = await registry.active("ws-a", "conv-a");
    const retrySince = first?.record.retrySince;
    if (typeof retrySince !== "number") throw new Error("retrySince was not recorded");
    store.update("ws-a", "run-a", {
      retrySince: retrySince - 1_001,
    });

    const blocked = await registry.active("ws-a", "conv-a");

    expect(blocked?.record.status).toBe("blocked");
    expect(blocked?.record.error).toBe(MODEL_RETRY_NO_PROGRESS_TIMEOUT);
  });

  test("useful assistant progress clears retry diagnostics", async () => {
    let probe: RunProbeResult = {
      active: true,
      activityKind: "model_retry",
      waitReason: "model_retry_no_output",
      progressSignature: "assistant:empty",
    };
    const { registry } = createRegistry(() => probe);
    await registry.register(input);
    const retrying = await registry.active("ws-a", "conv-a");
    expect(retrying?.record.retrySince).not.toBeNull();

    probe = {
      active: true,
      activityKind: "assistant_output",
      waitReason: "assistant_message_open",
      progressSignature: "assistant:text:42",
    };
    const progressed = await registry.active("ws-a", "conv-a");

    expect(progressed?.record.status).toBe("running");
    expect(progressed?.record.activityKind).toBe("assistant_output");
    expect(progressed?.record.retrySince).toBeNull();
    expect(progressed?.record.lastProgressSignature).toBe("assistant:text:42");
    expect(progressed?.noProgressSeconds).toBeNull();
  });

  test("useful assistant progress clears blocked model retry timeout error", async () => {
    let probe: RunProbeResult = {
      active: true,
      activityKind: "model_retry",
      waitReason: "model_retry_no_output",
      progressSignature: "assistant:empty",
    };
    const { registry, store } = createRegistry(() => probe);
    await registry.register(input);
    const first = await registry.active("ws-a", "conv-a");
    const retrySince = first?.record.retrySince;
    if (typeof retrySince !== "number") throw new Error("retrySince was not recorded");
    store.update("ws-a", "run-a", {
      retrySince: retrySince - MODEL_RETRY_NO_PROGRESS_HARD_MS - 1_000,
    });
    const blocked = await registry.active("ws-a", "conv-a");
    expect(blocked?.record.status).toBe("blocked");
    expect(blocked?.record.error).toBe(MODEL_RETRY_NO_PROGRESS_TIMEOUT);

    probe = {
      active: true,
      activityKind: "assistant_output",
      waitReason: "assistant_message_open",
      progressSignature: "assistant:text:after-blocked",
    };
    const progressed = await registry.active("ws-a", "conv-a");

    expect(progressed?.record.status).toBe("running");
    expect(progressed?.record.error).toBeNull();
    expect(progressed?.record.activityKind).toBe("assistant_output");
    expect(progressed?.record.retrySince).toBeNull();
    expect(progressed?.record.lastProgressSignature).toBe("assistant:text:after-blocked");
    expect(progressed?.noProgressSeconds).toBeNull();
  });
});
