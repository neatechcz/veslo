export type KeyedLifecycleSchedulerTimerPort = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  unref?(handle: unknown): void;
};

export type KeyedLifecycleSchedulerEntry = {
  namespace: string;
  key: string;
  delayMs: number;
  reason?: string;
  attempt?: number;
};

export type KeyedLifecycleScheduler = {
  schedule(input: KeyedLifecycleSchedulerEntry & {
    replaceExisting: boolean;
    run: () => void | Promise<void>;
  }): { kind: "scheduled"; handle: unknown } | { kind: "coalesced"; handle: unknown };
  cancel(namespace: string, key: string): boolean;
  cancelAll(): void;
  pending(namespace?: string): KeyedLifecycleSchedulerEntry[];
};

const entryId = (namespace: string, key: string) => `${namespace}\0${key}`;

/**
 * Owns only ephemeral keyed timers. It intentionally has no knowledge of
 * reservations, queue state, or lifecycle outcomes; callers decide whether a
 * wake should be coalesced and perform all durable effects themselves.
 */
export function createKeyedLifecycleScheduler(options: {
  timers: KeyedLifecycleSchedulerTimerPort;
  onTimerScheduled?: (handle: unknown) => void;
  onTimerCleared?: (handle: unknown) => void;
  onTimerFired?: (entry: KeyedLifecycleSchedulerEntry) => void;
  onCallbackError?: (entry: KeyedLifecycleSchedulerEntry, error: unknown) => void;
}): KeyedLifecycleScheduler {
  const entries = new Map<string, KeyedLifecycleSchedulerEntry & { handle: unknown }>();

  const clear = (id: string) => {
    const existing = entries.get(id);
    if (!existing) return false;
    entries.delete(id);
    options.timers.clearTimeout(existing.handle);
    options.onTimerCleared?.(existing.handle);
    return true;
  };

  return {
    schedule(input) {
      const id = entryId(input.namespace, input.key);
      const existing = entries.get(id);
      if (existing && !input.replaceExisting) {
        return { kind: "coalesced", handle: existing.handle };
      }
      if (existing) clear(id);

      const entry: KeyedLifecycleSchedulerEntry = {
        namespace: input.namespace,
        key: input.key,
        delayMs: Math.max(0, Math.floor(input.delayMs)),
        ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
        ...(typeof input.attempt === "number" && Number.isFinite(input.attempt)
          ? { attempt: Math.max(0, Math.floor(input.attempt)) }
          : {}),
      };
      const handle = options.timers.setTimeout(() => {
        const current = entries.get(id);
        if (!current || current.handle !== handle) return;
        entries.delete(id);
        options.onTimerCleared?.(handle);
        options.onTimerFired?.(entry);
        try {
          const result = input.run();
          if (result && typeof (result as Promise<void>).then === "function") {
            void (result as Promise<void>).catch((error) => options.onCallbackError?.(entry, error));
          }
        } catch (error) {
          options.onCallbackError?.(entry, error);
        }
      }, entry.delayMs);
      entries.set(id, { ...entry, handle });
      options.onTimerScheduled?.(handle);
      options.timers.unref?.(handle);
      return { kind: "scheduled", handle };
    },
    cancel(namespace, key) {
      return clear(entryId(namespace, key));
    },
    cancelAll() {
      for (const id of [...entries.keys()]) clear(id);
    },
    pending(namespace) {
      return [...entries.values()]
        .filter((entry) => !namespace || entry.namespace === namespace)
        .map(({ namespace: entryNamespace, key, delayMs, reason, attempt }) => ({
          namespace: entryNamespace,
          key,
          delayMs,
          ...(reason ? { reason } : {}),
          ...(attempt !== undefined ? { attempt } : {}),
        }));
    },
  };
}
