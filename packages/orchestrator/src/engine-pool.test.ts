import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

import { EnginePool, type EnginePoolDeps } from "./engine-pool.js";

function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawnLongLivedChild(): ChildProcess {
  return spawn("node", ["-e", "process.stdin.resume()"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function stopChild(child: ChildProcess, timeoutMs = 1500): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const exited = await Promise.race([
    once(child, "exit").then(() => true),
    new Promise((resolve) => setTimeout(resolve, timeoutMs, false)),
  ]);
  if (exited) return;
  try {
    child.kill("SIGKILL");
  } catch {
    return;
  }
  await Promise.race([
    once(child, "exit").then(() => true),
    new Promise((resolve) => setTimeout(resolve, timeoutMs, false)),
  ]);
}

type Counters = { spawns: number; nextPort: number };

type TestHarness = {
  pool: EnginePool;
  counters: Counters;
  registry: ChildProcess[];
  cleanup: () => Promise<void>;
};

function harness(overrides: Partial<EnginePoolDeps> = {}): TestHarness {
  const counters: Counters = { spawns: 0, nextPort: 51000 };
  const registry: ChildProcess[] = [];

  const baseDeps: EnginePoolDeps = {
    resolveWorkspace: async (workspace) => ({
      workdir: workspace.path ?? `/tmp/${workspace.id}`,
      configDir: `/tmp/cfg/${workspace.id}`,
    }),
    spawnEngine: async ({ port }) => {
      counters.spawns++;
      const child = spawnLongLivedChild();
      registry.push(child);
      return { child, baseUrl: `http://127.0.0.1:${port}` };
    },
    waitForHealthy: async () => {},
    stopChild,
    findFreePort: async () => counters.nextPort++,
    isProcessAlive,
  };

  const pool = new EnginePool({ ...baseDeps, ...overrides });
  return {
    pool,
    counters,
    registry,
    cleanup: async () => {
      await pool.killAll();
      await Promise.all(registry.map((child) => stopChild(child)));
    },
  };
}

describe("EnginePool", () => {
  test("ensure spawns engine on first call", async () => {
    const h = harness();
    try {
      const engine = await h.pool.ensure({ id: "a", path: "/tmp/a" });
      expect(engine.state).toBe("ready");
      expect(engine.workspaceId).toBe("a");
      expect(engine.pid).toBeGreaterThan(0);
      expect(engine.baseUrl).toMatch(/^http:\/\//);
      expect(engine.workdir).toBe("/tmp/a");
      expect(h.counters.spawns).toBe(1);
      expect(h.pool.size()).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  test("ensure reuses existing engine on second call", async () => {
    const h = harness();
    try {
      const first = await h.pool.ensure({ id: "a", path: "/tmp/a" });
      const second = await h.pool.ensure({ id: "a", path: "/tmp/a" });
      expect(second).toBe(first);
      expect(h.counters.spawns).toBe(1);
      expect(h.pool.size()).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  test("concurrent ensure calls share single spawn", async () => {
    const h = harness();
    try {
      const [a, b, c] = await Promise.all([
        h.pool.ensure({ id: "x", path: "/tmp/x" }),
        h.pool.ensure({ id: "x", path: "/tmp/x" }),
        h.pool.ensure({ id: "x", path: "/tmp/x" }),
      ]);
      expect(a).toBe(b);
      expect(b).toBe(c);
      expect(h.counters.spawns).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  test("ensure for different workspaces spawns separately", async () => {
    const h = harness();
    try {
      const a = await h.pool.ensure({ id: "a", path: "/tmp/a" });
      const b = await h.pool.ensure({ id: "b", path: "/tmp/b" });
      expect(a.workspaceId).toBe("a");
      expect(b.workspaceId).toBe("b");
      expect(a.port).not.toBe(b.port);
      expect(h.counters.spawns).toBe(2);
      expect(h.pool.size()).toBe(2);
    } finally {
      await h.cleanup();
    }
  });

  test("get returns engine after ensure, undefined before", async () => {
    const h = harness();
    try {
      expect(h.pool.get("a")).toBeUndefined();
      await h.pool.ensure({ id: "a", path: "/tmp/a" });
      expect(h.pool.get("a")?.workspaceId).toBe("a");
    } finally {
      await h.cleanup();
    }
  });

  test("suspend kills child and marks state suspended", async () => {
    const h = harness();
    try {
      const engine = await h.pool.ensure({ id: "a", path: "/tmp/a" });
      const pid = engine.pid;
      expect(isProcessAlive(pid)).toBe(true);
      await h.pool.suspend("a");
      expect(isProcessAlive(pid)).toBe(false);
      expect(h.pool.get("a")?.state).toBe("suspended");
    } finally {
      await h.cleanup();
    }
  });

  test("ensure after suspend respawns engine with new pid", async () => {
    const h = harness();
    try {
      const first = await h.pool.ensure({ id: "a", path: "/tmp/a" });
      const firstPid = first.pid;
      await h.pool.suspend("a");
      const second = await h.pool.ensure({ id: "a", path: "/tmp/a" });
      expect(second.pid).not.toBe(firstPid);
      expect(second.state).toBe("ready");
      expect(h.counters.spawns).toBe(2);
    } finally {
      await h.cleanup();
    }
  });

  test("killAll stops all engines and clears pool", async () => {
    const h = harness();
    try {
      const a = await h.pool.ensure({ id: "a", path: "/tmp/a" });
      const b = await h.pool.ensure({ id: "b", path: "/tmp/b" });
      expect(h.pool.size()).toBe(2);
      await h.pool.killAll();
      expect(h.pool.size()).toBe(0);
      expect(isProcessAlive(a.pid)).toBe(false);
      expect(isProcessAlive(b.pid)).toBe(false);
    } finally {
      await h.cleanup();
    }
  });

  test("killAll is idempotent", async () => {
    const h = harness();
    try {
      await h.pool.ensure({ id: "a", path: "/tmp/a" });
      await h.pool.killAll();
      await h.pool.killAll();
      expect(h.pool.size()).toBe(0);
    } finally {
      await h.cleanup();
    }
  });

  test("snapshot returns JSON-serializable shape without ChildProcess", async () => {
    const h = harness();
    try {
      await h.pool.ensure({ id: "a", path: "/tmp/a" });
      const snap = h.pool.snapshot();
      expect(snap).toHaveLength(1);
      expect(snap[0]?.workspaceId).toBe("a");
      expect((snap[0] as Record<string, unknown>).child).toBeUndefined();
      expect(() => JSON.stringify(snap)).not.toThrow();
    } finally {
      await h.cleanup();
    }
  });

  test("spawn failure does not leave engine in pool", async () => {
    const h = harness({
      waitForHealthy: async () => {
        throw new Error("health timeout");
      },
    });
    try {
      await expect(
        h.pool.ensure({ id: "a", path: "/tmp/a" }),
      ).rejects.toThrow("health timeout");
      expect(h.pool.get("a")).toBeUndefined();
      expect(h.pool.size()).toBe(0);
    } finally {
      await h.cleanup();
    }
  });

  test("touch updates lastActivityAt using injected clock", async () => {
    let nowValue = 1000;
    const h = harness({ now: () => nowValue });
    try {
      const engine = await h.pool.ensure({ id: "a", path: "/tmp/a" });
      const initial = engine.lastActivityAt;
      nowValue = 5000;
      h.pool.touch("a");
      expect(h.pool.get("a")?.lastActivityAt).toBe(5000);
      expect(h.pool.get("a")?.lastActivityAt).toBeGreaterThan(initial);
    } finally {
      await h.cleanup();
    }
  });

  test("ensure respawns when underlying process died externally", async () => {
    const h = harness();
    try {
      const first = await h.pool.ensure({ id: "a", path: "/tmp/a" });
      await stopChild(first.child);
      const second = await h.pool.ensure({ id: "a", path: "/tmp/a" });
      expect(second.pid).not.toBe(first.pid);
      expect(second.state).toBe("ready");
      expect(h.counters.spawns).toBe(2);
    } finally {
      await h.cleanup();
    }
  });
});
