import assert from "node:assert/strict";
import test from "node:test";

import { createNativeWindowTitleLeaseManager } from "../../lib/native-window-title-lease.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("overlapping native title leases keep the centered product title suppressed until the last view releases", async () => {
  const blankTitleGate = deferred<void>();
  const appliedTitles: string[] = [];
  const manager = createNativeWindowTitleLeaseManager({
    applyTitle: async (title) => {
      appliedTitles.push(title);
      await blankTitleGate.promise;
    },
  });

  const releaseSession = manager.acquire();
  const releaseDashboard = manager.acquire();
  releaseSession();

  assert.deepEqual(
    appliedTitles,
    [""],
    "releasing one overlapping view must not restore the product title while another shared titlebar context is still active",
  );

  blankTitleGate.resolve();
  await manager.whenIdle();

  assert.deepEqual(
    appliedTitles,
    [""],
    "the controller should keep the native title blank after the first async apply settles if another lease is still active",
  );

  releaseDashboard();
  await manager.whenIdle();

  assert.deepEqual(appliedTitles, ["", "Veslo by Neatech"]);
});

test("the latest desired native title is applied after an in-flight update finishes", async () => {
  const blankTitleGate = deferred<void>();
  const appliedTitles: string[] = [];
  const manager = createNativeWindowTitleLeaseManager({
    applyTitle: async (title) => {
      appliedTitles.push(title);
      if (title === "") {
        await blankTitleGate.promise;
      }
    },
  });

  const release = manager.acquire();
  release();

  assert.deepEqual(appliedTitles, [""], "the blank title request should start immediately");

  blankTitleGate.resolve();
  await manager.whenIdle();

  assert.deepEqual(
    appliedTitles,
    ["", "Veslo by Neatech"],
    "once the in-flight blank title settles, the controller should apply the latest desired title instead of leaving a stale state behind",
  );
});
