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
};

type ResolvedDeps = Omit<EnginePoolDeps, "now" | "log"> & {
  now: () => number;
  log?: EnginePoolLogger;
};

export class EnginePool {
  private readonly engines = new Map<string, EngineProcess>();
  private readonly pending = new Map<string, Promise<EngineProcess>>();
  private readonly deps: ResolvedDeps;

  constructor(deps: EnginePoolDeps) {
    this.deps = {
      resolveWorkspace: deps.resolveWorkspace,
      spawnEngine: deps.spawnEngine,
      waitForHealthy: deps.waitForHealthy,
      stopChild: deps.stopChild,
      findFreePort: deps.findFreePort,
      isProcessAlive: deps.isProcessAlive,
      now: deps.now ?? (() => Date.now()),
      log: deps.log,
    };
  }

  size(): number {
    return this.engines.size;
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

    const promise = this.spawn(workspace).finally(() => {
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
    this.deps.log?.("engine ready", {
      workspaceId: workspace.id,
      baseUrl,
      pid: engine.pid,
    });
    return engine;
  }
}
