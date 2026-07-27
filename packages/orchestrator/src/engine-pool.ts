import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

// Workflow diagnostic toggle — see dev-specific-docs/logging-workflow-milestones--claude.md
// Off by default. Opt-in via env var: VESLO_FLOW_LOG=1 (or =true)
const FLOW_LOG_ENABLED =
  process.env.VESLO_FLOW_LOG === "1" ||
  process.env.VESLO_FLOW_LOG?.toLowerCase() === "true";

function opencodeHealthDiagEnabled(): boolean {
  const runtimeDiagnostics = process.env.VESLO_RUNTIME_DIAGNOSTICS?.trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(runtimeDiagnostics ?? "")) return false;
  const healthDiag = process.env.VESLO_OPENCODE_HEALTH_DIAG?.trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(healthDiag ?? "");
}

function writeSpawnDiag(event: string, payload: Record<string, unknown>): void {
  if (!opencodeHealthDiagEnabled()) return;
  const file = process.env.VESLO_OPENCODE_HEALTH_DIAG_FILE?.trim();
  if (!file) return;
  try {
    appendFileSync(
      file,
      `${JSON.stringify({ time: new Date().toISOString(), event, ...payload })}\n`,
      "utf8",
    );
  } catch {
    // Diagnostics must never affect runtime behavior.
  }
}

export type EngineState =
  | "spawning"
  | "ready"
  | "idle"
  | "suspended"
  | "crashed";

export type EngineWorkspace = {
  id: string;
  path?: string;
  legacyWorkspaceIds?: string[];
  /**
   * Effective skill view the caller was promised by the server. Staging must
   * consume exactly this revision, so a spawn cannot silently hand the engine a
   * different skill set than the one the caller already showed the user.
   *
   * Only a caller acting on a fresh server handshake may set it. Pool-internal
   * restarts (crash respawn, idle resume) deliberately leave it undefined:
   * they have no live handshake, and replaying a remembered revision would turn
   * an ordinary recovery into a permanent failure once that revision aged out.
   */
  skillViewRevision?: string;
};

export type EngineEnsureResult = {
  engine: EngineProcess;
  spawned: boolean;
};

export type EngineSpawnContext = {
  workspaceId: string;
  engineOwnerId: string;
  workdir: string;
  configDir: string;
  port: number;
  /** Revision staging must consume exactly; absent for pool-internal restarts. */
  skillViewRevision?: string;
};

export type EngineSpawnResult = {
  child: ChildProcess;
  baseUrl: string;
  childKind?: "direct" | "wsl";
  sandboxed?: boolean;
  configuredSandboxBackend?: string;
  effectiveSandboxBackend?: string;
  sandboxMode?: "resolved" | "explicit-none" | "disabled-by-env" | "unavailable" | "launch-fallback";
  sandboxFallbackReason?: string | null;
};

export type EngineProcess = {
  workspaceId: string;
  /** Opaque identity of this process generation; never a workspace ID. */
  engineOwnerId: string;
  pid: number;
  port: number;
  baseUrl: string;
  workdir: string;
  configDir: string;
  childKind?: "direct" | "wsl";
  sandboxed?: boolean;
  configuredSandboxBackend?: string;
  effectiveSandboxBackend?: string;
  sandboxMode?: "resolved" | "explicit-none" | "disabled-by-env" | "unavailable" | "launch-fallback";
  sandboxFallbackReason?: string | null;
  state: EngineState;
  /**
   * Skill view this process was actually staged from, or undefined when it was
   * started without a handshake (pool-internal restart). Recording it is what
   * lets a later caller notice that reusing this engine would silently serve a
   * skill set the server has since replaced.
   */
  skillViewRevision?: string;
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
  /** Opaque identity of this process generation; never a workspace ID. */
  engineOwnerId: string;
  pid: number;
  port: number;
  baseUrl: string;
  workdir: string;
  configDir: string;
  childKind?: "direct" | "wsl";
  sandboxed?: boolean;
  configuredSandboxBackend?: string;
  effectiveSandboxBackend?: string;
  sandboxMode?: "resolved" | "explicit-none" | "disabled-by-env" | "unavailable" | "launch-fallback";
  sandboxFallbackReason?: string | null;
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
  setTimeout: (cb: () => void, ms: number) => ScheduleHandle;
  clearTimeout: (handle: ScheduleHandle) => void;
};

/**
 * F2Ú5 — events emitted from the pool for callsite observability (logging,
 * persistence, Tauri event bus). Pool itself doesn't subscribe; just calls
 * `deps.onEngineChange`.
 */
