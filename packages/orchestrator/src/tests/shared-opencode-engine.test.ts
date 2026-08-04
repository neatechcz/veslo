import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { SharedOpenCodeEngine } from "../shared-opencode-engine.js";
import type { EngineSpawnResult } from "../engine-pool.js";
import type { DirectChildStopResult } from "../direct-child-stop.js";

function fakeChild(pid: number): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperties(child, {
    pid: { value: pid },
    exitCode: { value: null, writable: true },
    signalCode: { value: null, writable: true },
  });
  return child;
}

function harness(options: {
  failSpawn?: boolean;
  failHealth?: boolean;
  failHealthCheck?: boolean;
  waitForHealthy?: () => Promise<void>;
  onEngineChange?: (event: string, engine: { pid: number } | null) => void;
  generationLifecycle?: ConstructorParameters<typeof SharedOpenCodeEngine>[0]["deps"]["generationLifecycle"];
  stopResult?: DirectChildStopResult;
} = {}) {
  let spawns = 0;
  let stops = 0;
  let nextPort = 61000;
  const stoppedPids: number[] = [];
  const alive = new Set<number>();
  const children = new Map<number, ChildProcess>();

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
        children.set(child.pid!, child);
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
        const result = options.stopResult ?? { outcome: "exit_observed" as const };
        if (result.outcome === "exit_observed" && child.pid) {
          stoppedPids.push(child.pid);
          alive.delete(child.pid);
        }
        return result;
      },
      isProcessAlive: (pid) => alive.has(pid),
      now: () => 123456,
      onEngineChange: options.onEngineChange,
      generationLifecycle: options.generationLifecycle,
    },
  });

  return {
    manager,
    counts: () => ({ spawns, stops, stoppedPids }),
    markDead: (pid: number) => {
      alive.delete(pid);
    },
    emitExit: (pid: number) => {
      const child = children.get(pid);
      if (!child) throw new Error(`missing child ${pid}`);
      (child as ChildProcess & { exitCode: number | null }).exitCode = 0;
      child.emit("exit", 0, null);
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

  test("ensureStartedWithStatus distinguishes a new shared process from reuse", async () => {
    const h = harness();

    const first = await h.manager.ensureStartedWithStatus("workspace-a prompt");
    const second = await h.manager.ensureStartedWithStatus("workspace-b prompt");

    expect(first.spawned).toBe(true);
    expect(second.spawned).toBe(false);
    expect(second.engine).toBe(first.engine);
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

  test("persists the same generation through shared spawn and intentional stop", async () => {
    const events: Array<{ kind: string; ownerId: string }> = [];
    const h = harness({
      generationLifecycle: {
        beforeSpawn: (seed) => { events.push({ kind: "creating", ownerId: seed.engineOwnerId }); },
        afterSpawn: (engine) => { events.push({ kind: "live", ownerId: engine.engineOwnerId }); },
        beforeStop: (engine) => { events.push({ kind: "stopping", ownerId: engine.engineOwnerId }); },
        afterExit: (engine) => { events.push({ kind: "exited", ownerId: engine.engineOwnerId }); },
      },
    });

    const engine = await h.manager.ensureStarted("prompt");
    await h.manager.dispose();

    expect(events.map((event) => event.kind)).toEqual(["creating", "live", "stopping", "exited"]);
    expect(new Set(events.map((event) => event.ownerId))).toEqual(new Set([engine.engineOwnerId]));
  });

  test("snapshot exposes the selected skill view identity and revision", () => {
    const h = harness();
    h.manager.setSkillView({
      workspaceId: "workspace-a",
      workspaceRoot: "/tmp/veslo/workspace-a",
      revision: "view-a",
    });

    expect(h.manager.snapshot()).toMatchObject({
      skillWorkspaceId: "workspace-a",
      skillWorkspaceRoot: "/tmp/veslo/workspace-a",
      skillViewRevision: "view-a",
    });
  });

  test("snapshot exposes the process-generation owner for shared directory trace attribution", async () => {
    const h = harness();
    const engine = await h.manager.ensureStarted("directory-scoped trace");

    expect(h.manager.snapshot()).toMatchObject({
      running: true,
      engineOwnerId: engine.engineOwnerId,
      pid: engine.pid,
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

  test("cleans up a dead shared engine before spawning its successor", async () => {
    const events: Array<{ event: string; pid: number | null }> = [];
    const h = harness({
      onEngineChange: (event, engine) => {
        events.push({ event, pid: engine?.pid ?? null });
      },
    });
    const engine = await h.manager.ensureStarted("prompt");

    h.markDead(engine.pid);

    expect(h.manager.getRunning()).toBeNull();
    await h.manager.ensureStarted("replacement");
    expect(events).toContainEqual({ event: "crashed", pid: engine.pid });
    expect(h.counts().spawns).toBe(2);
    expect(h.manager.snapshot().running).toBe(true);
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

  test("an unconfirmed dispose blocks successors until a late direct exit", async () => {
    const exits: string[] = [];
    const h = harness({
      stopResult: { outcome: "exit_unconfirmed" },
      generationLifecycle: {
        afterExit: (engine) => { exits.push(engine.engineOwnerId); },
      },
    });
    const engine = await h.manager.ensureStarted("prompt");

    await expect(h.manager.dispose()).resolves.toMatchObject({ outcome: "exit_unconfirmed" });
    await expect(h.manager.ensureStarted("replacement")).rejects.toThrow(
      "shared_engine_previous_exit_unconfirmed",
    );
    expect(h.counts().spawns).toBe(1);
    expect(exits).toEqual([]);

    h.emitExit(engine.pid);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(exits).toEqual([engine.engineOwnerId]);
    await h.manager.ensureStarted("retry after observed exit");
    expect(h.counts().spawns).toBe(2);
  });

  test("unconfirmed unhealthy cleanup creates zero successor engines", async () => {
    const h = harness({ stopResult: { outcome: "exit_unconfirmed" } });
    await h.manager.ensureStarted("prompt");

    await expect(
      h.manager.markUnhealthy("test", new Error("unhealthy")),
    ).resolves.toMatchObject({ outcome: "exit_unconfirmed" });
    await expect(h.manager.ensureStarted("replacement")).rejects.toThrow(
      "shared_engine_previous_exit_unconfirmed",
    );
    expect(h.counts().spawns).toBe(1);
  });

  test("unconfirmed shared spawn cleanup creates zero successor engines", async () => {
    const h = harness({
      failHealth: true,
      stopResult: { outcome: "exit_unconfirmed" },
    });

    await expect(h.manager.ensureStarted("first")).rejects.toThrow("health failed");
    await expect(h.manager.ensureStarted("second")).rejects.toThrow(
      "shared_engine_previous_exit_unconfirmed",
    );
    expect(h.counts().spawns).toBe(1);
  });

  test("unconfirmed shared generation-activation cleanup creates zero successor engines", async () => {
    const h = harness({
      stopResult: { outcome: "exit_unconfirmed" },
      generationLifecycle: {
        afterSpawn: async () => { throw new Error("activation failed"); },
      },
    });

    await expect(h.manager.ensureStarted("first")).rejects.toThrow("activation failed");
    await expect(h.manager.ensureStarted("second")).rejects.toThrow(
      "shared_engine_previous_exit_unconfirmed",
    );
    expect(h.counts().spawns).toBe(1);
  });
});
