import type { ChildProcess } from "node:child_process";

export type EngineState =
  | "spawning"
  | "ready"
  | "idle"
  | "suspended"
  | "crashed";

export type EngineWorkspace = {
  id: string;
  path?: string;
};

export type EngineSpawnContext = {
  workspaceId: string;
  workdir: string;
  configDir: string;
  port: number;
};

export type EngineSpawnResult = {
  child: ChildProcess;
  baseUrl: string;
};

export type EngineProcess = {
  workspaceId: string;
  pid: number;
  port: number;
  baseUrl: string;
  workdir: string;
  configDir: string;
  state: EngineState;
  spawnedAt: number;
  lastActivityAt: number;
  child: ChildProcess;
  /** F2Ú5 — health monitor strike counter (consecutive failures). Reset on success. */
  healthStrikes: number;
  /** F2Ú5 — number of crash-driven restarts (reset after stable run). */
  restartCount: number;
  /** F2Ú5 — timestamp of last successful `waitForHealthy`. 0 = engine never reached ready. */
  lastSuccessfulRunStartedAt: number;
};

export type SerializedEngineState = {
  workspaceId: string;
  pid: number;
  port: number;
  baseUrl: string;
  workdir: string;
  configDir: string;
  state: EngineState;
  spawnedAt: number;
  lastActivityAt: number;
};

export type EngineSnapshot = SerializedEngineState & {
  healthy: boolean;
};

export type EnginePoolLogger = (
  message: string,
  attributes?: Record<string, unknown>,
) => void;

export type ScheduleHandle = unknown;

export type ScheduleApi = {
  setInterval: (cb: () => void, ms: number) => ScheduleHandle;
  clearInterval: (handle: ScheduleHandle) => void;
};

export type EnginePoolDeps = {
  resolveWorkspace: (workspace: EngineWorkspace) => Promise<{
    workdir: string;
    configDir: string;
  }>;
  spawnEngine: (ctx: EngineSpawnContext) => Promise<EngineSpawnResult>;
  waitForHealthy: (baseUrl: string) => Promise<void>;
  stopChild: (child: ChildProcess) => Promise<void>;
  findFreePort: () => Promise<number>;
  isProcessAlive: (pid: number) => boolean;
  now?: () => number;
  log?: EnginePoolLogger;
  /** F2Ú4 — injectable timer API for fake-timer tests. Default uses global setInterval. */
  schedule?: ScheduleApi;
  /** F2Ú4 — sleep used by LRU eviction retry. Default `setTimeout(resolve, ms)`. */
  sleep?: (ms: number) => Promise<void>;
};

export type EnginePoolConfig = {
  /** F2Ú4 — max concurrent engines (ready + spawning). LRU eviction triggers when exceeded. */
  maxEngines: number;
  /** F2Ú4 — engine idle threshold; sweeper suspends ready engines older than this. */
  idleSuspendMs: number;
  /** F2Ú4 — how often the idle sweeper runs. */
  idleSweepIntervalMs: number;
  /** F2Ú4 — engines with lastActivityAt within this window are considered active and skipped by LRU. */
  lruActivityGuardMs: number;
};

export const DEFAULT_ENGINE_POOL_CONFIG: EnginePoolConfig = {
  maxEngines: 8,
  idleSuspendMs: 15 * 60_000,
  idleSweepIntervalMs: 60_000,
  lruActivityGuardMs: 5_000,
};

type ResolvedDeps = Omit<EnginePoolDeps, "now" | "log" | "schedule" | "sleep"> & {
  now: () => number;
  log?: EnginePoolLogger;
  schedule: ScheduleApi;
  sleep: (ms: number) => Promise<void>;
};

export type EnginePoolInput = {
  deps: EnginePoolDeps;
  config?: Partial<EnginePoolConfig>;
};

export class EnginePool {
  private readonly engines = new Map<string, EngineProcess>();
  private readonly pending = new Map<string, Promise<EngineProcess>>();
  private readonly deps: ResolvedDeps;
  private readonly config: EnginePoolConfig;
  private idleSweepHandle: ScheduleHandle | null = null;

