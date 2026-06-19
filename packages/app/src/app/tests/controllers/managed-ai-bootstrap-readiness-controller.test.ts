import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveManagedAiBootstrapCurrentConfigCheck,
  resolveManagedAiBootstrapWaitDecision,
} from "../../controllers/managed-ai-bootstrap-readiness-controller.js";

test("managed AI bootstrap readiness validates current config only during isolated access refresh", () => {
  assert.deepEqual(
    resolveManagedAiBootstrapCurrentConfigCheck({
      accessBusy: true,
      bootstrapPendingCount: 0,
      reloadBusy: false,
    }),
    { type: "check-current-config" },
  );

  assert.deepEqual(
    resolveManagedAiBootstrapCurrentConfigCheck({
      accessBusy: false,
      bootstrapPendingCount: 0,
      reloadBusy: false,
    }),
    { type: "skip-current-config-check", reason: "access-not-busy" },
  );

  assert.deepEqual(
    resolveManagedAiBootstrapCurrentConfigCheck({
      accessBusy: true,
      bootstrapPendingCount: 1,
      reloadBusy: false,
    }),
    { type: "skip-current-config-check", reason: "bootstrap-pending" },
  );

  assert.deepEqual(
    resolveManagedAiBootstrapCurrentConfigCheck({
      accessBusy: true,
      bootstrapPendingCount: 0,
      reloadBusy: true,
    }),
    { type: "skip-current-config-check", reason: "reload-busy" },
  );
});

test("managed AI bootstrap readiness bypasses wait when current runtime config is already usable", () => {
  assert.deepEqual(
    resolveManagedAiBootstrapWaitDecision({
      managedProfilePresent: false,
      bootstrapBusy: true,
      canUseCurrentManagedConfig: true,
    }),
    { hasManagedProfile: false },
  );

  assert.deepEqual(
    resolveManagedAiBootstrapWaitDecision({
      managedProfilePresent: true,
      bootstrapBusy: true,
      canUseCurrentManagedConfig: true,
    }),
    { hasManagedProfile: false },
  );
});

test("managed AI bootstrap readiness waits when profile or bootstrap work is active and current config is not usable", () => {
  assert.deepEqual(
    resolveManagedAiBootstrapWaitDecision({
      managedProfilePresent: true,
      bootstrapBusy: false,
      canUseCurrentManagedConfig: false,
    }),
    { hasManagedProfile: true },
  );

  assert.deepEqual(
    resolveManagedAiBootstrapWaitDecision({
      managedProfilePresent: false,
      bootstrapBusy: true,
      canUseCurrentManagedConfig: false,
    }),
    { hasManagedProfile: true },
  );

  assert.deepEqual(
    resolveManagedAiBootstrapWaitDecision({
      managedProfilePresent: false,
      bootstrapBusy: false,
      canUseCurrentManagedConfig: false,
    }),
    { hasManagedProfile: false },
  );
});