export type EngineEvent =
  | "spawned"
  | "suspended"
  | "crashed"
  | "restart-scheduled"
  | "restart-attempt"
  | "permanently-failed"
  | "healthy"
  | "unhealthy";

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
  /**
   * Whether a run currently owns this engine generation. A skill view change
   * may replace an idle engine, but must never pull the process out from under
   * work in progress. Absent = treat every engine as idle.
   */
  hasActiveRuns?: (engineOwnerId: string) => boolean;
  now?: () => number;
  log?: EnginePoolLogger;
  /** F2Ú4 — injectable timer API for fake-timer tests. Default uses global setInterval/setTimeout. */
  schedule?: ScheduleApi;
  /** F2Ú4 — sleep used by LRU eviction retry. Default `setTimeout(resolve, ms)`. */
  sleep?: (ms: number) => Promise<void>;
  /** F2Ú5 — health probe for one engine. Throw = unhealthy. Default no-op (no health checks). */
  healthCheck?: (baseUrl: string) => Promise<void>;
  /** F2Ú5 — observability callback. Pool calls after every state transition. */
  onEngineChange?: (workspaceId: string, event: EngineEvent) => void;
  /**
   * Returns true when the workspace has an active run (submitted/running/
   * blocked in the run registry). Engines with active work are skipped by
   * both LRU eviction and the idle sweep - a generating engine produces no
   * new proxy traffic (the SSE stream is one long request), so
   * `lastActivityAt` alone misclassifies it as idle. Must be cheap and
   * synchronous; errors are treated as "no active work".
   */
  hasActiveWork?: (workspaceId: string) => boolean;
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
  /** F2Ú5 — how often the health monitor runs (one global tick per pool). */
  healthIntervalMs: number;
  /** F2Ú5 — timeout for one health probe; failure includes timeout. */
  healthCheckTimeoutMs: number;
  /** F2Ú5 — consecutive health failures before treating engine as crashed. */
  healthFailureThreshold: number;
  /** F2Ú5 — max restart attempts after a crash before giving up. */
  maxRestarts: number;
  /** F2Ú5 — initial backoff for restart (next attempts: `base * 2 ^ (attempt - 1)`). */
  restartBackoffBaseMs: number;
  /** F2Ú5 — backoff cap; never wait longer than this between restarts. */
  restartBackoffMaxMs: number;
  /** F2Ú5 — if engine ran longer than this without crashing, restart counter resets. */
  restartCountResetMs: number;
};

