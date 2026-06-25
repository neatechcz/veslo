import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

import {
  EnginePool,
  type EnginePoolConfig,
  type EnginePoolDeps,
  type ScheduleApi,
  type ScheduleHandle,
} from "../engine-pool.js";

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

  setTimeout = (cb: () => void, ms: number): ScheduleHandle => {
    const id = this.nextId++;
    this.queue.push({ id, fireAt: this.now + ms, cb });
    return id;
  };

  clearTimeout = (handle: ScheduleHandle): void => {
    this.queue = this.queue.filter((entry) => entry.id !== handle);
  };

  schedule(): ScheduleApi {
    return {
      setInterval: this.setInterval,
      clearInterval: this.clearInterval,
      setTimeout: this.setTimeout,
      clearTimeout: this.clearTimeout,
    };
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
      expect(snap[0]?.childKind).toBe("direct");
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

  test("idle sweep skips engine whose workspace has an active run", async () => {
    const timers = new FakeTimers();
    const activeWork = new Set(["a"]);
    const h = harness(
      { hasActiveWork: (workspaceId) => activeWork.has(workspaceId) },
      { idleSuspendMs: 1_000, idleSweepIntervalMs: 500, lruActivityGuardMs: 50 },
      timers,
    );
    try {
      await h.pool.ensure({ id: "a", path: "/tmp/a" });
      // Way past the idle threshold — but the workspace is mid-run, so the
      // sweep must leave the engine alone.
      timers.advance(5_000);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(h.pool.get("a")?.state).toBe("ready");

      // Run finished — the next sweep tick suspends as usual.
      activeWork.clear();
      timers.advance(1_000);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(h.pool.get("a")?.state).toBe("suspended");
    } finally {
      await h.cleanup();
    }
  });

  test("LRU eviction skips engine with an active run and picks the next candidate", async () => {
    const timers = new FakeTimers();
    const activeWork = new Set(["a"]);
    const h = harness(
      { hasActiveWork: (workspaceId) => activeWork.has(workspaceId) },
      { maxEngines: 2, lruActivityGuardMs: 100, idleSuspendMs: 999_999, idleSweepIntervalMs: 999_999 },
      timers,
    );
    try {
      await h.pool.ensure({ id: "a", path: "/tmp/a" });
      timers.advance(50);
      await h.pool.ensure({ id: "b", path: "/tmp/b" });
      timers.advance(200);
      // "a" is the LRU candidate but has an active run — "b" gets evicted.
      await h.pool.ensure({ id: "c", path: "/tmp/c" });
      expect(h.pool.get("a")?.state).toBe("ready");
      expect(h.pool.get("b")?.state).toBe("suspended");
      expect(h.pool.get("c")?.state).toBe("ready");
    } finally {
      await h.cleanup();
    }
  });

  test("LRU eviction throws capacity exceeded instead of killing a busy engine", async () => {
    const timers = new FakeTimers();
    const h = harness(
      { hasActiveWork: () => true },
      { maxEngines: 1, lruActivityGuardMs: 100, idleSuspendMs: 999_999, idleSweepIntervalMs: 999_999 },
      timers,
    );
    try {
      await h.pool.ensure({ id: "a", path: "/tmp/a" });
      timers.advance(500); // past the activity guard — only the active run protects "a"
      await expect(h.pool.ensure({ id: "b", path: "/tmp/b" })).rejects.toThrow(
        "engine pool capacity exceeded",
      );
      expect(h.pool.get("a")?.state).toBe("ready");
    } finally {
      await h.cleanup();
    }
  });
});

