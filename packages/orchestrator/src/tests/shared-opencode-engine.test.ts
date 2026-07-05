import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";

import { SharedOpenCodeEngine } from "../shared-opencode-engine.js";
import type { EngineSpawnResult } from "../engine-pool.js";

function fakeChild(pid: number): ChildProcess {
  return { pid } as ChildProcess;
}

function harness(options: {
  failSpawn?: boolean;
  failHealth?: boolean;
  failHealthCheck?: boolean;
  waitForHealthy?: () => Promise<void>;
  onEngineChange?: (event: string, engine: { pid: number } | null) => void;
} = {}) {
  let spawns = 0;
  let stops = 0;
  let nextPort = 61000;
  const stoppedPids: number[] = [];
  const alive = new Set<number>();

  const manager = new SharedOpenCodeEngine({
    runtimeDirectory: "/tmp/veslo/shared-opencode-runtime",
    configDirectory: "/tmp/veslo/shared-opencode-config",
    deps: {
      prepareRuntime: async () => undefined,
      findFreePort: async () => nextPort++,
      spawnEngine: async ({ port }): Promise<EngineSpawnResult> => {
        spawns++;
        if (options.failSpawn) throw new Error("spawn failed");
        const child = fakeChild(1000 + spawns);
        alive.add(child.pid!);
        return { child, baseUrl: `http://127.0.0.1:${port}` };
      },
      waitForHealthy: async () => {
        if (options.waitForHealthy) return await options.waitForHealthy();
        if (options.failHealth) throw new Error("health failed");
      },
      healthCheck: async () => {
        if (options.failHealthCheck) throw new Error("health probe failed");
      },
      stopChild: async (child) => {
        stops++;
        if (child.pid) {
          stoppedPids.push(child.pid);
          alive.delete(child.pid);
        }
      },
      isProcessAlive: (pid) => alive.has(pid),
      now: () => 123456,
      onEngineChange: options.onEngineChange,
    },
  });

  return {
    manager,
    counts: () => ({ spawns, stops, stoppedPids }),
    markDead: (pid: number) => {
      alive.delete(pid);
    },
  };
}

describe("SharedOpenCodeEngine", () => {
  test("starts once and reuses the running shared engine", async () => {
    const h = harness();

    const first = await h.manager.ensureStarted("workspace-a prompt");
    const second = await h.manager.ensureStarted("workspace-b prompt");

    expect(second).toBe(first);
    expect(first.workspaceId).toBe("shared-unsandboxed");
    expect(first.workdir).toBe("/tmp/veslo/shared-opencode-runtime");
    expect(first.configDir).toBe("/tmp/veslo/shared-opencode-config");
    expect(first.state).toBe("ready");
    expect(h.counts().spawns).toBe(1);
  });

  test("coalesces concurrent starts into a single spawn", async () => {
    const h = harness();

    const [a, b, c] = await Promise.all([
      h.manager.ensureStarted("a"),
      h.manager.ensureStarted("b"),
      h.manager.ensureStarted("c"),
    ]);

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(h.counts().spawns).toBe(1);
  });

  test("clears pending start after a failed spawn", async () => {
    const h = harness({ failSpawn: true });

    await expect(h.manager.ensureStarted("first")).rejects.toThrow("spawn failed");
    await expect(h.manager.ensureStarted("second")).rejects.toThrow("spawn failed");

    expect(h.counts().spawns).toBe(2);
  });

  test("stops the child and clears state on dispose", async () => {
    const h = harness();
    const engine = await h.manager.ensureStarted("prompt");

    await h.manager.dispose();

    expect(h.counts().stops).toBe(1);
    expect(h.counts().stoppedPids).toEqual([engine.pid]);
    expect(h.manager.getRunning()).toBeNull();
    expect(h.manager.snapshot().running).toBe(false);
  });

  test("snapshot reports stable directories before startup", () => {
    const h = harness();

    expect(h.manager.snapshot()).toEqual({
      mode: "shared-unsandboxed",
      running: false,
      pending: false,
      engineState: "absent",
      runtimeDirectory: "/tmp/veslo/shared-opencode-runtime",
      configDirectory: "/tmp/veslo/shared-opencode-config",
    });
  });

  test("snapshot reports starting while shared health check is pending", async () => {
    let releaseHealthy!: () => void;
    const healthy = new Promise<void>((resolve) => {
      releaseHealthy = resolve;
    });
    const h = harness({ waitForHealthy: () => healthy });

    const pending = h.manager.ensureStarted("prompt");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.manager.getRunning()).toBeNull();
    expect(h.manager.snapshot()).toMatchObject({
      mode: "shared-unsandboxed",
      running: false,
      pending: true,
      engineState: "starting",
      state: "spawning",
      pid: 1001,
      port: 61000,
      baseUrl: "http://127.0.0.1:61000",
    });

    releaseHealthy();
    await pending;

    expect(h.manager.snapshot()).toMatchObject({
      running: true,
      pending: false,
      engineState: "ready",
      state: "ready",
    });
  });

  test("detects a dead shared engine and emits a crashed event", async () => {
    const events: Array<{ event: string; pid: number | null }> = [];
    const h = harness({
      onEngineChange: (event, engine) => {
        events.push({ event, pid: engine?.pid ?? null });
      },
    });
    const engine = await h.manager.ensureStarted("prompt");

    h.markDead(engine.pid);

    expect(h.manager.getRunning()).toBeNull();
    expect(events).toContainEqual({ event: "crashed", pid: engine.pid });
    expect(h.manager.snapshot().running).toBe(false);
  });

  test("health probe failures mark the shared engine crashed", async () => {
    const events: Array<{ event: string; pid: number | null }> = [];
    const h = harness({
      failHealthCheck: true,
      onEngineChange: (event, engine) => {
        events.push({ event, pid: engine?.pid ?? null });
      },
    });
    const engine = await h.manager.ensureStarted("prompt");

    await h.manager.checkHealth("test");
    expect(h.manager.getRunning()).toBe(engine);

    await h.manager.checkHealth("test");

    expect(h.manager.getRunning()).toBeNull();
    expect(h.counts().stoppedPids).toEqual([engine.pid]);
    expect(events).toContainEqual({ event: "crashed", pid: engine.pid });
  });

  test("proxy upstream failure can mark the shared engine unhealthy immediately", async () => {
    const h = harness();
    const engine = await h.manager.ensureStarted("prompt");

    await h.manager.markUnhealthy("proxy-upstream-error", new Error("socket closed"));

    expect(h.manager.getRunning()).toBeNull();
    expect(h.counts().stoppedPids).toEqual([engine.pid]);
    expect(h.manager.snapshot()).toMatchObject({
      running: false,
      engineState: "failed",
    });
  });
});