export const DEFAULT_ENGINE_POOL_CONFIG: EnginePoolConfig = {
  maxEngines: 8,
  idleSuspendMs: 15 * 60_000,
  idleSweepIntervalMs: 60_000,
  lruActivityGuardMs: 5_000,
  healthIntervalMs: 5_000,
  healthCheckTimeoutMs: 2_000,
  healthFailureThreshold: 3,
  maxRestarts: 3,
  restartBackoffBaseMs: 1_000,
  restartBackoffMaxMs: 30_000,
  restartCountResetMs: 5 * 60_000,
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

type ResolvedDepsWithEvents = ResolvedDeps & {
  healthCheck?: (baseUrl: string) => Promise<void>;
  onEngineChange?: (workspaceId: string, event: EngineEvent) => void;
  hasActiveWork?: (workspaceId: string) => boolean;
};

export class EnginePool {
  private readonly engines = new Map<string, EngineProcess>();
  private readonly pending = new Map<string, Promise<EngineProcess>>();
  /** Bounded so a pathological activation storm fails loudly instead of spinning. */
  private static readonly RECONCILE_ATTEMPTS = 4;
  private readonly deps: ResolvedDepsWithEvents;
  private readonly config: EnginePoolConfig;
  private idleSweepHandle: ScheduleHandle | null = null;
  /** F2Ú5 — globální health probe tick handle. */
  private healthMonitorHandle: ScheduleHandle | null = null;
  /**
   * F2Ú5 — workspaceIds that are being killed intentionally (suspend/killAll/respawn).
   * `child.on('exit')` checks this set to distinguish real crashes from intentional kills.
   */
  private readonly intentionallyStopping = new Set<string>();
  /** F2Ú5 — pending restart timeouts by workspaceId (for cleanup on suspend/killAll). */
  private readonly restartTimers = new Map<string, ScheduleHandle>();

  constructor(input: EnginePoolInput) {
    const deps = input.deps;
    this.deps = {
      resolveWorkspace: deps.resolveWorkspace,
      spawnEngine: deps.spawnEngine,
      waitForHealthy: deps.waitForHealthy,
      stopChild: deps.stopChild,
      findFreePort: deps.findFreePort,
      isProcessAlive: deps.isProcessAlive,
      hasActiveRuns: deps.hasActiveRuns,
      now: deps.now ?? (() => Date.now()),
      log: deps.log,
      schedule: deps.schedule ?? {
        setInterval: (cb, ms) => setInterval(cb, ms),
        clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
        setTimeout: (cb, ms) => setTimeout(cb, ms),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      sleep:
        deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
      healthCheck: deps.healthCheck,
      onEngineChange: deps.onEngineChange,
      hasActiveWork: deps.hasActiveWork,
    };
    this.config = { ...DEFAULT_ENGINE_POOL_CONFIG, ...input.config };
    this.startBackgroundLoops();
  }

  private emit(workspaceId: string, event: EngineEvent): void {
    try {
      this.deps.onEngineChange?.(workspaceId, event);
    } catch (err) {
      this.deps.log?.("engine event listener threw", {
        workspaceId,
        event,
        error: String(err),
      });
    }
  }

  private startBackgroundLoops(): void {
    this.idleSweepHandle = this.deps.schedule.setInterval(
      () => this.runIdleSweep(),
      this.config.idleSweepIntervalMs,
    );
    if (this.deps.healthCheck) {
      this.healthMonitorHandle = this.deps.schedule.setInterval(
        () => {
          void this.runHealthChecks();
        },
        this.config.healthIntervalMs,
      );
    }
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

  /**
   * No-spawn lookup: returns the engine only when it is already running
   * (ready/idle + process alive). Used by the proxy for GET/HEAD requests so
   * background status polls (mcp/permission/lsp/…) can fail fast instead of
   * triggering a 30-60s cold spawn via ensure().
   */
  getRunning(workspaceId: string): EngineProcess | null {
    const engine = this.engines.get(workspaceId);
    if (!engine) return null;
    if (engine.state !== "ready" && engine.state !== "idle") return null;
    if (!this.deps.isProcessAlive(engine.pid) && !this.deps.healthCheck) return null;
    return engine;
  }

  snapshot(): SerializedEngineState[] {
    return Array.from(this.engines.values()).map((engine) => ({
      workspaceId: engine.workspaceId,
      engineOwnerId: engine.engineOwnerId,
      pid: engine.pid,
      port: engine.port,
      baseUrl: engine.baseUrl,
      workdir: engine.workdir,
      configDir: engine.configDir,
      childKind: engine.childKind,
      ...(engine.sandboxed !== undefined ? { sandboxed: engine.sandboxed } : {}),
      ...(engine.configuredSandboxBackend !== undefined ? { configuredSandboxBackend: engine.configuredSandboxBackend } : {}),
      ...(engine.effectiveSandboxBackend !== undefined ? { effectiveSandboxBackend: engine.effectiveSandboxBackend } : {}),
      ...(engine.sandboxMode !== undefined ? { sandboxMode: engine.sandboxMode } : {}),
      ...(engine.sandboxFallbackReason !== undefined ? { sandboxFallbackReason: engine.sandboxFallbackReason } : {}),
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
    return (await this.ensureWithStatus(workspace)).engine;
  }

  /**
   * Resolves an engine and reports whether this caller created its process.
   * A caller that joins an in-flight start is a reuse, not a second spawn.
   */
  async ensureWithStatus(workspace: EngineWorkspace): Promise<EngineEnsureResult> {
    // Every path below ends in an await, and a concurrent caller may swap the
    // engine during any of them. Serializing the swap is not enough on its own:
    // the caller must also confirm what it actually received.
    for (let attempt = 0; attempt < EnginePool.RECONCILE_ATTEMPTS; attempt += 1) {
      const outcome = await this.resolveEngine(workspace);
      if (!workspace.skillViewRevision) return outcome;
      if (outcome.engine.skillViewRevision === workspace.skillViewRevision) {
        return outcome;
      }
      this.deps.log?.("engine skill view reconcile retry", {
        workspaceId: workspace.id,
        attempt: attempt + 1,
        engineRevision: outcome.engine.skillViewRevision ?? null,
        requestedRevision: workspace.skillViewRevision,
      });
    }
    throw new Error(
      "skill_view_busy: workspace engine skill view kept changing under concurrent activations",
    );
  }

  private async resolveEngine(workspace: EngineWorkspace): Promise<EngineEnsureResult> {
    const inflight = this.pending.get(workspace.id);
    if (inflight) {
      this.deps.log?.("engine ensure pending reuse", { workspaceId: workspace.id });
      writeSpawnDiag("ensure-pending-reuse", { workspaceId: workspace.id });
      // Joining an in-flight spawn is not proof it is staging *our* view: the
      // flight may have been started without a handshake, or with an older one.
      // Let it finish, then hold its result to the same check as any reuse.
      const joined = await inflight;
      const reconciled = await this.reconcileSkillView(workspace, joined);
      if (reconciled) return { engine: reconciled, spawned: true };
      return { engine: joined, spawned: false };
    }

    const existing = this.engines.get(workspace.id);
    if (existing) {
      const alive =
        (existing.state === "ready" || existing.state === "idle") &&
        (this.deps.isProcessAlive(existing.pid) || !!this.deps.healthCheck);
      if (alive) {
        const reconciled = await this.reconcileSkillView(workspace, existing);
        if (reconciled) return { engine: reconciled, spawned: true };
        existing.lastActivityAt = this.deps.now();
        this.deps.log?.("engine ensure ready reuse", {
          workspaceId: workspace.id,
          state: existing.state,
          pid: existing.pid,
          port: existing.port,
          baseUrl: existing.baseUrl,
          childKind: existing.childKind,
        });
        writeSpawnDiag("ensure-ready-reuse", {
          workspaceId: workspace.id,
          state: existing.state,
          pid: existing.pid,
          port: existing.port,
          baseUrl: existing.baseUrl,
          childKind: existing.childKind,
        });
        return { engine: existing, spawned: false };
      }
      this.deps.log?.("engine ensure stale respawn", {
        workspaceId: workspace.id,
        state: existing.state,
        pid: existing.pid,
        port: existing.port,
        childKind: existing.childKind,
        processAlive: this.deps.isProcessAlive(existing.pid),
        hasHealthCheck: Boolean(this.deps.healthCheck),
      });
      writeSpawnDiag("ensure-stale-respawn", {
        workspaceId: workspace.id,
        state: existing.state,
        pid: existing.pid,
        port: existing.port,
        childKind: existing.childKind,
        processAlive: this.deps.isProcessAlive(existing.pid),
        hasHealthCheck: Boolean(this.deps.healthCheck),
      });
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

    // F2Ú4 — capacity check + spawn must be wrapped in a single inflight
    // promise. `pending.set` runs synchronously before any `await` so
    // concurrent `ensure(sameWorkspace)` calls share one spawn (preserves
    // F2Ú1 race semantics).
    const promise = this.startPending(workspace, true);
    return { engine: await promise, spawned: true };
  }

  /**
   * Hold a reusable engine to the caller's promised skill view.
   *
   * Returns a freshly spawned engine when the running one had to be replaced,
   * or null when the existing engine may be reused as-is. Mirrors what the
   * shared topology already does for its single engine: replace it while idle,
   * refuse while a run owns it. Without this, the revision is enforced only on
   * cold start and any reuse silently serves the previous skill set.
   */
  private async reconcileSkillView(
    workspace: EngineWorkspace,
    engine: EngineProcess,
  ): Promise<EngineProcess | null> {
    const requested = workspace.skillViewRevision;
    // No handshake to enforce. Pool-internal restarts land here, and so does
    // any caller that legitimately has no server-published view yet.
    if (!requested) return null;
    if (engine.skillViewRevision === requested) return null;

    if (this.deps.hasActiveRuns?.(engine.engineOwnerId)) {
      this.deps.log?.("engine skill view busy", {
        workspaceId: workspace.id,
        engineOwnerId: engine.engineOwnerId,
        engineRevision: engine.skillViewRevision ?? null,
        requestedRevision: requested,
      });
      writeSpawnDiag("ensure-skill-view-busy", {
        workspaceId: workspace.id,
        engineRevision: engine.skillViewRevision ?? null,
        requestedRevision: requested,
      });
      throw new Error(
        "skill_view_busy: workspace engine is running a job staged from a different skill view",
      );
    }

    this.deps.log?.("engine skill view restart", {
      workspaceId: workspace.id,
      engineOwnerId: engine.engineOwnerId,
      engineRevision: engine.skillViewRevision ?? null,
      requestedRevision: requested,
    });
    writeSpawnDiag("ensure-skill-view-restart", {
      workspaceId: workspace.id,
      engineRevision: engine.skillViewRevision ?? null,
      requestedRevision: requested,
    });

    // Register the replacement flight before the first await. Tearing the old
    // engine down first would leave a window with no engine and no pending
    // flight, in which a concurrent caller starts a spawn for its own revision
    // and this caller then joins it — handing each of them the other's view.
    return await this.startPending(workspace, true, async () => {
      if (this.engines.get(workspace.id) === engine) {
        this.engines.delete(workspace.id);
      }
      if (engine.child && this.deps.isProcessAlive(engine.pid)) {
        try {
          await this.deps.stopChild(engine.child);
        } catch (err) {
          this.deps.log?.("engine cleanup on skill view restart failed", {
            workspaceId: workspace.id,
            error: String(err),
          });
        }
      }
    });
  }

  /**
   * Register a workspace start before its first await. Foreground activation
   * and crash recovery must share this flight so they cannot stage the same
   * workspace concurrently.
   */
  private startPending(
    workspace: EngineWorkspace,
    evictLru: boolean,
    /** Teardown that must happen inside the flight, never before it exists. */
    before?: () => Promise<void>,
  ): Promise<EngineProcess> {
    const existing = this.pending.get(workspace.id);
    if (existing) return existing;

    const promise = (async () => {
      if (before) await before();
      if (evictLru) await this.evictLruIfNeeded(workspace.id);
      return await this.spawn(workspace);
    })().finally(() => {
      if (this.pending.get(workspace.id) === promise) this.pending.delete(workspace.id);
    });
    this.pending.set(workspace.id, promise);
    return promise;
  }

  async suspend(workspaceId: string, reason = "unspecified"): Promise<void> {
    const engine = this.engines.get(workspaceId);
    if (!engine) return;
    writeSpawnDiag("engine-suspend", {
      workspaceId,
      reason,
      state: engine.state,
      pid: engine.pid,
      port: engine.port,
      baseUrl: engine.baseUrl,
      childKind: engine.childKind,
      processAlive: this.deps.isProcessAlive(engine.pid),
      hasHealthCheck: Boolean(this.deps.healthCheck),
    });
    // F2Ú5 — cancel any pending restart so suspend wins races against backoff.
    const pendingRestart = this.restartTimers.get(workspaceId);
    if (pendingRestart !== undefined) {
      this.deps.schedule.clearTimeout(pendingRestart);
      this.restartTimers.delete(workspaceId);
    }
    // F2Ú5 — mark before stopChild so child.on('exit') handler treats this as intentional.
    this.intentionallyStopping.add(workspaceId);
    try {
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
    } finally {
      this.intentionallyStopping.delete(workspaceId);
    }
    engine.state = "suspended";
    this.emit(workspaceId, "suspended");
  }

  async forget(workspaceId: string): Promise<void> {
    const pendingRestart = this.restartTimers.get(workspaceId);
    if (pendingRestart !== undefined) {
      this.deps.schedule.clearTimeout(pendingRestart);
      this.restartTimers.delete(workspaceId);
    }

    const engine = this.engines.get(workspaceId);
    this.engines.delete(workspaceId);
    if (!engine) return;
    writeSpawnDiag("engine-suspend", {
      workspaceId,
      reason: "forget",
      state: engine.state,
      pid: engine.pid,
      port: engine.port,
      baseUrl: engine.baseUrl,
      childKind: engine.childKind,
      processAlive: this.deps.isProcessAlive(engine.pid),
      hasHealthCheck: Boolean(this.deps.healthCheck),
    });

    this.intentionallyStopping.add(workspaceId);
    try {
      if (this.deps.isProcessAlive(engine.pid)) {
        try {
          await this.deps.stopChild(engine.child);
        } catch (err) {
          this.deps.log?.("engine forget failed", {
            workspaceId,
            error: String(err),
          });
        }
      }
    } finally {
      this.intentionallyStopping.delete(workspaceId);
    }
    this.emit(workspaceId, "suspended");
  }

  async killAll(): Promise<void> {
    if (this.idleSweepHandle !== null) {
      this.deps.schedule.clearInterval(this.idleSweepHandle);
      this.idleSweepHandle = null;
    }
    if (this.healthMonitorHandle !== null) {
      this.deps.schedule.clearInterval(this.healthMonitorHandle);
      this.healthMonitorHandle = null;
    }
    // F2Ú5 — cancel all pending restart timeouts.
    for (const handle of this.restartTimers.values()) {
      this.deps.schedule.clearTimeout(handle);
    }
    this.restartTimers.clear();
    const entries = Array.from(this.engines.values());
    // F2Ú5 — mark every engine as intentionally stopping BEFORE killing.
    for (const engine of entries) this.intentionallyStopping.add(engine.workspaceId);
    this.engines.clear();
    await Promise.all(
      entries.map(async (engine) => {
        try {
          if (!this.deps.isProcessAlive(engine.pid)) return;
          try {
            await this.deps.stopChild(engine.child);
          } catch (err) {
            this.deps.log?.("engine killAll failed", {
              workspaceId: engine.workspaceId,
              error: String(err),
            });
          }
        } finally {
          this.intentionallyStopping.delete(engine.workspaceId);
        }
      }),
    );
  }

  /**
   * F2Ú4 — runs every `idleSweepIntervalMs`. Suspends `ready` engines whose
   * `lastActivityAt` is older than `idleSuspendMs`. Suspended engines stay in
   * the Map as placeholders (preserving lastActivityAt history); the next
   * `ensure` call respawns them lazily.
   *
   * VSLO-86 — `idleSuspendMs <= 0` is treated as "auto-suspend disabled".
   * Without this, the frontend's default of 0 (signalling "no preference",
   * see app.tsx idleSuspendMs signal) immediately suspends every engine the
   * moment it transitions to ready: `now - lastActivityAt` is a small positive
   * delta, and `<= 0` is false, so the engine ends up in the suspend queue.
   * The orchestrator then reports "Unable to connect" on every subsequent
   * request because the engine is killed before the SDK client can talk to it.
   */
  /**
   * True when the run registry reports active work for the workspace. Used to
   * keep the idle sweep and LRU eviction away from engines that are mid-run:
   * a generating engine holds one long SSE request and produces no fresh
   * proxy traffic, so `lastActivityAt` alone cannot tell busy from idle.
   * A throwing or missing `hasActiveWork` dep means "not protected".
   */
  private hasActiveWork(workspaceId: string): boolean {
    if (!this.deps.hasActiveWork) return false;
    try {
      return this.deps.hasActiveWork(workspaceId);
    } catch (err) {
      this.deps.log?.("active-work probe failed", {
        workspaceId,
        error: String(err),
      });
      return false;
    }
  }

  private runIdleSweep(): void {
    if (this.config.idleSuspendMs <= 0) return;
    const now = this.deps.now();
    const idsToSuspend: string[] = [];
    for (const engine of this.engines.values()) {
      if (engine.state !== "ready") continue;
      if (now - engine.lastActivityAt <= this.config.idleSuspendMs) continue;
      if (this.hasActiveWork(engine.workspaceId)) {
        this.deps.log?.("engine idle by lastActivityAt but has active run, skipping suspend", {
          workspaceId: engine.workspaceId,
        });
        continue;
      }
      idsToSuspend.push(engine.workspaceId);
    }
    if (idsToSuspend.length === 0) return;
    void Promise.all(
      idsToSuspend.map(async (id) => {
        this.deps.log?.("engine idle, suspending", { workspaceId: id });
        try {
          await this.suspend(id, "idle-sweep");
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
        if (this.hasActiveWork(engine.workspaceId)) continue;
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
    await this.suspend(candidate.workspaceId, "lru-eviction");
  }

  private async spawn(workspace: EngineWorkspace): Promise<EngineProcess> {
    const { workdir, configDir } = await this.deps.resolveWorkspace(workspace);
    const port = await this.deps.findFreePort();
    const spawnedAt = this.deps.now();
    const engineOwnerId = randomUUID();
    writeSpawnDiag("engine-spawn-start", {
      workspaceId: workspace.id,
      workdir,
      configDir,
      port,
    });

    if (FLOW_LOG_ENABLED) {
      console.log(
        `[veslo:flow] ENGINE spawn-start { wsId: ${JSON.stringify(
          workspace.id,
        )}, workdir: ${JSON.stringify(workdir)}, port: ${port} }`,
      );
    }
    this.deps.log?.("engine spawning", {
      workspaceId: workspace.id,
      workdir,
      port,
    });
    const {
      child,
      baseUrl,
      childKind: spawnedChildKind,
      sandboxed,
      configuredSandboxBackend,
      effectiveSandboxBackend,
      sandboxMode,
      sandboxFallbackReason,
    } = await this.deps.spawnEngine({
      workspaceId: workspace.id,
      engineOwnerId,
      workdir,
      configDir,
      port,
      ...(workspace.skillViewRevision
        ? { skillViewRevision: workspace.skillViewRevision }
        : {}),
    });
    const childKind = spawnedChildKind ?? "direct";

    const existing = this.engines.get(workspace.id);
    const engine: EngineProcess = {
      workspaceId: workspace.id,
      engineOwnerId,
      pid: child.pid ?? 0,
      port,
      baseUrl,
      workdir,
      configDir,
      childKind,
      ...(sandboxed !== undefined ? { sandboxed } : {}),
      ...(configuredSandboxBackend !== undefined ? { configuredSandboxBackend } : {}),
      ...(effectiveSandboxBackend !== undefined ? { effectiveSandboxBackend } : {}),
      ...(sandboxMode !== undefined ? { sandboxMode } : {}),
      ...(sandboxFallbackReason !== undefined ? { sandboxFallbackReason } : {}),
      ...(workspace.skillViewRevision
        ? { skillViewRevision: workspace.skillViewRevision }
        : {}),
      state: "spawning",
      spawnedAt,
      lastActivityAt: spawnedAt,
      child,
      healthStrikes: 0,
      // F2Ú5 — preserve restart counter across crash-driven respawns; first-time
      // spawn starts at 0. Caller (respawn) resets when restartCountResetMs elapses.
      restartCount: existing?.restartCount ?? 0,
      lastSuccessfulRunStartedAt: 0,
    };
    this.engines.set(workspace.id, engine);

    // F2Ú5 — register exit handler. Fires for both intentional kill (SIGTERM
    // from stopChild) and real crashes; handleExit distinguishes via
    // `intentionallyStopping` Set.
    child.on("exit", (code, signal) => this.handleExit(workspace.id, code, signal));

    let spawnFailureClass = "unknown";
    try {
      await this.deps.waitForHealthy(baseUrl);
    } catch (err) {
      engine.state = "crashed";
      this.engines.delete(workspace.id);
      if (FLOW_LOG_ENABLED) {
        console.log(
          `[veslo:flow] ENGINE healthy:FAIL { wsId: ${JSON.stringify(
            workspace.id,
          )}, ms: ${this.deps.now() - spawnedAt}, reason: ${JSON.stringify(
            String(err),
          )} }`,
        );
      }
      // [veslo:spawn-diag] Always-on classification of a spawn-health failure so a
      // single run distinguishes A–E (child never spawned / spawned then died /
      // port never listened / port listens but /global/health fails / health ok
      // but later request fails). See dev-specific/veslo-server-opencode-proxy-500-2026-06-04.md.
      {
        const diagMs = this.deps.now() - spawnedAt;
        const childAlive = child.exitCode === null && child.signalCode === null;
        let rawProbe = "skipped";
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 2_000);
          try {
            const probeUrl = `${baseUrl.replace(/\/+$/, "")}/global/health`;
            const res = await fetch(probeUrl, { signal: controller.signal });
            rawProbe = `http ${res.status}`;
          } catch (probeErr) {
            rawProbe = `threw ${(probeErr as Error)?.name ?? "Error"}: ${(probeErr as Error)?.message ?? String(probeErr)}`;
          } finally {
            clearTimeout(timer);
          }
        } catch {
          /* never let diagnostics break the spawn path */
        }
        spawnFailureClass =
          (child.pid ?? null) === null
            ? "A:child-never-spawned"
            : !childAlive
              ? "B:child-died-immediately"
              : rawProbe.startsWith("threw")
                ? "C:port-not-listening"
                : rawProbe.startsWith("http")
                  ? "D:health-route-unresponsive"
                  : "unknown";
        const diagPayload = {
          class: spawnFailureClass,
          workspaceId: workspace.id,
          baseUrl,
          port,
          ms: diagMs,
          childPid: child.pid ?? null,
          childAlive,
          childExitCode: child.exitCode,
          childSignal: child.signalCode,
          hostProbe: rawProbe,
          waitForHealthyError: String(err),
        };
        if (opencodeHealthDiagEnabled()) {
          writeSpawnDiag("spawn-diag", diagPayload);
          console.error(`[veslo:spawn-diag] engine health FAILED ${JSON.stringify(diagPayload)}`);
        }
      }
      // F2Ú5 — spawn-time fail (engine never reached ready). Mark intentional
      // before stopChild so the exit handler doesn't trigger restart logic.
      this.intentionallyStopping.add(workspace.id);
      try {
        await this.deps.stopChild(child);
      } catch (cleanupErr) {
        this.deps.log?.("engine cleanup after health failure failed", {
          workspaceId: workspace.id,
          error: String(cleanupErr),
        });
      } finally {
        this.intentionallyStopping.delete(workspace.id);
      }
      throw new Error(
        `engine spawn-health failed [${spawnFailureClass}] (${this.deps.now() - spawnedAt}ms): ${String(err)}`,
      );
    }

    engine.state = "ready";
    engine.lastActivityAt = this.deps.now();
    engine.lastSuccessfulRunStartedAt = engine.lastActivityAt;
    writeSpawnDiag("engine-ready", {
      workspaceId: workspace.id,
      pid: engine.pid,
      port,
      baseUrl,
      childKind: engine.childKind,
      ms: engine.lastActivityAt - spawnedAt,
    });
    if (FLOW_LOG_ENABLED) {
      console.log(
        `[veslo:flow] ENGINE healthy { wsId: ${JSON.stringify(
          workspace.id,
        )}, ms: ${engine.lastActivityAt - spawnedAt}, pid: ${engine.pid}, port: ${port} }`,
      );
    }
    this.deps.log?.("engine ready", {
      workspaceId: workspace.id,
      baseUrl,
      pid: engine.pid,
    });
    this.emit(workspace.id, "spawned");
    return engine;
  }

  /**
   * F2Ú5 — `child.on('exit')` callback. Distinguishes intentional kills
   * (via `intentionallyStopping` Set, populated by suspend/killAll/spawn-fail)
   * from real crashes. Crashes schedule a restart with exponential backoff
   * (capped at `maxRestarts` attempts).
   */
  private handleExit(
    workspaceId: string,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.intentionallyStopping.has(workspaceId)) {
      // Intentional kill (suspend, killAll, spawn cleanup) — Set is cleared by caller.
      return;
    }
    const engine = this.engines.get(workspaceId);
    if (!engine) return;
    // Engine never reached "ready" (waitForHealthy threw earlier in spawn).
    // Don't treat as crash; ensure() callsite already got the throw.
    if (engine.lastSuccessfulRunStartedAt === 0) return;
    if (engine.childKind === "wsl" && (engine.state === "ready" || engine.state === "idle")) {
      writeSpawnDiag("engine-wrapper-exit-kept", {
        workspaceId,
        state: engine.state,
        pid: engine.pid,
        port: engine.port,
        code,
        signal,
      });
      this.deps.log?.("engine wrapper exited; keeping WSL engine under health monitor", {
        workspaceId,
        code,
        signal,
      });
      return;
    }

    this.markEngineCrashed(workspaceId, engine, code, signal);
  }

  private markEngineCrashed(
    workspaceId: string,
    engine: EngineProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    this.deps.log?.("engine crashed", { workspaceId, code, signal });
    writeSpawnDiag("engine-crashed", {
      workspaceId,
      pid: engine.pid,
      port: engine.port,
      state: engine.state,
      code,
      signal,
    });
    engine.state = "crashed";

    // F2Ú5 — reset restart counter if the engine ran stably for long enough.
    const stableRunDuration = this.deps.now() - engine.lastSuccessfulRunStartedAt;
    if (stableRunDuration > this.config.restartCountResetMs) {
      engine.restartCount = 0;
    }
    engine.restartCount += 1;

    if (engine.restartCount > this.config.maxRestarts) {
      this.deps.log?.("engine permanently failed", {
        workspaceId,
        restartCount: engine.restartCount,
      });
      this.emit(workspaceId, "permanently-failed");
      return;
    }

    this.emit(workspaceId, "crashed");

    // Exponential backoff: base * 2^(attempt-1), capped at max.
    const backoff = Math.min(
      this.config.restartBackoffBaseMs * 2 ** (engine.restartCount - 1),
      this.config.restartBackoffMaxMs,
    );
    this.deps.log?.("engine restart scheduled", {
      workspaceId,
      attempt: engine.restartCount,
      backoffMs: backoff,
    });
    this.emit(workspaceId, "restart-scheduled");

    const handle = this.deps.schedule.setTimeout(() => {
      this.restartTimers.delete(workspaceId);
      void this.respawn(workspaceId);
    }, backoff);
    this.restartTimers.set(workspaceId, handle);
  }

  /**
   * F2Ú5 — re-spawn an engine after crash backoff. Preserves the original
   * workspace (workdir/path) by reading from the existing crashed engine.
   * Failure to respawn (spawn throws) is treated as another exit event,
   * incrementing restartCount until maxRestarts is reached.
   */
  private async respawn(workspaceId: string): Promise<void> {
    const engine = this.engines.get(workspaceId);
    if (!engine) return;
    const existingPending = this.pending.get(workspaceId);
    if (existingPending) {
      try {
        await existingPending;
      } catch {
        // The foreground caller owns the original failure response.
      }
      return;
    }
    this.emit(workspaceId, "restart-attempt");
    // Reconstruct EngineWorkspace from saved fields. workdir was set by
    // resolveWorkspace; we don't have original path here, but workdir IS the
    // resolved path so passing it as path is correct for re-resolution.
    const workspace: EngineWorkspace = { id: workspaceId, path: engine.workdir };
    try {
      await this.startPending(workspace, false);
    } catch (err) {
      // spawn throws when waitForHealthy fails. Manually trigger handleExit
      // semantics — but `lastSuccessfulRunStartedAt` was reset to 0 inside
      // spawn for the new attempt, so simple handleExit early-returns. Bump
      // restartCount manually and schedule another attempt or give up.
      this.deps.log?.("engine respawn failed", {
        workspaceId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Re-fetch — spawn may have left engine in deleted state on health fail.
      const current = this.engines.get(workspaceId);
      // Replicate handleExit decision branch but without intentionallyStopping check.
      const carriedRestartCount = (current?.restartCount ?? engine.restartCount) + 1;
      if (carriedRestartCount > this.config.maxRestarts) {
        this.deps.log?.("engine permanently failed after respawn", {
          workspaceId,
          restartCount: carriedRestartCount,
        });
        this.emit(workspaceId, "permanently-failed");
        return;
      }
      // Re-insert a placeholder so we can schedule next attempt with counter.
      this.engines.set(workspaceId, {
        ...engine,
        state: "crashed",
        restartCount: carriedRestartCount,
        lastSuccessfulRunStartedAt: 0,
      });
      const backoff = Math.min(
        this.config.restartBackoffBaseMs * 2 ** (carriedRestartCount - 1),
        this.config.restartBackoffMaxMs,
      );
      this.emit(workspaceId, "restart-scheduled");
      const handle = this.deps.schedule.setTimeout(() => {
        this.restartTimers.delete(workspaceId);
        void this.respawn(workspaceId);
      }, backoff);
      this.restartTimers.set(workspaceId, handle);
    }
  }

  /**
   * F2Ú5 — global health monitor tick. For each `ready` engine: race
   * `deps.healthCheck(baseUrl)` against `healthCheckTimeoutMs`. Failures
   * accumulate in `engine.healthStrikes`; reaching `healthFailureThreshold`
   * marks the engine crashed and schedules a restart. One engine's failure
   * never breaks the loop.
   */
  private async runHealthChecks(): Promise<void> {
    if (!this.deps.healthCheck) return;
    const targets = Array.from(this.engines.values()).filter(
      (engine) => engine.state === "ready",
    );
    await Promise.all(
      targets.map(async (engine) => {
        if (this.intentionallyStopping.has(engine.workspaceId)) return;
        try {
          await Promise.race([
            this.deps.healthCheck!(engine.baseUrl),
            new Promise<void>((_, reject) =>
              setTimeout(
                () => reject(new Error("health probe timeout")),
                this.config.healthCheckTimeoutMs,
              ),
            ),
          ]);
          // Probe succeeded — reset strikes (and emit recovery edge only).
          if (engine.healthStrikes > 0) {
            engine.healthStrikes = 0;
            this.emit(engine.workspaceId, "healthy");
          }
        } catch (err) {
          engine.healthStrikes += 1;
          this.deps.log?.("engine health probe failed", {
            workspaceId: engine.workspaceId,
            strike: engine.healthStrikes,
            error: err instanceof Error ? err.message : String(err),
          });
          if (engine.healthStrikes === 1) {
            this.emit(engine.workspaceId, "unhealthy");
          }
          if (engine.healthStrikes >= this.config.healthFailureThreshold) {
            // Health failure is authoritative for WSL engines too. Do not route
            // this through handleExit(), because WSL wrapper exits are normally
            // ignored once the engine is ready; here repeated failed probes mean
            // the actual engine endpoint is gone or wedged and must restart.
            engine.healthStrikes = 0;
            this.intentionallyStopping.add(engine.workspaceId);
            try {
              if (this.deps.isProcessAlive(engine.pid)) {
                await this.deps.stopChild(engine.child);
              }
            } catch (killErr) {
              this.deps.log?.("engine health-driven kill failed", {
                workspaceId: engine.workspaceId,
                error: String(killErr),
              });
            } finally {
              this.intentionallyStopping.delete(engine.workspaceId);
            }
            if (engine.state === "ready") {
              this.markEngineCrashed(engine.workspaceId, engine, -1, null);
            }
          }
        }
      }),
    );
  }
}
