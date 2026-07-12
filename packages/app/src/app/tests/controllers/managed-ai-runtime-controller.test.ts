import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveManagedAiAccessRefreshFailure,
  resolveManagedAiAccessRefreshPreflight,
  resolveManagedAiAccessRefreshSuccess,
  type ManagedAiRuntimeAccessProfile,
} from "../../controllers/managed-ai-runtime-controller.js";

const profile: ManagedAiRuntimeAccessProfile = {
  userId: "user-a",
  providerId: "codex_oauth",
  effectiveModel: { providerID: "codex_oauth", modelID: "gpt-5.4" },
  updatedAt: null,
};

test("managed AI access preflight resets state when gateway inputs are unavailable", () => {
  assert.deepEqual(
    resolveManagedAiAccessRefreshPreflight({
      hasGatewayClient: false,
      managedAiBaseUrl: "",
      userToken: "token",
      deferForLocalGateway: false,
      cachedAccessPresent: false,
    }),
    { type: "reset", reason: "missing-gateway" },
  );
  assert.deepEqual(
    resolveManagedAiAccessRefreshPreflight({
      hasGatewayClient: true,
      managedAiBaseUrl: "",
      userToken: "   ",
      deferForLocalGateway: false,
      cachedAccessPresent: false,
    }),
    { type: "reset", reason: "missing-user-token" },
  );
  assert.deepEqual(
    resolveManagedAiAccessRefreshPreflight({
      hasGatewayClient: true,
      managedAiBaseUrl: "http://127.0.0.1:8787",
      userToken: "token",
      deferForLocalGateway: true,
      cachedAccessPresent: false,
    }),
    { type: "reset", reason: "deferred-local-gateway" },
  );
});

test("managed AI access preflight loads while preserving cached profile state", () => {
  assert.deepEqual(
    resolveManagedAiAccessRefreshPreflight({
      hasGatewayClient: false,
      managedAiBaseUrl: "https://ai.veslo.work",
      userToken: "token",
      deferForLocalGateway: false,
      cachedAccessPresent: true,
    }),
    { type: "load", applyCachedAccessFirst: true },
  );
});

test("managed AI access preflight uses a fresh local proof without a network refresh", () => {
  assert.deepEqual(
    resolveManagedAiAccessRefreshPreflight({
      hasGatewayClient: true,
      managedAiBaseUrl: "https://ai.veslo.work",
      userToken: "token",
      deferForLocalGateway: false,
      cachedAccessPresent: true,
      freshCachedAccessPresent: true,
    }),
    { type: "use-cache" },
  );
});

test("managed AI access success writes profile/cache or clears stale access and retries", () => {
  assert.deepEqual(
    resolveManagedAiAccessRefreshSuccess({
      profile,
      gatewayAccessToken: "gateway-token",
      reason: null,
    }),
    {
      type: "apply-profile",
      profile,
      gatewayAccessToken: "gateway-token",
      error: null,
      writeCache: true,
      retry: false,
    },
  );
  assert.deepEqual(
    resolveManagedAiAccessRefreshSuccess({
      profile: null,
      gatewayAccessToken: "",
      reason: "No AI access",
    }),
    {
      type: "clear-profile",
      gatewayAccessToken: "",
      error: "No AI access",
      clearCache: true,
      retry: true,
    },
  );
});

test("managed AI access failure preserves cached access while surfacing the refresh error", () => {
  assert.deepEqual(
    resolveManagedAiAccessRefreshFailure({
      cachedAccessPresent: true,
      errorMessage: "Failed to load AI access",
    }),
    {
      clearProfile: false,
      gatewayAccessToken: null,
      error: "Failed to load AI access",
      retry: true,
    },
  );
  assert.deepEqual(
    resolveManagedAiAccessRefreshFailure({
      cachedAccessPresent: false,
      errorMessage: "Failed to load AI access",
    }),
    {
      clearProfile: true,
      gatewayAccessToken: "",
      error: "Failed to load AI access",
      retry: true,
    },
  );
});
