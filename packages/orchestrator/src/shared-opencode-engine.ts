import type { ChildProcess } from "node:child_process";

import type {
  EngineProcess,
  EngineState,
  EngineSpawnContext,
  EngineSpawnResult,
} from "./engine-pool.js";
import type { RuntimeEngineState } from "./runtime-engine-state.js";
import { runtimeEngineStateFromEngineState } from "./runtime-engine-state.js";

export type SharedOpenCodeEngineSnapshot = {
  mode: "shared-unsandboxed";
  running: boolean;
  pending: boolean;
  engineState: RuntimeEngineState;
  state?: EngineState;
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
  healthCheck?: (baseUrl: string) => Promise<void>;
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
  private startingEngine: EngineProcess | null = null;
  private pending: Promise<EngineProcess> | null = null;
  private lastEngineState: RuntimeEngineState = "absent";
  private readonly healthFailureThreshold = 2;

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
      this.lastEngineState = runtimeEngineStateFromEngineState(engine.state);
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
    const pending = this.pending !== null;
    const engine = running ?? this.startingEngine;
    const engineState = running
      ? runtimeEngineStateFromEngineState(running.state)
      : pending
        ? "starting"
        : this.lastEngineState;

    return {
      mode: "shared-unsandboxed",
      running: Boolean(running),
      pending,
      engineState,
      ...(engine ? { state: engine.state } : {}),
      ...(engine ? { baseUrl: engine.baseUrl } : {}),
      ...(engine ? { pid: engine.pid } : {}),
      ...(engine ? { port: engine.port } : {}),
      ...(engine?.childKind ? { childKind: engine.childKind } : {}),
      ...(engine ? { startedAt: new Date(engine.spawnedAt).toISOString() } : {}),
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
    this.startingEngine = null;
    if (!engine) return;
    engine.state = "suspended";
    this.lastEngineState = runtimeEngineStateFromEngineState(engine.state);
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
      this.startingEngine = engine;
      this.lastEngineState = runtimeEngineStateFromEngineState(engine.state);

      await this.deps.waitForHealthy(engine.baseUrl);
      engine.state = "ready";
      engine.lastSuccessfulRunStartedAt = this.deps.now();
      engine.lastActivityAt = engine.lastSuccessfulRunStartedAt;
      this.engine = engine;
      this.startingEngine = null;
      this.lastEngineState = runtimeEngineStateFromEngineState(engine.state);
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
      this.startingEngine = null;
      this.lastEngineState = "failed";
      throw error;
    }
  }

  async checkHealth(reason = "health-check"): Promise<void> {
    const engine = this.getRunning();
    if (!engine || !this.deps.healthCheck) return;
    try {
      await this.deps.healthCheck(engine.baseUrl);
      if (engine.healthStrikes > 0) {
        engine.healthStrikes = 0;
        this.deps.log?.("shared opencode health recovered", {
          reason,
          workspaceId: this.workspaceId,
          pid: engine.pid,
          baseUrl: engine.baseUrl,
        });
      }
    } catch (error) {
      engine.healthStrikes += 1;
      this.deps.log?.("shared opencode health probe failed", {
        reason,
        workspaceId: this.workspaceId,
        pid: engine.pid,
        baseUrl: engine.baseUrl,
        strike: engine.healthStrikes,
        error: error instanceof Error ? error.message : String(error),
      });
      if (engine.healthStrikes >= this.healthFailureThreshold) {
        await this.markUnhealthy(reason, error);
      }
    }
  }

  async markUnhealthy(reason: string, error: unknown): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    this.engine = null;
    this.startingEngine = null;
    engine.state = "crashed";
    this.lastEngineState = runtimeEngineStateFromEngineState(engine.state);
    this.deps.log?.("shared opencode marked unhealthy", {
      reason,
      workspaceId: this.workspaceId,
      pid: engine.pid,
      baseUrl: engine.baseUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      if (this.deps.isProcessAlive(engine.pid)) {
        await this.deps.stopChild(engine.child);
      }
    } catch (stopError) {
      this.deps.log?.("shared opencode unhealthy cleanup failed", {
        reason,
        error: stopError instanceof Error ? stopError.message : String(stopError),
      });
    }
    this.emit("crashed", engine);
  }
}