  constructor(input: EnginePoolInput) {
    const deps = input.deps;
    this.deps = {
      resolveWorkspace: deps.resolveWorkspace,
      spawnEngine: deps.spawnEngine,
      waitForHealthy: deps.waitForHealthy,
      stopChild: deps.stopChild,
      findFreePort: deps.findFreePort,
      isProcessAlive: deps.isProcessAlive,
      now: deps.now ?? (() => Date.now()),
      log: deps.log,
      schedule: deps.schedule ?? {
        setInterval: (cb, ms) => setInterval(cb, ms),
        clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
      },
      sleep:
        deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
    };
    this.config = { ...DEFAULT_ENGINE_POOL_CONFIG, ...input.config };
    this.startBackgroundLoops();
  }

  private startBackgroundLoops(): void {
    this.idleSweepHandle = this.deps.schedule.setInterval(
      () => this.runIdleSweep(),
      this.config.idleSweepIntervalMs,
    );
  }

  size(): number {
    return this.engines.size;
  }

  /** F2Ú4 — engines that count against `maxEngines`: ready/spawning/idle. Suspended don't count. */
  activeSize(): number {
    let n = 0;
    for (const engine of this.engines.values()) {
      if (engine.state === "ready" || engine.state === "spawning" || engine.state === "idle") {
        n++;
      }
    }
    return n;
  }

  get(workspaceId: string): EngineProcess | undefined {
    return this.engines.get(workspaceId);
  }

  snapshot(): SerializedEngineState[] {
    return Array.from(this.engines.values()).map((engine) => ({
      workspaceId: engine.workspaceId,
      pid: engine.pid,
      port: engine.port,
      baseUrl: engine.baseUrl,
      workdir: engine.workdir,
      configDir: engine.configDir,
      state: engine.state,
      spawnedAt: engine.spawnedAt,
      lastActivityAt: engine.lastActivityAt,
    }));
  }

  touch(workspaceId: string): void {
    const engine = this.engines.get(workspaceId);
    if (engine) engine.lastActivityAt = this.deps.now();
  }

  async ensure(workspace: EngineWorkspace): Promise<EngineProcess> {
    const existing = this.engines.get(workspace.id);
    if (existing) {
      const alive =
        (existing.state === "ready" || existing.state === "idle") &&
        this.deps.isProcessAlive(existing.pid);
      if (alive) {
        existing.lastActivityAt = this.deps.now();
        return existing;
      }
      this.engines.delete(workspace.id);
      if (existing.child && this.deps.isProcessAlive(existing.pid)) {
        try {
          await this.deps.stopChild(existing.child);
        } catch (err) {
          this.deps.log?.("engine cleanup on respawn failed", {
            workspaceId: workspace.id,
            error: String(err),
          });
        }
      }
    }

    const inflight = this.pending.get(workspace.id);
    if (inflight) return inflight;

    // F2Ú4 — capacity check + spawn must be wrapped in a single inflight
    // promise. `pending.set` runs synchronously before any `await` so
    // concurrent `ensure(sameWorkspace)` calls share one spawn (preserves
    // F2Ú1 race semantics).
    const promise = (async () => {
      await this.evictLruIfNeeded(workspace.id);
      return await this.spawn(workspace);
    })().finally(() => {
      this.pending.delete(workspace.id);
    });
    this.pending.set(workspace.id, promise);
    return promise;
  }

  async suspend(workspaceId: string): Promise<void> {
    const engine = this.engines.get(workspaceId);
    if (!engine) return;
    if (this.deps.isProcessAlive(engine.pid)) {
      try {
        await this.deps.stopChild(engine.child);
      } catch (err) {
        this.deps.log?.("engine suspend failed", {
          workspaceId,
          error: String(err),
        });
      }
    }
    engine.state = "suspended";
  }

  async killAll(): Promise<void> {
    if (this.idleSweepHandle !== null) {
      this.deps.schedule.clearInterval(this.idleSweepHandle);
      this.idleSweepHandle = null;
    }
    const entries = Array.from(this.engines.values());
    this.engines.clear();
    await Promise.all(
      entries.map(async (engine) => {
        if (!this.deps.isProcessAlive(engine.pid)) return;
        try {
          await this.deps.stopChild(engine.child);
        } catch (err) {
          this.deps.log?.("engine killAll failed", {
            workspaceId: engine.workspaceId,
            error: String(err),
          });
        }
      }),
    );
  }

