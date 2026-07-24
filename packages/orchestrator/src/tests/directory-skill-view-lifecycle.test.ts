import { describe, expect, test } from "bun:test";

import { DirectorySkillViewLifecycle } from "../directory-skill-view-lifecycle.js";

function harness() {
  const active = new Set<string>();
  const activeRunIds = new Map<string, Set<string>>();
  const published: Array<{ directoryInstanceKey: string; skillViewRevision: string }> = [];
  const disposed: string[] = [];
  const retryCallbacks: Array<() => void> = [];
  const lifecycle = new DirectorySkillViewLifecycle({
    publish: async (input) => { published.push(input); },
    dispose: async (input) => { disposed.push(input.directoryInstanceKey); },
    hasActiveRun: ({ directoryInstanceKey, excludeRunId }) => {
      if (active.has(directoryInstanceKey)) return true;
      return [...(activeRunIds.get(directoryInstanceKey) ?? [])].some((runId) => runId !== excludeRunId);
    },
    retryAfterMs: 123,
    retryScheduler: {
      schedule: (callback) => {
        retryCallbacks.push(callback);
        return callback;
      },
      cancel: (handle) => {
        const index = retryCallbacks.indexOf(handle as () => void);
        if (index >= 0) retryCallbacks.splice(index, 1);
      },
    },
  });
  return { active, activeRunIds, published, disposed, retryCallbacks, lifecycle };
}

describe("DirectorySkillViewLifecycle", () => {
  test("refreshes A with a new epoch while B remains ready", async () => {
    const h = harness();
    h.lifecycle.register({ directoryInstanceKey: "A", skillViewRevision: "a1" });
    h.lifecycle.register({ directoryInstanceKey: "B", skillViewRevision: "b1" });
    h.active.add("B");

    const refreshed = await h.lifecycle.requestRefresh({ directoryInstanceKey: "A", skillViewRevision: "a2" });

    expect(refreshed).toEqual({
      status: "ready",
      instance: {
        directoryInstanceKey: "A",
        directoryInstanceEpoch: 1,
        skillViewRevision: "a2",
        state: "ready",
      },
    });
    expect(h.published).toEqual([{ directoryInstanceKey: "A", skillViewRevision: "a2" }]);
    expect(h.disposed).toEqual(["A"]);
    expect(h.lifecycle.get("B")).toEqual({
      directoryInstanceKey: "B",
      directoryInstanceEpoch: 0,
      skillViewRevision: "b1",
      state: "ready",
    });
  });

  test("closes A admission while A is active and completes the deferred refresh after idle", async () => {
    const h = harness();
    h.lifecycle.register({ directoryInstanceKey: "A", skillViewRevision: "a1" });
    h.lifecycle.register({ directoryInstanceKey: "B", skillViewRevision: "b1" });
    h.active.add("A");
    h.active.add("B");

    const deferred = await h.lifecycle.requestRefresh({ directoryInstanceKey: "A", skillViewRevision: "a2" });

    expect(deferred).toEqual({
      status: "deferred",
      retryAfterMs: 123,
      instance: {
        directoryInstanceKey: "A",
        directoryInstanceEpoch: 0,
        skillViewRevision: "a1",
        pendingSkillViewRevision: "a2",
        state: "draining",
      },
    });
    expect(h.lifecycle.admit("A")).toEqual({ admitted: false, retryAfterMs: 123, state: "draining" });
    expect(h.lifecycle.admit("B")).toMatchObject({ admitted: true });
    expect(h.retryCallbacks).toHaveLength(1);

    h.active.delete("A");
    h.retryCallbacks.shift()?.();
    await Bun.sleep(0);

    expect(h.disposed).toEqual(["A"]);
    expect(h.lifecycle.get("A")).toMatchObject({
      directoryInstanceEpoch: 1,
      skillViewRevision: "a2",
      state: "ready",
    });
    expect(h.lifecycle.get("B")).toMatchObject({
      directoryInstanceEpoch: 0,
      skillViewRevision: "b1",
      state: "ready",
    });
  });

  test("excludes the just-registered target run while retaining other active runs", async () => {
    const h = harness();
    h.lifecycle.register({ directoryInstanceKey: "A", skillViewRevision: "a1" });
    h.activeRunIds.set("A", new Set(["target-run"]));

    const refreshed = await h.lifecycle.requestRefresh({
      directoryInstanceKey: "A",
      skillViewRevision: "a2",
      excludeRunId: "target-run",
    });

    expect(refreshed.status).toBe("ready");
    expect(h.disposed).toEqual(["A"]);

    h.lifecycle.register({ directoryInstanceKey: "B", skillViewRevision: "b1" });
    h.activeRunIds.set("B", new Set(["old-run", "target-run"]));
    const deferred = await h.lifecycle.requestRefresh({
      directoryInstanceKey: "B",
      skillViewRevision: "b2",
      excludeRunId: "target-run",
    });
    expect(deferred.status).toBe("deferred");
  });

  test("serializes concurrent first publication for one directory", async () => {
    const h = harness();
    const [first, second] = await Promise.all([
      h.lifecycle.ensure({ directoryInstanceKey: "A", skillViewRevision: "a1" }),
      h.lifecycle.ensure({ directoryInstanceKey: "A", skillViewRevision: "a1" }),
    ]);

    expect(first.status).toBe("ready");
    expect(second.status).toBe("ready");
    expect(h.published).toEqual([{ directoryInstanceKey: "A", skillViewRevision: "a1" }]);
    expect(h.lifecycle.get("A")).toMatchObject({ directoryInstanceEpoch: 0, skillViewRevision: "a1", state: "ready" });
  });

  test("restores the last ready lifecycle state when publish fails", async () => {
    const lifecycle = new DirectorySkillViewLifecycle({
      publish: async ({ skillViewRevision }) => {
        if (skillViewRevision === "a2") throw new Error("publish failed");
      },
      dispose: async () => {},
      hasActiveRun: () => false,
    });
    lifecycle.register({ directoryInstanceKey: "A", skillViewRevision: "a1" });

    await expect(lifecycle.requestRefresh({ directoryInstanceKey: "A", skillViewRevision: "a2" })).rejects.toThrow("publish failed");
    expect(lifecycle.get("A")).toEqual({
      directoryInstanceKey: "A",
      directoryInstanceEpoch: 0,
      skillViewRevision: "a1",
      state: "ready",
    });
  });
});
