import type { ChildProcess } from "node:child_process";

import type {
  EngineProcess,
  EngineSpawnContext,
  EngineSpawnResult,
} from "./engine-pool.js";

export type SharedOpenCodeEngineSnapshot = {
  mode: "shared-unsandboxed";
  running: boolean;
  baseUrl?: string;
  pid?: number;
  port?: number;
  childKind?: "direct" | "wsl";
  startedAt?: string;
  runtimeDirectory: string;
  configDirectory: string;
};

export type SharedOpenCodeEngineEvent = "spawned" | "suspended" | "crashed";

export type SharedOpenCodeEngineDeps = {
  prepareRuntime?: () => Promise<void>;
  spawnEngine: (ctx: EngineSpawnContext) => Promise<EngineSpawnResult>;
  waitForHealthy: (baseUrl: string) => Promise<void>;
  stopChild: (child: ChildProcess) => Promise<void>;
  findFreePort: () => Promise<number>;
  isProcessAlive: (pid: number) => boolean;
  now?: () => number;
  log?: (message: string, attributes?: Record<string, unknown>) => void;
  onEngineChange?: (event: SharedOpenCodeEngineEvent, engine: EngineProcess | null) => void;
};

export type SharedOpenCodeEngineInput = {
  runtimeDirectory: string;
  configDirectory: string;
  workspaceId?: string;
  deps: SharedOpenCodeEngineDeps;
};

export class SharedOpenCodeEngine {
  private readonly runtimeDirectory: string;
  private readonly configDirectory: string;
  private readonly workspaceId: string;
  private readonly deps: Required<Pick<SharedOpenCodeEngineDeps, "now">> &
    Omit<SharedOpenCodeEngineDeps, "now">;
  private engine: EngineProcess | null = null;
  private pending: Promise<EngineProcess> | null = null;

  constructor(input: SharedOpenCodeEngineInput) {
    this.runtimeDirectory = input.runtimeDirectory;
    this.configDirectory = input.configDirectory;
    this.workspaceId = input.workspaceId ?? "shared-unsandboxed";
    this.deps = {
      ...input.deps,
      now: input.deps.now ?? (() => Date.now()),
    };
  }

  getRunning(): EngineProcess | null {
    const engine = this.engine;
    if (!engine) return null;
    if (engine.state !== "ready" && engine.state !== "idle") return null;
    if (!this.deps.isProcessAlive(engine.pid)) {
      this.engine = null;
      engine.state = "crashed";
      this.emit("crashed", engine);
      return null;
    }
    engine.lastActivityAt = this.deps.now();
    return engine;
  }

  async ensureStarted(reason: string): Promise<EngineProcess> {
    const running = this.getRunning();
    if (running) return running;

    if (this.pending) {
      this.deps.log?.("shared opencode ensure pending reuse", { reason });
      return this.pending;
    }

    this.pending = this.spawn(reason);
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }

  snapshot(): SharedOpenCodeEngineSnapshot {
    const running = this.getRunning();
    if (!running) {
      return {
        mode: "shared-unsandboxed",
        running: false,
        runtimeDirectory: this.runtimeDirectory,
        configDirectory: this.configDirectory,
      };
    }

    return {
      mode: "shared-unsandboxed",
      running: true,
      baseUrl: running.baseUrl,
      pid: running.pid,
      port: running.port,
      childKind: running.childKind,
      startedAt: new Date(running.spawnedAt).toISOString(),
      runtimeDirectory: this.runtimeDirectory,
      configDirectory: this.configDirectory,
    };
  }

  async dispose(): Promise<void> {
    const pending = this.pending;
    if (pending) {
      try {
        await pending;
      } catch {
        // Failed pending starts already clean up their child if one exists.
      }
    }

    const engine = this.engine;
    this.engine = null;
    if (!engine) return;
    engine.state = "suspended";
    await this.deps.stopChild(engine.child);
    this.emit("suspended", engine);
  }

  private emit(event: SharedOpenCodeEngineEvent, engine: EngineProcess | null): void {
    try {
      this.deps.onEngineChange?.(event, engine);
    } catch (error) {
      this.deps.log?.("shared opencode event listener threw", {
        event,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async spawn(reason: string): Promise<EngineProcess> {
    await this.deps.prepareRuntime?.();
    const port = await this.deps.findFreePort();
    const now = this.deps.now();
    let spawned: EngineSpawnResult | null = null;

    this.deps.log?.("shared opencode spawn start", {
      reason,
      workspaceId: this.workspaceId,
      workdir: this.runtimeDirectory,
      configDir: this.configDirectory,
      port,
    });

    try {
      spawned = await this.deps.spawnEngine({
        workspaceId: this.workspaceId,
        workdir: this.runtimeDirectory,
        configDir: this.configDirectory,
        port,
      });
      const pid = spawned.child.pid ?? 0;
      const engine: EngineProcess = {
        workspaceId: this.workspaceId,
        pid,
        port,
        baseUrl: spawned.baseUrl,
        workdir: this.runtimeDirectory,
        configDir: this.configDirectory,
        childKind: spawned.childKind,
        state: "spawning",
        spawnedAt: now,
        lastActivityAt: now,
        child: spawned.child,
        healthStrikes: 0,
        restartCount: 0,
        lastSuccessfulRunStartedAt: 0,
      };

      await this.deps.waitForHealthy(engine.baseUrl);
      engine.state = "ready";
      engine.lastSuccessfulRunStartedAt = this.deps.now();
      engine.lastActivityAt = engine.lastSuccessfulRunStartedAt;
      this.engine = engine;
      this.deps.log?.("shared opencode spawn ready", {
        workspaceId: this.workspaceId,
        pid,
        port,
        baseUrl: engine.baseUrl,
      });
      this.emit("spawned", engine);
      return engine;
    } catch (error) {
      if (spawned?.child) {
        try {
          await this.deps.stopChild(spawned.child);
        } catch (stopError) {
          this.deps.log?.("shared opencode spawn cleanup failed", {
            error: String(stopError),
          });
        }
      }
      this.engine = null;
      throw error;
    }
  }
}
