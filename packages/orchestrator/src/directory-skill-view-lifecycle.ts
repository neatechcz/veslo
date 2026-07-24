export type DirectorySkillViewState = "ready" | "draining" | "reloading";

export type DirectorySkillViewInstance = {
  directoryInstanceKey: string;
  directoryInstanceEpoch: number;
  skillViewRevision?: string;
  state: DirectorySkillViewState;
  pendingSkillViewRevision?: string;
};

export type DirectorySkillViewAdmission =
  | { admitted: true; instance: DirectorySkillViewInstance }
  | { admitted: false; retryAfterMs: number; state: Exclude<DirectorySkillViewState, "ready"> };

export type DirectorySkillViewRefreshResult =
  | { status: "ready"; instance: DirectorySkillViewInstance }
  | { status: "deferred"; instance: DirectorySkillViewInstance; retryAfterMs: number };

type DirectorySkillViewLifecycleDeps = {
  /** Publish the new server-owned view while the directory is closed to admission. */
  publish: (input: { directoryInstanceKey: string; skillViewRevision: string }) => Promise<void>;
  /** Dispose only this OpenCode directory instance after its runs are idle. */
  dispose: (input: { directoryInstanceKey: string }) => Promise<void>;
  /** Active work is scoped to the directory/workspace, never the whole process. */
  hasActiveRun: (input: { directoryInstanceKey: string; excludeRunId?: string }) => boolean;
  retryAfterMs?: number;
  retryScheduler?: {
    schedule: (callback: () => void, delayMs: number) => unknown;
    cancel: (handle: unknown) => void;
  };
  onRetryError?: (input: { directoryInstanceKey: string; error: unknown }) => void;
};

const snapshot = (instance: DirectorySkillViewInstance): DirectorySkillViewInstance => ({ ...instance });

/**
 * Serializes skill-view initialization and refreshes per directory instance.
 * A deferred refresh remains admission-closed and retries itself once active
 * work drains; no later proxy request is needed to finish it.
 */
export class DirectorySkillViewLifecycle {
  private readonly entries = new Map<string, DirectorySkillViewInstance>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly retryTimers = new Map<string, unknown>();
  private readonly retryAfterMs: number;
  private readonly retryScheduler: NonNullable<DirectorySkillViewLifecycleDeps["retryScheduler"]>;

