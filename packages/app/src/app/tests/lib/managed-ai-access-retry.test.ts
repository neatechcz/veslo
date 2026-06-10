import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveManagedAiAccessRetryDelayMs,
  shouldRetryManagedAiAccessRefresh,
} from "../../lib/managed-ai-access-retry.js";

test("shouldRetryManagedAiAccessRefresh retries when an authenticated user still has no profile", () => {
  assert.equal(
    shouldRetryManagedAiAccessRefresh({
      hasGatewayClient: true,
      userToken: "den-user-token",
      profilePresent: false,
    }),
    true,
  );
});

test("shouldRetryManagedAiAccessRefresh stops retrying without auth, gateway, or once a profile exists", () => {
  assert.equal(
    shouldRetryManagedAiAccessRefresh({
      hasGatewayClient: false,
      userToken: "den-user-token",
      profilePresent: false,
    }),
    false,
  );
  assert.equal(
    shouldRetryManagedAiAccessRefresh({
      hasGatewayClient: true,
      userToken: "   ",
      profilePresent: false,
    }),
    false,
  );
  assert.equal(
    shouldRetryManagedAiAccessRefresh({
      hasGatewayClient: true,
      userToken: "den-user-token",
      profilePresent: true,
    }),
    false,
  );
});

test("resolveManagedAiAccessRetryDelayMs uses bounded backoff", () => {
  assert.equal(resolveManagedAiAccessRetryDelayMs(0), 2_000);
  assert.equal(resolveManagedAiAccessRetryDelayMs(1), 5_000);
  assert.equal(resolveManagedAiAccessRetryDelayMs(4), 30_000);
  assert.equal(resolveManagedAiAccessRetryDelayMs(99), 60_000);
});
