import type { ReloadTrigger } from "../types";

type TimerId = ReturnType<typeof setTimeout>;

type Scheduler = {
  setTimeout: (callback: () => void, ms: number) => TimerId;
  clearTimeout: (id: TimerId) => void;
};

export function createSkillReloadGuard(options: {
  graceMs: number;
  onFallbackNeeded: (trigger?: ReloadTrigger) => void;
  scheduler?: Scheduler;
}) {
  const scheduler = options.scheduler ?? {
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (id: TimerId) => clearTimeout(id),
  };

  let timer: TimerId | null = null;
  let pendingTrigger: ReloadTrigger | undefined;

  const cancel = () => {
    if (!timer) return;
    scheduler.clearTimeout(timer);
    timer = null;
    pendingTrigger = undefined;
  };

  const scheduleSkillFallback = (trigger?: ReloadTrigger) => {
    pendingTrigger = trigger;
    if (timer) {
      scheduler.clearTimeout(timer);
      timer = null;
    }

    timer = scheduler.setTimeout(() => {
      timer = null;
      const snapshot = pendingTrigger;
      pendingTrigger = undefined;
      options.onFallbackNeeded(snapshot);
    }, options.graceMs);
  };

  const hotReloadApplied = () => {
    const hadPending = Boolean(timer);
    cancel();
    return hadPending;
  };

  return {
    scheduleSkillFallback,
    hotReloadApplied,
    hasPending: () => Boolean(timer),
    dispose: cancel,
  };
}
