import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveManagedAiConfigSyncPreflight,
  resolveManagedAiConfigWriteDecision,
} from "../../controllers/managed-ai-config-sync.js";

test("managed AI config sync preflight only runs for explicit local desktop workspace models", () => {
  assert.deepEqual(
    resolveManagedAiConfigSyncPreflight({
      workspaceDefaultModelReady: false,
      isDesktopRuntime: true,
      defaultModelExplicit: true,
      workspaceType: "local",
      workspaceRoot: "C:/work/app",
    }),
    { type: "skip", reason: "workspace-default-model-not-ready" },
  );

  assert.deepEqual(
    resolveManagedAiConfigSyncPreflight({
      workspaceDefaultModelReady: true,
      isDesktopRuntime: true,
      defaultModelExplicit: true,
      workspaceType: "remote",
      workspaceRoot: "C:/work/app",
    }),
    { type: "skip", reason: "non-local-workspace" },
  );

  assert.deepEqual(
    resolveManagedAiConfigSyncPreflight({
      workspaceDefaultModelReady: true,
      isDesktopRuntime: true,
      defaultModelExplicit: true,
      workspaceType: "local",
      workspaceRoot: "  C:/work/app  ",
    }),
    { type: "sync", workspaceRoot: "C:/work/app" },
  );
});

test("managed AI config sync waits for provider routing before touching config", () => {
  assert.deepEqual(
    resolveManagedAiConfigWriteDecision({
      managedProfilePresent: true,
      providerRoutingReady: false,
      managedConfigAlreadyCurrent: false,
      shouldPreserveManagedConfig: false,
      defaultModelAlreadyCurrent: false,
    }),
    { type: "skip", reason: "provider-routing-not-ready" },
  );
});

test("managed AI config sync writes, caches, or skips managed config deterministically", () => {
  assert.deepEqual(
    resolveManagedAiConfigWriteDecision({
      managedProfilePresent: true,
      providerRoutingReady: true,
      managedConfigAlreadyCurrent: true,
      shouldPreserveManagedConfig: false,
      defaultModelAlreadyCurrent: false,
    }),
    { type: "skip", reason: "managed-config-current" },
  );

  assert.deepEqual(
    resolveManagedAiConfigWriteDecision({
      managedProfilePresent: true,
      providerRoutingReady: true,
      managedConfigAlreadyCurrent: false,
      shouldPreserveManagedConfig: false,
      defaultModelAlreadyCurrent: false,
    }),
    { type: "write-managed-config" },
  );
});

test("managed AI config sync preserves transient managed config before default model fallback", () => {
  assert.deepEqual(
    resolveManagedAiConfigWriteDecision({
      managedProfilePresent: false,
      providerRoutingReady: false,
      managedConfigAlreadyCurrent: false,
      shouldPreserveManagedConfig: true,
      defaultModelAlreadyCurrent: false,
    }),
    { type: "skip", reason: "preserve-managed-config" },
  );

  assert.deepEqual(
    resolveManagedAiConfigWriteDecision({
      managedProfilePresent: false,
      providerRoutingReady: false,
      managedConfigAlreadyCurrent: false,
      shouldPreserveManagedConfig: false,
      defaultModelAlreadyCurrent: true,
    }),
    { type: "skip", reason: "default-model-current" },
  );

  assert.deepEqual(
    resolveManagedAiConfigWriteDecision({
      managedProfilePresent: false,
      providerRoutingReady: false,
      managedConfigAlreadyCurrent: false,
      shouldPreserveManagedConfig: false,
      defaultModelAlreadyCurrent: false,
    }),
    { type: "write-default-model" },
  );
});
