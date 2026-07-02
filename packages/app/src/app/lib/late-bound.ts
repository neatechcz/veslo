import { createSignal } from "solid-js";

/**
 * Late-bound dependency slot for the app composition root.
 *
 * The composition graph in `app.tsx` has true cycles (workspace store ↔
 * session store ↔ sidebar sessions), so some dependencies can only be bound
 * after their consumer is created. Historically each of those seams used its
 * own ad-hoc mutable variable, which failed silently when accessed before
 * binding. This utility makes every late-bound seam uniform and observable:
 *
 * - `current()` is reactive (signal-backed), so memos/effects that read a
 *   dependency before it is bound re-evaluate once `bind()` runs.
 * - The first pre-bind access is reported through `onEarlyAccess`, so silent
 *   no-op windows during boot become visible in diagnostics instead of
 *   surfacing later as unexplained race bugs.
 * - `whenBound()` queues work that must not be lost when it arrives before
 *   the dependency exists (for example auth events during startup). Queued
 *   entries with the same `key` collapse into the latest one.
 */
export type LateBound<T> = {
  /** Reactive accessor. Returns null until `bind()` has run. */
  current: () => T | null;
  /** Binds the dependency and flushes callbacks queued via `whenBound()`. */
  bind: (value: T) => void;
  isBound: () => boolean;
  /**
   * Runs `callback` immediately when bound, otherwise queues it until
   * `bind()`. When `key` is provided, a queued entry with the same key is
   * replaced instead of accumulating duplicate work.
   */
  whenBound: (callback: (value: T) => void, options?: { key?: string }) => void;
};

export type LateBoundOptions = {
  /** Called once, on the first `current()` access that happens before `bind()`. */
  onEarlyAccess?: (name: string) => void;
};

export function createLateBound<T>(name: string, options: LateBoundOptions = {}): LateBound<T> {
  // The value is wrapped so function-typed dependencies are not mistaken for
  // signal updater callbacks by the setter.
  const [slot, setSlot] = createSignal<{ value: T } | null>(null);
  const queue: Array<{ key: string | null; callback: (value: T) => void }> = [];
  let earlyAccessReported = false;

  const current = () => {
    const bound = slot();
    if (!bound && !earlyAccessReported) {
      earlyAccessReported = true;
      options.onEarlyAccess?.(name);
    }
    return bound ? bound.value : null;
  };

  const bind = (value: T) => {
    setSlot({ value });
    while (queue.length > 0) {
      const entry = queue.shift();
      entry?.callback(value);
    }
  };

  const whenBound = (callback: (value: T) => void, whenBoundOptions?: { key?: string }) => {
    const bound = slot();
    if (bound) {
      callback(bound.value);
      return;
    }
    const key = whenBoundOptions?.key ?? null;
    if (key !== null) {
      const existingIndex = queue.findIndex((entry) => entry.key === key);
      if (existingIndex !== -1) {
        queue.splice(existingIndex, 1, { key, callback });
        return;
      }
    }
    queue.push({ key, callback });
  };

  return {
    current,
    bind,
    isBound: () => Boolean(slot()),
    whenBound,
  };
}