describe("EnginePool — F2Ú5 crash recovery + health monitor", () => {
  /** Helper: wait for microtasks (event loop tick) so child.on('exit') handlers fire. */
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

  test("health monitor — single failure does not trigger crash", async () => {
    const timers = new FakeTimers();
    let failOnce = true;
    const h = harness(
      {
        healthCheck: async () => {
          if (failOnce) {
            failOnce = false;
            throw new Error("blip");
          }
        },
      },
      { healthIntervalMs: 100, healthFailureThreshold: 3, idleSweepIntervalMs: 999_999 },
      timers,
    );
    try {
      await h.pool.ensure({ id: "a", path: "/tmp/a" });
      timers.advance(100);
      await tick();
      expect(h.pool.get("a")?.state).toBe("ready");
      expect(h.pool.get("a")?.healthStrikes).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  test("health monitor — 3 strikes triggers crash + scheduled restart", async () => {
    const timers = new FakeTimers();
    const h = harness(
      {
        healthCheck: async () => {
          throw new Error("always fail");
        },
      },
      {
        healthIntervalMs: 100,
        healthFailureThreshold: 3,
        restartBackoffBaseMs: 50,
        idleSweepIntervalMs: 999_999,
      },
      timers,
    );
    try {
      const first = await h.pool.ensure({ id: "a", path: "/tmp/a" });
      const firstPid = first.pid;
      // 3 health ticks → 3 strikes → trigger crash.
      timers.advance(100);
      await tick();
      timers.advance(100);
      await tick();
      timers.advance(100);
      await tick();
      // After kill, exit handler fires → restart scheduled.
      // Real child.kill triggers async exit → wait for it.
      await tick();
      await tick();
      // Restart timer fires after backoff (50ms).
      timers.advance(50);
      // Respawn is async (calls spawn) — wait.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const after = h.pool.get("a");
      expect(after?.state).toBe("ready");
      expect(after?.pid).not.toBe(firstPid);
    } finally {
      await h.cleanup();
    }
  });

  test("health monitor — WSL wrapper exit is kept, but failed health still restarts", async () => {
    const timers = new FakeTimers();
    const h = harness(
      {
        spawnEngine: async ({ port }) => {
          h.counters.spawns++;
          const child = spawnLongLivedChild();
          h.registry.push(child);
          return {
            child,
            baseUrl: `http://127.0.0.1:${port}`,
            childKind: "wsl",
          };
        },
        healthCheck: async () => {
          throw new Error("engine endpoint gone");
        },
      },
      {
        healthIntervalMs: 100,
        healthFailureThreshold: 3,
        restartBackoffBaseMs: 50,
        idleSweepIntervalMs: 999_999,
      },
      timers,
    );
    try {
      const first = await h.pool.ensure({ id: "a", path: "/tmp/a" });
      const firstPid = first.pid;

      await stopChild(first.child);
      await tick();
      expect(h.pool.get("a")?.state).toBe("ready");

      timers.advance(100);
      await tick();
      timers.advance(100);
      await tick();
      timers.advance(100);
      await tick();
      timers.advance(50);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const after = h.pool.get("a");
      expect(after?.state).toBe("ready");
      expect(after?.pid).not.toBe(firstPid);
      expect(h.counters.spawns).toBe(2);
    } finally {
      await h.cleanup();
    }
  });

  test("health monitor — strike count resets after success", async () => {
    const timers = new FakeTimers();
    const sequence = [false, false, true, false, false]; // F, F, OK, F, F
    let idx = 0;
    const h = harness(
      {
        healthCheck: async () => {
          const ok = sequence[idx++] ?? true;
          if (!ok) throw new Error("fail");
        },
      },
      { healthIntervalMs: 100, healthFailureThreshold: 3, idleSweepIntervalMs: 999_999 },
      timers,
    );
    try {
      await h.pool.ensure({ id: "a", path: "/tmp/a" });
      for (let i = 0; i < 5; i++) {
        timers.advance(100);
        await tick();
      }
      // 2 fails, 1 success (reset to 0), 2 fails → strikes=2, not crashed.
      expect(h.pool.get("a")?.state).toBe("ready");
      expect(h.pool.get("a")?.healthStrikes).toBe(2);
    } finally {
      await h.cleanup();
    }
  });

  test("crash recovery — child exit triggers restart", async () => {
    const timers = new FakeTimers();
    const h = harness(
      {},
      {
        restartBackoffBaseMs: 50,
        idleSweepIntervalMs: 999_999,
        healthIntervalMs: 999_999,
      },
      timers,
    );
    try {
      const first = await h.pool.ensure({ id: "a", path: "/tmp/a" });
      const firstPid = first.pid;
      // Kill child externally — simulates crash.
      await stopChild(first.child);
      await tick();
      await tick();
      // Restart scheduled after backoff.
      timers.advance(50);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const after = h.pool.get("a");
      expect(after?.state).toBe("ready");
      expect(after?.pid).not.toBe(firstPid);
      expect(h.counters.spawns).toBe(2);
    } finally {
      await h.cleanup();
    }
  });

  test("intentional suspend does NOT trigger restart", async () => {
    const timers = new FakeTimers();
    const h = harness(
      {},
      {
        restartBackoffBaseMs: 50,
        idleSweepIntervalMs: 999_999,
        healthIntervalMs: 999_999,
      },
      timers,
    );
    try {
      await h.pool.ensure({ id: "a", path: "/tmp/a" });
      await h.pool.suspend("a");
      // Child exit fires asynchronously after suspend's stopChild. Wait.
      await tick();
      await tick();
      // Advance well past any backoff.
      timers.advance(10_000);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(h.counters.spawns).toBe(1); // no respawn
      expect(h.pool.get("a")?.state).toBe("suspended");
    } finally {
      await h.cleanup();
    }
  });

  test("exponential backoff sequence: 1000, 2000, 4000ms", async () => {
    const timers = new FakeTimers();
    const events: Array<{ event: string; at: number }> = [];
    const h = harness(
      {
        onEngineChange: (id, event) => {
          if (id === "a" && event === "restart-scheduled") {
            events.push({ event, at: timers.now });
          }
        },
      },
      {
        restartBackoffBaseMs: 1000,
        restartBackoffMaxMs: 30_000,
        maxRestarts: 5,
        idleSweepIntervalMs: 999_999,
        healthIntervalMs: 999_999,
        restartCountResetMs: 999_999_999, // disable reset for sequence test
      },
      timers,
    );
    try {
      const first = await h.pool.ensure({ id: "a", path: "/tmp/a" });
      // Crash 1
      await stopChild(first.child);
      await tick();
      await tick();
      const scheduledAt1 = events[0]?.at;
      // Wait for backoff + respawn
      timers.advance(1000);
      await new Promise((r) => setTimeout(r, 100));
      // Crash 2
      const second = h.pool.get("a")!;
      await stopChild(second.child);
      await tick();
      await tick();
      const scheduledAt2 = events[1]?.at;
      timers.advance(2000);
      await new Promise((r) => setTimeout(r, 100));
      // Crash 3
      const third = h.pool.get("a")!;
      await stopChild(third.child);
      await tick();
      await tick();
      const scheduledAt3 = events[2]?.at;
      // Expect backoff increments: 1s, 2s, 4s between scheduled events
      expect(scheduledAt2! - scheduledAt1!).toBeGreaterThanOrEqual(1000);
      expect(scheduledAt3! - scheduledAt2!).toBeGreaterThanOrEqual(2000);
    } finally {
      await h.cleanup();
    }
  });

  test("max restarts reached then permanently failed", async () => {
    const timers = new FakeTimers();
    const events: string[] = [];
    const h = harness(
      {
        onEngineChange: (id, event) => {
          if (id === "a") events.push(event);
        },
      },
      {
        maxRestarts: 2,
        restartBackoffBaseMs: 50,
        idleSweepIntervalMs: 999_999,
        healthIntervalMs: 999_999,
        restartCountResetMs: 999_999_999,
      },
      timers,
    );
    try {
      const first = await h.pool.ensure({ id: "a", path: "/tmp/a" });
      // Crash 1
      await stopChild(first.child);
      await tick();
      await tick();
      timers.advance(50);
      await new Promise((r) => setTimeout(r, 100));
      // Crash 2
      const second = h.pool.get("a")!;
      await stopChild(second.child);
      await tick();
      await tick();
      timers.advance(100);
      await new Promise((r) => setTimeout(r, 100));
      // Crash 3 → exceeds maxRestarts → permanently-failed.
      const third = h.pool.get("a")!;
      await stopChild(third.child);
      await tick();
      await tick();
      // Permanently failed: no further restart attempt.
      expect(events).toContain("permanently-failed");
      timers.advance(10_000);
      await new Promise((r) => setTimeout(r, 50));
      // No more spawns after permanent failure (we had 3 spawns: initial + 2 restarts).
      expect(h.counters.spawns).toBe(3);
    } finally {
      await h.cleanup();
    }
  });

  test("restartCount resets after stable run beyond restartCountResetMs", async () => {
    const timers = new FakeTimers();
    const h = harness(
      {},
      {
        maxRestarts: 1,
        restartBackoffBaseMs: 50,
        restartCountResetMs: 500,
        idleSweepIntervalMs: 999_999,
        healthIntervalMs: 999_999,
      },
      timers,
    );
    try {
      const first = await h.pool.ensure({ id: "a", path: "/tmp/a" });
      // Crash 1
      await stopChild(first.child);
      await tick();
      await tick();
      timers.advance(50);
      await new Promise((r) => setTimeout(r, 100));
      const second = h.pool.get("a");
      expect(second?.state).toBe("ready");
      expect(second?.restartCount).toBe(1);
      // Advance past resetMs so engine is "stable" — next crash will reset counter.
      timers.advance(1000);
      // Crash 2 — should reset to 1 (not 2), so within maxRestarts=1.
      await stopChild(second!.child);
      await tick();
      await tick();
      timers.advance(50);
      await new Promise((r) => setTimeout(r, 100));
      const third = h.pool.get("a");
      expect(third?.state).toBe("ready");
      expect(third?.restartCount).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  test("spawn fail (waitForHealthy throw) does NOT count toward restartCount", async () => {
    const timers = new FakeTimers();
    let healthShouldFail = true;
    const h = harness(
      {
        waitForHealthy: async () => {
          if (healthShouldFail) throw new Error("initial health fail");
        },
      },
      {
        maxRestarts: 1,
        restartBackoffBaseMs: 50,
        idleSweepIntervalMs: 999_999,
        healthIntervalMs: 999_999,
      },
      timers,
    );
    try {
      // First ensure throws (waitForHealthy fail). No engine registered.
      await expect(h.pool.ensure({ id: "a", path: "/tmp/a" })).rejects.toThrow(
        "initial health fail",
      );
      expect(h.pool.get("a")).toBeUndefined();
      // Second ensure also throws. Counter is not bumped.
      await expect(h.pool.ensure({ id: "a", path: "/tmp/a" })).rejects.toThrow();
      // Now allow health pass — spawn succeeds.
      healthShouldFail = false;
      const engine = await h.pool.ensure({ id: "a", path: "/tmp/a" });
      expect(engine.state).toBe("ready");
      expect(engine.restartCount).toBe(0);
    } finally {
      await h.cleanup();
    }
  });

  test("onEngineChange callback fires for state transitions", async () => {
    const timers = new FakeTimers();
    const events: string[] = [];
    const h = harness(
      {
        onEngineChange: (id, event) => {
          if (id === "a") events.push(event);
        },
      },
      {
        restartBackoffBaseMs: 50,
        idleSweepIntervalMs: 999_999,
        healthIntervalMs: 999_999,
      },
      timers,
    );
    try {
      await h.pool.ensure({ id: "a", path: "/tmp/a" });
      expect(events).toContain("spawned");
      await h.pool.suspend("a");
      expect(events).toContain("suspended");
    } finally {
      await h.cleanup();
    }
  });

  test("killAll cancels pending restart timer", async () => {
    const timers = new FakeTimers();
    const h = harness(
      {},
      {
        restartBackoffBaseMs: 5_000, // long backoff so restart not yet fired
        idleSweepIntervalMs: 999_999,
        healthIntervalMs: 999_999,
      },
      timers,
    );
    try {
      const first = await h.pool.ensure({ id: "a", path: "/tmp/a" });
      // Crash → restart scheduled.
      await stopChild(first.child);
      await tick();
      await tick();
      // killAll before restart timer fires.
      await h.pool.killAll();
      // Advance past backoff — should NOT spawn (timer was cleared).
      timers.advance(10_000);
      await new Promise((r) => setTimeout(r, 100));
      expect(h.counters.spawns).toBe(1); // no respawn after killAll
    } finally {
      await h.cleanup();
    }
  });

  // Send-timeout fix 2026-06-10 — background reads (GET /mcp, /permission, …)
  // must never cold-spawn an engine through the proxy. getRunning is the
  // no-spawn lookup the proxy handler uses for GET/HEAD requests.
  test("getRunning returns null when no engine exists and never spawns", async () => {
    const h = harness();
    try {
      expect(h.pool.getRunning("a")).toBeNull();
      expect(h.counters.spawns).toBe(0);
      expect(h.pool.size()).toBe(0);
    } finally {
      await h.cleanup();
    }
  });

  test("getRunning returns the engine once it is ready", async () => {
    const h = harness();
    try {
      const engine = await h.pool.ensure({ id: "a", path: "/tmp/a" });
      expect(h.pool.getRunning("a")).toBe(engine);
      expect(h.counters.spawns).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  test("getRunning returns null while a spawn is still in flight", async () => {
    let releaseHealth: (() => void) | null = null;
    const h = harness({
      waitForHealthy: () =>
        new Promise<void>((resolve) => {
          releaseHealth = resolve;
        }),
    });
    try {
      const ensurePromise = h.pool.ensure({ id: "a", path: "/tmp/a" });
      // Give spawnEngine a tick to register the spawning engine.
      await new Promise((r) => setTimeout(r, 50));
      expect(h.pool.getRunning("a")).toBeNull();
      releaseHealth!();
      await ensurePromise;
      expect(h.pool.getRunning("a")).not.toBeNull();
    } finally {
      await h.cleanup();
    }
  });

  test("getRunning returns null after suspend", async () => {
    const h = harness();
    try {
      await h.pool.ensure({ id: "a", path: "/tmp/a" });
      await h.pool.suspend("a");
      expect(h.pool.getRunning("a")).toBeNull();
    } finally {
      await h.cleanup();
    }
  });
});
