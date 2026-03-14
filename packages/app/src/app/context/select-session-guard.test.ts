import assert from "node:assert/strict";
import test from "node:test";

import { createSelectSessionGuard } from "./select-session-guard.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Basic behaviour
// ---------------------------------------------------------------------------

test("tryDedup returns null when no in-flight exists", () => {
  const guard = createSelectSessionGuard();
  guard.nextVersion();
  assert.equal(guard.tryDedup("sess-A"), null);
});

test("tryDedup joins when same session is selected on the very next version", () => {
  const guard = createSelectSessionGuard();
  const v1 = guard.nextVersion();
  const gate = deferred();
  guard.register("sess-A", v1, gate.promise);

  // Immediately re-select A (next version, no intervening session)
  const v2 = guard.nextVersion();
  assert.equal(v2 - v1, 1, "versions should be consecutive");
  const result = guard.tryDedup("sess-A");
  assert.equal(result, gate.promise, "should join the in-flight promise");

  gate.resolve();
});

test("tryDedup does NOT join when another session was selected in between (A→B→A)", () => {
  const guard = createSelectSessionGuard();

  // Select A
  const v1 = guard.nextVersion();
  const gateA = deferred();
  guard.register("sess-A", v1, gateA.promise);

  // Select B (intervening selection)
  const v2 = guard.nextVersion();
  const gateB = deferred();
  guard.register("sess-B", v2, gateB.promise);

  // Select A again
  const v3 = guard.nextVersion();
  const result = guard.tryDedup("sess-A");
  assert.equal(result, null, "must NOT join the stale in-flight for A");
  assert.equal(v3 - v1, 2, "two versions apart — not consecutive");

  gateA.resolve();
  gateB.resolve();
});

// ---------------------------------------------------------------------------
// Rapid back-and-forth: the exact freeze scenario
// ---------------------------------------------------------------------------

test("A→B→A rapid switch: third selection must start fresh load (not join stale)", () => {
  const guard = createSelectSessionGuard();
  const loads: string[] = [];

  // Click 1: select A
  const v1 = guard.nextVersion();
  const runA1 = deferred();
  guard.register("sess-A", v1, runA1.promise);
  loads.push("A:started");

  // Click 2: select B (while A is still loading)
  const v2 = guard.nextVersion();
  const runB = deferred();
  guard.register("sess-B", v2, runB.promise);
  loads.push("B:started");

  // Click 3: select A again (while both A and B are still loading)
  const v3 = guard.nextVersion();
  const dupA = guard.tryDedup("sess-A");

  // THE CRITICAL ASSERTION: must NOT join the stale A load
  assert.equal(dupA, null, "must return null so caller starts a fresh load for A");

  // Caller starts fresh load for A
  const runA2 = deferred();
  guard.register("sess-A", v3, runA2.promise);
  loads.push("A:restarted");

  // Verify the correct sequence
  assert.deepEqual(loads, ["A:started", "B:started", "A:restarted"]);

  runA1.resolve();
  runB.resolve();
  runA2.resolve();
});

test("A→B→C→A rapid switch: must not join stale A load from 3 versions ago", () => {
  const guard = createSelectSessionGuard();

  const v1 = guard.nextVersion();
  const runA1 = deferred();
  guard.register("sess-A", v1, runA1.promise);

  guard.nextVersion(); // B
  guard.nextVersion(); // C

  const v4 = guard.nextVersion(); // A again
  assert.equal(guard.tryDedup("sess-A"), null, "4 versions apart — must not join");

  runA1.resolve();
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

test("cleanup removes matching entry", () => {
  const guard = createSelectSessionGuard();
  const v1 = guard.nextVersion();
  const gate = deferred();
  guard.register("sess-A", v1, gate.promise);

  guard.cleanup("sess-A", gate.promise);

  // After cleanup, tryDedup should return null
  const v2 = guard.nextVersion();
  assert.equal(guard.tryDedup("sess-A"), null);

  gate.resolve();
});

test("cleanup does not remove entry if promise does not match (replaced by newer load)", () => {
  const guard = createSelectSessionGuard();

  // First load
  const v1 = guard.nextVersion();
  const gate1 = deferred();
  guard.register("sess-A", v1, gate1.promise);

  // Second load replaces first
  const v2 = guard.nextVersion();
  const gate2 = deferred();
  guard.register("sess-A", v2, gate2.promise);

  // First load finishes and tries to clean up — should NOT remove the newer entry
  guard.cleanup("sess-A", gate1.promise);

  // The newer entry should still be dedup-joinable (consecutive version)
  const v3 = guard.nextVersion();
  assert.equal(guard.tryDedup("sess-A"), gate2.promise);

  gate1.resolve();
  gate2.resolve();
});

// ---------------------------------------------------------------------------
// Double-click (genuine duplicate) should still dedup
// ---------------------------------------------------------------------------

test("double-click on same session still deduplicates", () => {
  const guard = createSelectSessionGuard();

  // First click on A
  const v1 = guard.nextVersion();
  const gate = deferred();
  guard.register("sess-A", v1, gate.promise);

  // Second click on A (route re-fire, double-click, etc.)
  const v2 = guard.nextVersion();
  assert.equal(v2 - v1, 1, "consecutive versions");
  const result = guard.tryDedup("sess-A");
  assert.equal(result, gate.promise, "should join — genuine duplicate");

  gate.resolve();
});
