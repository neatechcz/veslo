import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

import type {
  EngineGenerationLifecycleHooks,
  EngineProcess,
  EngineState,
  EngineSpawnContext,
  EngineSpawnResult,
} from "./engine-pool.js";
import type { RuntimeEngineState } from "./runtime-engine-state.js";
import { runtimeEngineStateFromEngineState } from "./runtime-engine-state.js";
import type { EngineTopologyMode } from "./engine-topology.js";

export type SharedOpenCodeEngineSnapshot = {
  mode: Extract<EngineTopologyMode, "shared-unsandboxed" | "shared-directory-scoped">;
  running: boolean;
  pending: boolean;
  engineState: RuntimeEngineState;
  state?: EngineState;
  engineOwnerId?: string;
  baseUrl?: string;
  pid?: number;
  port?: number;
  childKind?: "direct" | "wsl";
  startedAt?: string;
  runtimeDirectory: string;
  configDirectory: string;
  skillWorkspaceId?: string;
  skillWorkspaceRoot?: string;
  skillViewRevision?: string;
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
  /** Durable generation hooks mirror the pooled engine contract. */
  generationLifecycle?: EngineGenerationLifecycleHooks;
};

export type SharedOpenCodeEngineInput = {
  runtimeDirectory: string;
  configDirectory: string;
  workspaceId?: string;
  mode?: Extract<EngineTopologyMode, "shared-unsandboxed" | "shared-directory-scoped">;
  deps: SharedOpenCodeEngineDeps;
};

export class SharedOpenCodeEngine {
  private readonly runtimeDirectory: string;
  private readonly configDirectory: string;
  private readonly workspaceId: string;
  private readonly mode: Extract<EngineTopologyMode, "shared-unsandboxed" | "shared-directory-scoped">;
  private readonly deps: Required<Pick<SharedOpenCodeEngineDeps, "now">> &
    Omit<SharedOpenCodeEngineDeps, "now">;
  private engine: EngineProcess | null = null;
  private startingEngine: EngineProcess | null = null;
  private pending: Promise<EngineProcess> | null = null;
  private lastEngineState: RuntimeEngineState = "absent";
  private skillView: { workspaceId: string; workspaceRoot: string; revision?: string } | null = null;
  private readonly healthFailureThreshold = 2;
  /** Bound recent exit dedupe across stop completion and a later child exit event. */
  private readonly generationExitNotifications = new Map<string, Promise<void>>();

