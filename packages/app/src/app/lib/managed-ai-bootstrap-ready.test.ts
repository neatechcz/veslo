import assert from "node:assert/strict";
import test from "node:test";

import { waitForManagedAiBootstrapReady } from "./managed-ai-bootstrap-ready.js";

test("waitForManagedAiBootstrapReady resolves immediately when no managed profile is active", async () => {
  let slept = false;

  await waitForManagedAiBootstrapReady({
    hasManagedProfile: false,
    isBootstrapBusy: () => true,
    isReloadBusy: () => true,
    hasClient: () => false,
    sleep: async () => {
      slept = true;
    },
  });

  assert.equal(slept, false);
});

test("waitForManagedAiBootstrapReady waits for bootstrap, reload, and client recovery", async () => {
  let now = 0;
  let bootstrapBusy = true;
  let reloadBusy = true;
  let clientReady = false;

  await waitForManagedAiBootstrapReady({
    hasManagedProfile: true,
    isBootstrapBusy: () => bootstrapBusy,
    isReloadBusy: () => reloadBusy,
    hasClient: () => clientReady,
    now: () => now,
    pollMs: 10,
    sleep: async (ms) => {
      now += ms;
      if (now >= 10) bootstrapBusy = false;
      if (now >= 20) reloadBusy = false;
      if (now >= 30) clientReady = true;
    },
  });

  assert.equal(now, 30);
});

test("waitForManagedAiBootstrapReady default timeout covers slow desktop engine and config bootstrap", async () => {
  let now = 0;

  await waitForManagedAiBootstrapReady({
    hasManagedProfile: true,
    isBootstrapBusy: () => false,
    isReloadBusy: () => false,
    hasClient: () => now >= 90_000,
    now: () => now,
    pollMs: 30_000,
    sleep: async (ms) => {
      now += ms;
    },
  });

  assert.equal(now, 90_000);
});

test("waitForManagedAiBootstrapReady times out when the client never recovers", async () => {
  let now = 0;

  await assert.rejects(
    () =>
      waitForManagedAiBootstrapReady({
        hasManagedProfile: true,
        isBootstrapBusy: () => false,
        isReloadBusy: () => false,
        hasClient: () => false,
        now: () => now,
        timeoutMs: 25,
        pollMs: 10,
        sleep: async (ms) => {
          now += ms;
        },
      }),
    /Managed AI setup is still applying/,
  );
});
