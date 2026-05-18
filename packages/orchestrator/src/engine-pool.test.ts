import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

import {
  EnginePool,
  type EnginePoolConfig,
  type EnginePoolDeps,
  type ScheduleApi,
  type ScheduleHandle,
} from "./engine-pool.js";

/**
 * Minimal fake timer queue for F2Ú4/F2Ú5 tests. Supports setInterval and
 * (later for F2Ú5) setTimeout. `advance(ms)` fires all callbacks whose
 * scheduled time falls within the elapsed window, re-scheduling intervals.
 */
class FakeTimers {
  now = 1000;
  private nextId = 1;
  private queue: Array<{
    id: number;
    fireAt: number;
    cb: () => void;
    intervalMs?: number;
  }> = [];

  setInterval = (cb: () => void, ms: number): ScheduleHandle => {
    const id = this.nextId++;
    this.queue.push({ id, fireAt: this.now + ms, cb, intervalMs: ms });
    return id;
  };

  clearInterval = (handle: ScheduleHandle): void => {
    this.queue = this.queue.filter((entry) => entry.id !== handle);
  };

  schedule(): ScheduleApi {
    return { setInterval: this.setInterval, clearInterval: this.clearInterval };
  }

  /** Advance virtual time and fire all callbacks scheduled within the window. */
  advance(ms: number): void {
    const targetTime = this.now + ms;
    while (true) {
      const due = this.queue
        .filter((entry) => entry.fireAt <= targetTime)
        .sort((a, b) => a.fireAt - b.fireAt);
      if (due.length === 0) break;
      const next = due[0]!;
      this.now = next.fireAt;
      if (next.intervalMs !== undefined) {
        next.fireAt = this.now + next.intervalMs;
      } else {
        this.queue = this.queue.filter((entry) => entry.id !== next.id);
      }
      try {
        next.cb();
      } catch {
        // swallow — tests assert on side effects
      }
    }
    this.now = targetTime;
  }

  /** Number of pending entries (intervals + timeouts). */
  pending(): number {
    return this.queue.length;
  }
}

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

function harness(
  overrides: Partial<EnginePoolDeps> = {},
  config?: Partial<EnginePoolConfig>,
  timers?: FakeTimers,
): TestHarness {
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

  const deps: EnginePoolDeps = { ...baseDeps, ...overrides };
  if (timers) {
    deps.schedule = timers.schedule();
    deps.now = () => timers.now;
    // Use synthetic immediate sleep so LRU retry doesn't wait real 1s.
    deps.sleep = async (ms: number) => {
      timers.advance(ms);
    };
  }

  const pool = new EnginePool({ deps, config });
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

describe("EnginePool — F2Ú4 LRU + idle suspend", () => {
  test("LRU eviction suspends oldest engine when pool reaches maxEngines", async () => {
    const timers = new FakeTimers();
    const h = harness(
      {},
      { maxEngines: 2, lruActivityGuardMs: 100, idleSuspendMs: 999_999, idleSweepIntervalMs: 999_999 },
      timers,
    );
    try {
      await h.pool.ensure({ id: "a", path: "/tmp/a" });
      timers.advance(50);
      await h.pool.ensure({ id: "b", path: "/tmp/b" });
      // Both engines active (< guard) — let them age past the guard window.
      timers.advance(200);
      // activeSize === 2 (cap reached); ensure c → LRU eviction triggers.
      await h.pool.ensure({ id: "c", path: "/tmp/c" });
      // engine "a" (oldest) is now suspended; "b" still ready; "c" newly ready.
      expect(h.pool.get("a")?.state).toBe("suspended");
      expect(h.pool.get("b")?.state).toBe("ready");
      expect(h.pool.get("c")?.state).toBe("ready");
      expect(h.pool.activeSize()).toBe(2);
    } finally {
      await h.cleanup();
    }
  });

  test("LRU race — all engines recently active throws capacity exceeded", async () => {
    const timers = new FakeTimers();
    const h = harness(
      {},
      { maxEngines: 1, lruActivityGuardMs: 5_000, idleSuspendMs: 999_999, idleSweepIntervalMs: 999_999 },
      timers,
    );
    try {
      await h.pool.ensure({ id: "a", path: "/tmp/a" });
      // a's lastActivityAt is timers.now (1000). Advance only 1000ms < guard.
      timers.advance(1000);
      // ensure b → LRU search picks no candidate (a is "active"). Retry after
      // 1s (synthetic sleep advances clock 1s) still < guard (total 2000ms <
      // 5000ms guard) — throw.
      await expect(h.pool.ensure({ id: "b", path: "/tmp/b" })).rejects.toThrow(
        "engine pool capacity exceeded",
      );
      expect(h.pool.get("a")?.state).toBe("ready");
      expect(h.pool.get("b")).toBeUndefined();
    } finally {
      await h.cleanup();
    }
  });

  test("idle sweep suspends ready engine past threshold", async () => {
    const timers = new FakeTimers();
    const h = harness(
      {},
      { idleSuspendMs: 1_000, idleSweepIntervalMs: 500, lruActivityGuardMs: 50 },
      timers,
    );
    try {
      await h.pool.ensure({ id: "a", path: "/tmp/a" });
      // Engine ready, lastActivityAt = 1000 (timers.now). Advance past threshold.
      timers.advance(1_500); // now = 2500, > 1000 + 1000 threshold; sweep tick at 1500 fires
      // Idle sweep is async (uses void Promise.all internally) — give microtasks a tick.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(h.pool.get("a")?.state).toBe("suspended");
      expect(h.pool.activeSize()).toBe(0);
    } finally {
      await h.cleanup();
    }
  });

  test("idle sweep does not suspend recently active engine", async () => {
    const timers = new FakeTimers();
    const h = harness(
      {},
      { idleSuspendMs: 5_000, idleSweepIntervalMs: 500, lruActivityGuardMs: 50 },
      timers,
    );
    try {
      await h.pool.ensure({ id: "a", path: "/tmp/a" });
      timers.advance(1_500); // 1500 < 5000 idle threshold; sweep tick fires but doesn't suspend
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(h.pool.get("a")?.state).toBe("ready");
    } finally {
      await h.cleanup();
    }
  });
});
