import { describe, expect, test } from "bun:test";

import { createKeyedLifecycleScheduler } from "../keyed-lifecycle-scheduler.js";

function schedulerHarness() {
  let nextId = 0;
  const timers = new Map<number, { callback: () => void; delayMs: number }>();
  const cleared: number[] = [];
  const callbackErrors: string[] = [];
  const fired: Array<{ namespace: string; key: string; delayMs: number; reason?: string; attempt?: number }> = [];
  const scheduler = createKeyedLifecycleScheduler({
    timers: {
      setTimeout(callback, delayMs) {
        const id = ++nextId;
        timers.set(id, { callback, delayMs });
        return id;
      },
      clearTimeout(handle) {
        const id = handle as number;
        timers.delete(id);
        cleared.push(id);
      },
    },
    onTimerFired: (entry) => fired.push(entry),
    onCallbackError: (_entry, error) => callbackErrors.push(error instanceof Error ? error.message : String(error)),
  });
  return { scheduler, timers, cleared, callbackErrors, fired };
}

describe("keyed lifecycle scheduler", () => {
  test("coalesces a keyed wake unless its owner explicitly brings it forward", () => {
    const { scheduler, timers, cleared, fired } = schedulerHarness();
    const calls: string[] = [];
    const first = scheduler.schedule({
      namespace: "reconcile",
      key: "ws\0conv\0run",
      delayMs: 500,
      replaceExisting: false,
      run: () => { calls.push("first"); },
    });
    const coalesced = scheduler.schedule({
      namespace: "reconcile",
      key: "ws\0conv\0run",
      delayMs: 0,
      replaceExisting: false,
      run: () => { calls.push("second"); },
    });
    const replaced = scheduler.schedule({
      namespace: "reconcile",
      key: "ws\0conv\0run",
      delayMs: 0,
      reason: "terminal-observed",
      attempt: 2,
      replaceExisting: true,
      run: () => { calls.push("replacement"); },
    });

    expect(first.kind).toBe("scheduled");
    expect(coalesced).toEqual({ kind: "coalesced", handle: first.handle });
    expect(replaced.kind).toBe("scheduled");
    expect(cleared).toEqual([first.handle as number]);
    const timer = timers.get(replaced.handle as number);
    expect(timer?.delayMs).toBe(0);
    timer?.callback();
    expect(calls).toEqual(["replacement"]);
    expect(fired).toEqual([{
      namespace: "reconcile",
      key: "ws\0conv\0run",
      delayMs: 0,
      reason: "terminal-observed",
      attempt: 2,
    }]);
    expect(scheduler.pending()).toEqual([]);
  });

  test("clears timer state before reporting a thrown callback and cancels all remaining keys", () => {
    const { scheduler, timers, callbackErrors } = schedulerHarness();
    const failed = scheduler.schedule({
      namespace: "queue-drain",
      key: "ws\0conv",
      delayMs: 0,
      replaceExisting: false,
      run: () => { throw new Error("wake failed"); },
    });
    const retained = scheduler.schedule({
      namespace: "starting-recovery",
      key: "ws\0item",
      delayMs: 100,
      replaceExisting: false,
      run: () => {},
    });
    timers.get(failed.handle as number)?.callback();

    expect(callbackErrors).toEqual(["wake failed"]);
    expect(scheduler.pending()).toEqual([{ namespace: "starting-recovery", key: "ws\0item", delayMs: 100 }]);
    scheduler.cancelAll();
    expect(timers.has(retained.handle as number)).toBe(false);
    expect(scheduler.pending()).toEqual([]);
  });
});