  constructor(private readonly deps: DirectorySkillViewLifecycleDeps) {
    this.retryAfterMs = deps.retryAfterMs ?? 250;
    this.retryScheduler = deps.retryScheduler ?? {
      schedule: (callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        if (typeof timer === "object" && "unref" in timer) timer.unref?.();
        return timer;
      },
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  register(input: { directoryInstanceKey: string; skillViewRevision?: string }): DirectorySkillViewInstance {
    const key = input.directoryInstanceKey.trim();
    if (!key) throw new Error("directory instance key is required");
    const current = this.entries.get(key);
    if (current) return snapshot(current);
    const instance: DirectorySkillViewInstance = {
      directoryInstanceKey: key,
      directoryInstanceEpoch: 0,
      ...(input.skillViewRevision?.trim() ? { skillViewRevision: input.skillViewRevision.trim() } : {}),
      state: "ready",
    };
    this.entries.set(key, instance);
    return snapshot(instance);
  }

  get(directoryInstanceKey: string): DirectorySkillViewInstance | null {
    const instance = this.entries.get(directoryInstanceKey.trim());
    return instance ? snapshot(instance) : null;
  }

  /** Public diagnostic snapshot; callers must not mutate lifecycle state. */
  snapshot(): DirectorySkillViewInstance[] {
    return [...this.entries.values()]
      .map(snapshot)
      .sort((left, right) => left.directoryInstanceKey.localeCompare(right.directoryInstanceKey));
  }

  admit(directoryInstanceKey: string): DirectorySkillViewAdmission {
    const instance = this.require(directoryInstanceKey);
    if (instance.state === "ready") return { admitted: true, instance: snapshot(instance) };
    return { admitted: false, retryAfterMs: this.retryAfterMs, state: instance.state };
  }

  /**
   * Single-flight creation plus refresh. Concurrent first requests cannot
   * publish competing roots because registration happens in this same queue.
   */
  async ensure(input: {
    directoryInstanceKey: string;
    skillViewRevision: string;
    excludeRunId?: string;
  }): Promise<DirectorySkillViewRefreshResult> {
    const key = input.directoryInstanceKey.trim();
    const revision = input.skillViewRevision.trim();
    if (!key) throw new Error("directory instance key is required");
    if (!revision) throw new Error("skill view revision is required");
    return this.enqueue(key, async () => {
      const existing = this.entries.get(key);
      if (!existing) {
        await this.deps.publish({ directoryInstanceKey: key, skillViewRevision: revision });
        const instance: DirectorySkillViewInstance = {
          directoryInstanceKey: key,
          directoryInstanceEpoch: 0,
          skillViewRevision: revision,
          state: "ready",
        };
        this.entries.set(key, instance);
        return { status: "ready", instance: snapshot(instance) };
      }
      if (existing.state === "ready" && existing.skillViewRevision === revision) {
        return { status: "ready", instance: snapshot(existing) };
      }

      const previous = snapshot(existing);
      existing.pendingSkillViewRevision = revision;
      existing.state = "draining";
      try {
        await this.deps.publish({ directoryInstanceKey: existing.directoryInstanceKey, skillViewRevision: revision });
      } catch (error) {
        this.restore(existing, previous);
        throw error;
      }
      return this.reloadIfIdle(existing, input.excludeRunId);
    });
  }

  async requestRefresh(input: {
    directoryInstanceKey: string;
    skillViewRevision: string;
    excludeRunId?: string;
  }): Promise<DirectorySkillViewRefreshResult> {
    return this.ensure(input);
  }

  async completeWhenIdle(directoryInstanceKey: string): Promise<DirectorySkillViewRefreshResult> {
    return this.enqueue(directoryInstanceKey, async () => this.reloadIfIdle(this.require(directoryInstanceKey)));
  }

  private async reloadIfIdle(
    instance: DirectorySkillViewInstance,
    excludeRunId?: string,
  ): Promise<DirectorySkillViewRefreshResult> {
    if (!instance.pendingSkillViewRevision) {
      return { status: "ready", instance: snapshot(instance) };
    }
    if (this.deps.hasActiveRun({ directoryInstanceKey: instance.directoryInstanceKey, excludeRunId })) {
      instance.state = "draining";
      this.scheduleCompletion(instance.directoryInstanceKey);
      return { status: "deferred", instance: snapshot(instance), retryAfterMs: this.retryAfterMs };
    }

    instance.state = "reloading";
    try {
      await this.deps.dispose({ directoryInstanceKey: instance.directoryInstanceKey });
    } catch (error) {
      // The static root may be newer than OpenCode's in-memory directory
      // cache. Admission must stay closed until directory disposal succeeds.
      instance.state = "draining";
      this.scheduleCompletion(instance.directoryInstanceKey);
      throw error;
    }
    instance.directoryInstanceEpoch += 1;
    instance.skillViewRevision = instance.pendingSkillViewRevision;
    delete instance.pendingSkillViewRevision;
    instance.state = "ready";
    this.clearScheduledCompletion(instance.directoryInstanceKey);
    return { status: "ready", instance: snapshot(instance) };
  }

  private restore(target: DirectorySkillViewInstance, previous: DirectorySkillViewInstance): void {
    target.directoryInstanceEpoch = previous.directoryInstanceEpoch;
    target.skillViewRevision = previous.skillViewRevision;
    target.state = previous.state;
    if (previous.pendingSkillViewRevision) target.pendingSkillViewRevision = previous.pendingSkillViewRevision;
    else delete target.pendingSkillViewRevision;
  }

  private scheduleCompletion(directoryInstanceKey: string): void {
    const key = directoryInstanceKey.trim();
    if (!key || this.retryTimers.has(key)) return;
    const handle = this.retryScheduler.schedule(() => {
      this.retryTimers.delete(key);
      void this.completeWhenIdle(key).catch((error) => {
        this.deps.onRetryError?.({ directoryInstanceKey: key, error });
        this.scheduleCompletion(key);
      });
    }, this.retryAfterMs);
    this.retryTimers.set(key, handle);
  }

  private clearScheduledCompletion(directoryInstanceKey: string): void {
    const key = directoryInstanceKey.trim();
    const handle = this.retryTimers.get(key);
    if (handle === undefined) return;
    this.retryTimers.delete(key);
    this.retryScheduler.cancel(handle);
  }

  private require(directoryInstanceKey: string): DirectorySkillViewInstance {
    const key = directoryInstanceKey.trim();
    const instance = this.entries.get(key);
    if (!instance) throw new Error(`directory instance is not registered: ${key}`);
    return instance;
  }

  private async enqueue<T>(directoryInstanceKey: string, operation: () => Promise<T>): Promise<T> {
    const key = directoryInstanceKey.trim();
    const previous = this.queues.get(key) ?? Promise.resolve();
    let resolveQueue: () => void;
    const next = new Promise<void>((resolve) => { resolveQueue = resolve; });
    const queued = previous.then(() => next);
    this.queues.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      resolveQueue!();
      if (this.queues.get(key) === queued) this.queues.delete(key);
    }
  }
}
