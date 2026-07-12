import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultProxyDependencies,
  createDefaultReadinessDependencies,
  createDefaultRuntimeState,
} from "../src/index.js";
import { checkReadiness } from "../src/http/readiness.js";
import { createPlatformModelCapabilityVerifier } from "../src/model-policy/capability-verifier.js";

function createReadyDependencies() {
  return {
    fetchImpl: async () => new Response(null, { status: 200 }),
    probes: [{ provider: "openai", url: "https://openai.example.test/models" }],
    credentials: {
      async listHealthyCredentialRecordIds() {
        return ["cred_ready_1"];
      },
    },
    aiAccess: {
      async countEnabledPolicies() {
        return 2;
      },
    },
    modelCapabilities: {
      async checkHealthyCredentialForModel() {
        return { status: "supported" as const, credentialId: "cred_ready_1" };
      },
      async hasHealthyCredentialForModel() {
        return true;
      },
      invalidateCredential() {},
    },
    now: () => new Date("2026-07-12T10:00:00.000Z"),
  };
}

test("readiness rejects credentials that cannot serve the active model", async () => {
  const payload = await checkReadiness({
    ...createReadyDependencies(),
    modelPolicy: {
      async getPolicy() {
        return {
          id: "platform" as const,
          enabledModels: [{ provider: "anthropic" as const, model: "claude-sonnet-4" }],
          activeModel: { provider: "anthropic" as const, model: "claude-sonnet-4" },
          createdAt: new Date("2026-07-12T09:00:00.000Z"),
          updatedAt: new Date("2026-07-12T09:00:00.000Z"),
        };
      },
    },
    modelCapabilities: createPlatformModelCapabilityVerifier({
      credentials: {
        async listAdminCredentials() {
          return [{
            id: "cred_openai_only",
            name: "OpenAI only",
            provider: "openai",
            type: "oauth",
            state: "healthy",
            scope: "platform",
            activeLeases: 0,
            alertCount: 0,
            lastRefreshAt: "2026-07-12T09:00:00.000Z",
            lastFailureAt: null,
            cachedTokens: 0,
            totalTokens: 0,
            nextRotationAt: null,
            linkedAlertIds: [],
          }];
        },
      } as never,
      secrets: {} as never,
      codexStatusProvider: {} as never,
      openAiCompatibleTransport: {} as never,
    }),
  });

  assert.equal(payload.ok, false);
  assert.deepEqual(payload.checks.credentials, {
    ok: false,
    healthyCredentialCount: 1,
    reason: "no_healthy_credential_for_active_model",
  });
});

test("readiness keeps capability lookup failures behind the stable compatibility reason", async () => {
  const payload = await checkReadiness({
    ...createReadyDependencies(),
    modelPolicy: {
      async getPolicy() {
        return {
          id: "platform" as const,
          enabledModels: [{ provider: "openai_compatible" as const, model: "private-model" }],
          activeModel: { provider: "openai_compatible" as const, model: "private-model" },
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
    },
    modelCapabilities: {
      async checkHealthyCredentialForModel() {
        throw new Error("upstream included secret material");
      },
    } as never,
  });

  assert.deepEqual(payload.checks.credentials, {
    ok: false,
    healthyCredentialCount: 1,
    reason: "no_healthy_credential_for_active_model",
  });
});

test("readiness reports a missing platform model policy separately", async () => {
  const payload = await checkReadiness({
    ...createReadyDependencies(),
    modelPolicy: {
      async getPolicy() {
        return null;
      },
    },
  });

  assert.equal(payload.ok, false);
  assert.equal(payload.status, "not_ready");
  assert.deepEqual(payload.checks.modelPolicy, {
    ok: false,
    activeModel: null,
    reason: "platform_model_policy_not_configured",
  });
  assert.equal(payload.checks.providerReachability.ok, true);
  assert.equal(payload.checks.credentials.ok, true);
  assert.equal(payload.checks.aiAccessPolicies.ok, true);
});

test("readiness reports the configured active model", async () => {
  const payload = await checkReadiness({
    ...createReadyDependencies(),
    modelPolicy: {
      async getPolicy() {
        return {
          id: "platform" as const,
          enabledModels: [{ provider: "openai" as const, model: "gpt-5.4" }],
          activeModel: { provider: "openai" as const, model: "gpt-5.4" },
          createdAt: new Date("2026-07-12T09:00:00.000Z"),
          updatedAt: new Date("2026-07-12T09:00:00.000Z"),
        };
      },
    },
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.status, "ready");
  assert.deepEqual(payload.checks.modelPolicy, {
    ok: true,
    activeModel: { provider: "openai", model: "gpt-5.4" },
  });
});

test("default runtime dependencies share the platform model policy repository", () => {
  const runtime = createDefaultRuntimeState({
    db: {} as never,
    secretKey: "test_secret_key_32_bytes_minimum____",
  });

  const proxy = createDefaultProxyDependencies(runtime, {
    gatewaySessions: {
      async resolveSession() {
        return null;
      },
    },
  });
  const readiness = createDefaultReadinessDependencies(runtime);

  assert.equal(proxy.modelPolicy, runtime.modelPolicy);
  assert.equal(readiness.modelPolicy, runtime.modelPolicy);
});
