import assert from "node:assert/strict";
import test from "node:test";

import { createStartupGuard } from "./startup-guard.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("fires timeout callback when startup guard is not completed", async () => {
  let timedOut = 0;
  createStartupGuard({
    timeoutMs: 15,
    onTimeout: () => {
      timedOut += 1;
    },
  });

  await sleep(40);
  assert.equal(timedOut, 1);
});

test("does not fire timeout callback after startup guard completes", async () => {
  let timedOut = 0;
  const guard = createStartupGuard({
    timeoutMs: 40,
    onTimeout: () => {
      timedOut += 1;
    },
  });

  const completed = guard.complete();
  await sleep(70);

  assert.equal(completed, true);
  assert.equal(timedOut, 0);
});

test("completion is idempotent", async () => {
  const guard = createStartupGuard({
    timeoutMs: 30,
    onTimeout: () => {
      // should never fire in this test
    },
  });

  assert.equal(guard.complete(), true);
  assert.equal(guard.complete(), false);
});
