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

describe("DirectorySkillViewLifecycle unregister", () => {
  test("retire waits for idle and disposes the old directory instance", async () => {
    const active = new Set(["A"]);
    const disposed: string[] = [];
    let observedActiveResolve!: () => void;
    const observedActive = new Promise<void>((resolve) => {
      observedActiveResolve = resolve;
    });
    const lifecycle = new DirectorySkillViewLifecycle({
      publish: async () => {},
      dispose: async ({ directoryInstanceKey }) => {
        disposed.push(directoryInstanceKey);
      },
      hasActiveRun: ({ directoryInstanceKey }) => {
        const isActive = active.has(directoryInstanceKey);
        if (isActive) observedActiveResolve();
        return isActive;
      },
      retryAfterMs: 1,
    });
    lifecycle.register({ directoryInstanceKey: "A", skillViewRevision: "a1" });

    const retirement = lifecycle.retire("A");
    await observedActive;
    expect(disposed).toEqual([]);
    expect(lifecycle.get("A")).toBeNull();

    active.delete("A");
    await expect(retirement).resolves.toBe(true);
    expect(disposed).toEqual(["A"]);
  });

  test("fences an in-flight initial publish so a reused key cannot resurrect it", async () => {
    let releasePublish!: () => void;
    let publishStartedResolve!: () => void;
    const publishStarted = new Promise<void>((resolve) => {
      publishStartedResolve = resolve;
    });
    const publishGate = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    const lifecycle = new DirectorySkillViewLifecycle({
      publish: async () => {
        publishStartedResolve();
        await publishGate;
      },
      dispose: async () => {},
      hasActiveRun: () => false,
    });

    const old = lifecycle.ensure({ directoryInstanceKey: "A", skillViewRevision: "a1" });
    await publishStarted;
    expect(lifecycle.unregister("A")).toBe(false);
    const replacement = lifecycle.ensure({ directoryInstanceKey: "A", skillViewRevision: "a2" });

    releasePublish();
    await expect(old).rejects.toThrow("directory instance retired");
    await expect(replacement).resolves.toMatchObject({
      status: "ready",
      instance: { directoryInstanceKey: "A", skillViewRevision: "a2", state: "ready" },
    });
    expect(lifecycle.get("A")).toMatchObject({ skillViewRevision: "a2", state: "ready" });
  });

  test("retire disposes after an in-flight initial publish that has no entry yet", async () => {
    let releasePublish!: () => void;
    let publishStartedResolve!: () => void;
    const publishStarted = new Promise<void>((resolve) => {
      publishStartedResolve = resolve;
    });
    const publishGate = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    const disposed: string[] = [];
    const lifecycle = new DirectorySkillViewLifecycle({
      publish: async () => {
        publishStartedResolve();
        await publishGate;
      },
      dispose: async ({ directoryInstanceKey }) => {
        disposed.push(directoryInstanceKey);
      },
      hasActiveRun: () => false,
    });

    const initial = lifecycle.ensure({ directoryInstanceKey: "A", skillViewRevision: "a1" });
    await publishStarted;
    const retirement = lifecycle.retire("A");

    releasePublish();
    await expect(initial).rejects.toThrow("directory instance retired");
    await expect(retirement).resolves.toBe(true);
    expect(disposed).toEqual(["A"]);
    expect(lifecycle.get("A")).toBeNull();
  });

  test("removes the entry so a later path reuse starts at a clean epoch", async () => {
    const h = harness();
    h.lifecycle.register({ directoryInstanceKey: "A", skillViewRevision: "a1" });
    await h.lifecycle.requestRefresh({ directoryInstanceKey: "A", skillViewRevision: "a2" });
    expect(h.lifecycle.get("A")?.directoryInstanceEpoch).toBe(1);

    expect(h.lifecycle.unregister("A")).toBe(true);
    expect(h.lifecycle.get("A")).toBeNull();

    // A reused path must not inherit the retired instance's epoch.
    h.lifecycle.register({ directoryInstanceKey: "A", skillViewRevision: "a3" });
    expect(h.lifecycle.get("A")?.directoryInstanceEpoch).toBe(0);
  });

  test("cancels a pending retry so it cannot resurrect the entry", async () => {
    const h = harness();
    h.lifecycle.register({ directoryInstanceKey: "A", skillViewRevision: "a1" });
    h.active.add("A");
    // An active run defers the refresh and schedules a completion retry.
    const deferred = await h.lifecycle.requestRefresh({
      directoryInstanceKey: "A",
      skillViewRevision: "a2",
    });
    expect(deferred.status).toBe("deferred");
    expect(h.retryCallbacks.length).toBe(1);

    h.lifecycle.unregister("A");

    expect(h.retryCallbacks.length).toBe(0);
    expect(h.lifecycle.get("A")).toBeNull();
  });

  test("unregistering one instance leaves the others untouched", () => {
    const h = harness();
    h.lifecycle.register({ directoryInstanceKey: "A", skillViewRevision: "a1" });
    h.lifecycle.register({ directoryInstanceKey: "B", skillViewRevision: "b1" });

    h.lifecycle.unregister("A");

    expect(h.lifecycle.get("A")).toBeNull();
    expect(h.lifecycle.get("B")?.skillViewRevision).toBe("b1");
    expect(h.lifecycle.snapshot().map((entry) => entry.directoryInstanceKey)).toEqual(["B"]);
  });

  test("unregistering an unknown or blank key is a no-op", () => {
    const h = harness();
    expect(h.lifecycle.unregister("missing")).toBe(false);
    expect(h.lifecycle.unregister("  ")).toBe(false);
  });
});