  constructor(input: SharedOpenCodeEngineInput) {
    this.runtimeDirectory = input.runtimeDirectory;
    this.configDirectory = input.configDirectory;
    this.workspaceId = input.workspaceId ?? "shared-unsandboxed";
    this.mode = input.mode ?? "shared-unsandboxed";
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
      void this.notifyGenerationAfterExit(engine, "process_not_alive");
      this.emit("crashed", engine);
      return null;
    }
    engine.lastActivityAt = this.deps.now();
    return engine;
  }

  setSkillView(view: { workspaceId: string; workspaceRoot: string; revision?: string }): void {
    this.skillView = view;
  }

  getSkillView(): { workspaceId: string; workspaceRoot: string; revision?: string } | null {
    return this.skillView;
  }

  async ensureStarted(reason: string): Promise<EngineProcess> {
    return (await this.ensureStartedWithStatus(reason)).engine;
  }

  /**
   * Resolves the shared engine and reports whether this caller created it.
   * Joining the existing start promise is intentionally reported as reuse.
   */
  async ensureStartedWithStatus(reason: string): Promise<{ engine: EngineProcess; spawned: boolean }> {
    const running = this.getRunning();
    if (running) return { engine: running, spawned: false };

    if (this.pending) {
      this.deps.log?.("shared opencode ensure pending reuse", { reason });
      return { engine: await this.pending, spawned: false };
    }

    this.pending = this.spawn(reason);
    try {
      return { engine: await this.pending, spawned: true };
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
      mode: this.mode,
      running: Boolean(running),
      pending,
      engineState,
      ...(engine ? { state: engine.state } : {}),
      ...(engine ? { engineOwnerId: engine.engineOwnerId } : {}),
      ...(engine ? { baseUrl: engine.baseUrl } : {}),
      ...(engine ? { pid: engine.pid } : {}),
      ...(engine ? { port: engine.port } : {}),
      ...(engine?.childKind ? { childKind: engine.childKind } : {}),
      ...(engine ? { startedAt: new Date(engine.spawnedAt).toISOString() } : {}),
      runtimeDirectory: this.runtimeDirectory,
      configDirectory: this.configDirectory,
      ...(this.skillView ? {
        skillWorkspaceId: this.skillView.workspaceId,
        skillWorkspaceRoot: this.skillView.workspaceRoot,
        ...(this.skillView.revision ? { skillViewRevision: this.skillView.revision } : {}),
      } : {}),
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
    await this.notifyGenerationBeforeStop(engine, "shared_engine_dispose");
    await this.deps.stopChild(engine.child);
    await this.notifyGenerationAfterExit(engine, "shared_engine_dispose");
    this.emit("suspended", engine);
  }

  private async notifyGenerationBeforeSpawn(input: {
    workspaceId: string;
    engineSlotId: string;
    engineOwnerId: string;
    engineStartedAt: number;
  }): Promise<void> {
    await this.invokeGenerationHook("beforeSpawn", input, undefined, true);
  }

  private async notifyGenerationAfterSpawn(engine: EngineProcess): Promise<void> {
    await this.invokeGenerationHook("afterSpawn", engine, undefined, true);
  }

  private async notifyGenerationBeforeStop(engine: EngineProcess, reason: string): Promise<void> {
    await this.invokeGenerationHook("beforeStop", engine, reason);
  }

  private async notifyGenerationAfterExit(engine: EngineProcess, reason: string): Promise<void> {
    const existing = this.generationExitNotifications.get(engine.engineOwnerId);
    if (existing) {
      await existing;
      return;
    }
    const notification = this.invokeGenerationHook("afterExit", engine, reason);
    this.generationExitNotifications.set(engine.engineOwnerId, notification);
    while (this.generationExitNotifications.size > 256) {
      const oldest = this.generationExitNotifications.keys().next().value;
      if (!oldest || oldest === engine.engineOwnerId) break;
      this.generationExitNotifications.delete(oldest);
    }
    await notification;
  }

  private async invokeGenerationHook(
    hook: keyof EngineGenerationLifecycleHooks,
    first: EngineProcess | {
      workspaceId: string;
      engineSlotId: string;
      engineOwnerId: string;
      engineStartedAt: number;
    },
    reason?: string,
    required = false,
  ): Promise<void> {
    try {
      if (hook === "beforeSpawn") {
        await this.deps.generationLifecycle?.beforeSpawn?.(first as {
          workspaceId: string;
          engineSlotId: string;
          engineOwnerId: string;
          engineStartedAt: number;
        });
      } else if (hook === "afterSpawn") {
        await this.deps.generationLifecycle?.afterSpawn?.(first as EngineProcess);
      } else if (hook === "beforeStop") {
        await this.deps.generationLifecycle?.beforeStop?.(first as EngineProcess, reason ?? "unspecified");
      } else {
        await this.deps.generationLifecycle?.afterExit?.(first as EngineProcess, reason ?? "unspecified");
      }
    } catch (error) {
      this.deps.log?.("shared engine generation lifecycle hook failed", {
        hook,
        workspaceId: first.workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (required) throw error;
    }
  }

  private async handleChildExit(engine: EngineProcess): Promise<void> {
    await this.notifyGenerationAfterExit(engine, "child_exit");
    if (this.engine?.engineOwnerId !== engine.engineOwnerId) return;
    this.engine = null;
    this.startingEngine = null;
    engine.state = "crashed";
    this.lastEngineState = runtimeEngineStateFromEngineState(engine.state);
    this.emit("crashed", engine);
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
    const engineOwnerId = randomUUID();
    let spawned: EngineSpawnResult | null = null;

    await this.notifyGenerationBeforeSpawn({
      workspaceId: this.workspaceId,
      engineSlotId: this.workspaceId,
      engineOwnerId,
      engineStartedAt: now,
    });

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
        engineOwnerId,
        workdir: this.runtimeDirectory,
        configDir: this.configDirectory,
        port,
      });
      const pid = spawned.child.pid ?? 0;
      const engine: EngineProcess = {
        workspaceId: this.workspaceId,
        engineOwnerId,
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
      spawned.child.on("exit", () => { void this.handleChildExit(engine); });

      await this.deps.waitForHealthy(engine.baseUrl);
      engine.state = "ready";
      engine.lastSuccessfulRunStartedAt = this.deps.now();
      engine.lastActivityAt = engine.lastSuccessfulRunStartedAt;
      await this.notifyGenerationAfterSpawn(engine);
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
      await this.notifyGenerationBeforeStop(engine, `shared_engine_unhealthy:${reason}`);
      if (this.deps.isProcessAlive(engine.pid)) {
        await this.deps.stopChild(engine.child);
      }
      await this.notifyGenerationAfterExit(engine, `shared_engine_unhealthy:${reason}`);
    } catch (stopError) {
      this.deps.log?.("shared opencode unhealthy cleanup failed", {
        reason,
        error: stopError instanceof Error ? stopError.message : String(stopError),
      });
    }
    this.emit("crashed", engine);
  }
}
