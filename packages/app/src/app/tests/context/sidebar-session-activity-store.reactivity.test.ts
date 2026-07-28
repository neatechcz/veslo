import assert from "node:assert/strict";
import test from "node:test";

import { createComputed, createEffect, createRoot } from "solid-js";

import { createSidebarSessionActivityStore } from "../../context/sidebar-session-activity-store";

const idle = { active: false, phase: "idle" as const, source: null };
const running = { active: true, phase: "running" as const, source: "lifecycle" as const };

function solidRuntimeSupportsEffects(): boolean {
  let observed = 0;
  createRoot((dispose) => {
    const store = createSidebarSessionActivityStore();
    createComputed(() => { observed = store.activityForRowKey("probe") ? 1 : 0; });
    store.reconcile({ probe: running });
    dispose();
  });
  return observed === 1;
}

const behaviorTestOptions = solidRuntimeSupportsEffects()
  ? {}
  : { skip: "Solid's Node server condition does not run effects; use the test:reactivity script." };

test("updating one sidebar activity key does not invalidate another row", behaviorTestOptions, async () => {
  await new Promise<void>((resolve, reject) => {
    createRoot((dispose) => {
      const store = createSidebarSessionActivityStore();
      let alphaRuns = 0;
      let betaRuns = 0;
      createEffect(() => {
        store.activityForRowKey("alpha")?.phase;
        alphaRuns += 1;
      });
      createEffect(() => {
        store.activityForRowKey("beta")?.phase;
        betaRuns += 1;
      });

      queueMicrotask(() => {
        store.reconcile({ alpha: idle, beta: idle });
        queueMicrotask(() => {
          const alphaAfterInitial = alphaRuns;
          const betaAfterInitial = betaRuns;
          store.reconcile({ alpha: running, beta: idle });
          queueMicrotask(() => {
            try {
              assert.equal(alphaRuns, alphaAfterInitial + 1);
              assert.equal(betaRuns, betaAfterInitial);
              dispose();
              resolve();
            } catch (error) {
              dispose();
              reject(error);
            }
          });
        });
      });
    });
  });
});