  /**
   * F2Ú4 — runs every `idleSweepIntervalMs`. Suspends `ready` engines whose
   * `lastActivityAt` is older than `idleSuspendMs`. Suspended engines stay in
   * the Map as placeholders (preserving lastActivityAt history); the next
   * `ensure` call respawns them lazily.
   */
  private runIdleSweep(): void {
    const now = this.deps.now();
    const idsToSuspend: string[] = [];
    for (const engine of this.engines.values()) {
      if (engine.state !== "ready") continue;
      if (now - engine.lastActivityAt <= this.config.idleSuspendMs) continue;
      idsToSuspend.push(engine.workspaceId);
    }
    if (idsToSuspend.length === 0) return;
    void Promise.all(
      idsToSuspend.map(async (id) => {
        this.deps.log?.("engine idle, suspending", { workspaceId: id });
        try {
          await this.suspend(id);
        } catch (err) {
          this.deps.log?.("engine idle suspend failed", {
            workspaceId: id,
            error: String(err),
          });
        }
      }),
    );
  }

  /**
   * F2Ú4 — if `activeSize() >= maxEngines`, suspend the LRU candidate (engine
   * with the oldest `lastActivityAt` that isn't currently active). An engine
   * is "active" if `now - lastActivityAt < lruActivityGuardMs` — protects
   * in-flight requests from being killed. If no candidate is found, retry
   * once after 1s; if still full, throws `Error("engine pool capacity exceeded")`.
   */
  private async evictLruIfNeeded(excludeWorkspaceId: string): Promise<void> {
    if (this.activeSize() < this.config.maxEngines) return;

    const pickLru = (): EngineProcess | undefined => {
      const now = this.deps.now();
      let best: EngineProcess | undefined;
      for (const engine of this.engines.values()) {
        if (engine.workspaceId === excludeWorkspaceId) continue;
        if (engine.state !== "ready" && engine.state !== "idle") continue;
        if (now - engine.lastActivityAt < this.config.lruActivityGuardMs) continue;
        if (!best || engine.lastActivityAt < best.lastActivityAt) best = engine;
      }
      return best;
    };

    let candidate = pickLru();
    if (!candidate) {
      this.deps.log?.("engine pool full, all engines active — waiting 1s", {
        activeSize: this.activeSize(),
        maxEngines: this.config.maxEngines,
      });
      await this.deps.sleep(1000);
      candidate = pickLru();
    }
    if (!candidate) {
      throw new Error("engine pool capacity exceeded");
    }
    this.deps.log?.("engine pool evicting LRU", {
      evictedWorkspaceId: candidate.workspaceId,
      activeSize: this.activeSize(),
      maxEngines: this.config.maxEngines,
    });
    await this.suspend(candidate.workspaceId);
  }

  private async spawn(workspace: EngineWorkspace): Promise<EngineProcess> {
    const { workdir, configDir } = await this.deps.resolveWorkspace(workspace);
    const port = await this.deps.findFreePort();
    const spawnedAt = this.deps.now();

    this.deps.log?.("engine spawning", {
      workspaceId: workspace.id,
      workdir,
      port,
    });
    const { child, baseUrl } = await this.deps.spawnEngine({
      workspaceId: workspace.id,
      workdir,
      configDir,
      port,
    });

    const engine: EngineProcess = {
      workspaceId: workspace.id,
      pid: child.pid ?? 0,
      port,
      baseUrl,
      workdir,
      configDir,
      state: "spawning",
      spawnedAt,
      lastActivityAt: spawnedAt,
      child,
      healthStrikes: 0,
      restartCount: 0,
      lastSuccessfulRunStartedAt: 0,
    };
    this.engines.set(workspace.id, engine);

    try {
      await this.deps.waitForHealthy(baseUrl);
    } catch (err) {
      engine.state = "crashed";
      this.engines.delete(workspace.id);
      try {
        await this.deps.stopChild(child);
      } catch (cleanupErr) {
        this.deps.log?.("engine cleanup after health failure failed", {
          workspaceId: workspace.id,
          error: String(cleanupErr),
        });
      }
      throw err;
    }

    engine.state = "ready";
    engine.lastActivityAt = this.deps.now();
    engine.lastSuccessfulRunStartedAt = engine.lastActivityAt;
    this.deps.log?.("engine ready", {
      workspaceId: workspace.id,
      baseUrl,
      pid: engine.pid,
    });
    return engine;
  }
}
