import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { AuditRepository, RecordAuditEventInput } from "../src/audit/repository.js";
import type { AdminCredentialRecord } from "../src/credentials/repository.js";
import type { StoredSecret } from "../src/credentials/secret-store.js";
import { createDefaultAdminService, type AdminSessionSnapshot } from "../src/http/admin.js";
import { createApp } from "../src/index.js";
import type {
  PlatformModelPolicyRecord,
  PlatformModelPolicyRepository,
  PlatformModelRef,
} from "../src/model-policy/repository.js";
import type { CodexUsageStatus } from "../src/usage/codex-status.js";
import * as modelPolicyMysql from "../src/model-policy/mysql-repository.js";
import { ProviderTransportError } from "../src/providers/transport.js";

const ADMIN_COOKIE = "veslo.ai-gateway.admin.token=admin-token";
const NOW = new Date("2026-07-12T00:00:00.000Z");

function platformAdminSession(): AdminSessionSnapshot {
  return {
    user: {
      id: "user_platform_admin",
      email: "platform-admin@example.test",
      emailVerified: true,
      name: "Platform Admin",
    },
    platformAdmin: true,
    activeOrgId: null,
    organizations: [],
  };
}

function policyRecord(input: {
  enabledModels: PlatformModelRef[];
  activeModel: PlatformModelRef;
  updatedAt?: Date;
}): PlatformModelPolicyRecord {
  return {
    id: "platform",
    enabledModels: input.enabledModels,
    activeModel: input.activeModel,
    createdAt: new Date("2026-07-11T00:00:00.000Z"),
    updatedAt: input.updatedAt ?? NOW,
  };
}

class MemoryModelPolicyRepository implements PlatformModelPolicyRepository {
  replaceCalls: Array<{ enabledModels: PlatformModelRef[]; activeModel: PlatformModelRef }> = [];
  failRead = false;
  failReplace = false;

  constructor(public current: PlatformModelPolicyRecord | null = null) {}

  async getPolicy() {
    if (this.failRead) throw new Error("model_policy_store_down");
    return this.current;
  }

  async replacePolicy(input: { enabledModels: PlatformModelRef[]; activeModel: PlatformModelRef }) {
    this.replaceCalls.push(input);
    if (this.failReplace) throw new Error("model_policy_write_down");
    this.current = policyRecord({ ...input, updatedAt: NOW });
    return this.current;
  }
}

function credential(input: {
  id: string;
  provider: string;
  state?: AdminCredentialRecord["state"];
}): AdminCredentialRecord {
  return {
    id: input.id,
    name: input.id,
    provider: input.provider,
    type: input.provider === "codex_oauth" ? "oauth" : "api_key",
    state: input.state ?? "healthy",
    scope: "platform",
    activeLeases: 0,
    alertCount: 0,
    lastRefreshAt: NOW.toISOString(),
    lastFailureAt: null,
    cachedTokens: 0,
    totalTokens: 0,
    nextRotationAt: null,
    linkedAlertIds: [],
    deletedAt: null,
  };
}

function createHarness(input: {
  policy?: PlatformModelPolicyRecord | null;
  credentials?: AdminCredentialRecord[];
  codexStatus?: CodexUsageStatus;
  openAiCompatibleModels?: string[];
  secret?: StoredSecret;
  failAudit?: boolean;
  secretLookupError?: Error;
  modelDiscoveryError?: Error;
} = {}) {
  const modelPolicy = new MemoryModelPolicyRepository(input.policy ?? null);
  const auditEvents: RecordAuditEventInput[] = [];
  const auditAttempts: RecordAuditEventInput[] = [];
  const credentials = input.credentials ?? [credential({ id: "cred_codex", provider: "codex_oauth" })];
  const mutationCalls: Array<{
    actorUserId: string;
    enabledModels: PlatformModelRef[];
    activeModel: PlatformModelRef;
  }> = [];
  let modelDiscoveryCalls = 0;
  const auditRepository: AuditRepository = {
    async recordEvent(event) {
      auditAttempts.push(event);
      if (input.failAudit) {
        throw new Error("model_policy_audit_store_down");
      }
      auditEvents.push(event);
    },
  };
  const service = createDefaultAdminService("https://den.example.test", {
    denClient: {
      async getSession() {
        return platformAdminSession();
      },
    } as never,
    modelPolicyRepository: modelPolicy,
    credentialReadRepository: {
      async listAdminCredentials() {
        return credentials;
      },
    },
    credentialSecretLookupRepository: {
      async getCredentialRecordById(credentialId: string) {
        if (input.secretLookupError) throw input.secretLookupError;
        const match = credentials.find((entry) => entry.id === credentialId);
        return match
          ? { provider: match.provider, secretRef: `secret_${credentialId}`, name: match.name }
          : null;
      },
    },
    codexStatusProvider: {
      async getStatus() {
        return input.codexStatus ?? {
          available: true,
          source: "codex_status",
          label: "Codex available",
          checkedAt: NOW.toISOString(),
        };
      },
    },
    secretStore: {
      async put() {
        throw new Error("unused");
      },
      async get() {
        return input.secret ?? {
          kind: "openai_compatible_api_key",
          apiKey: "test-key",
          baseUrl: "https://models.example.test/v1",
        };
      },
      async replace() {
        throw new Error("unused");
      },
    },
    openAiCompatibleTransport: {
      async chatCompletions() {
        throw new Error("unused");
      },
      async listModels() {
        modelDiscoveryCalls += 1;
        if (input.modelDiscoveryError) throw input.modelDiscoveryError;
        return { models: input.openAiCompatibleModels ?? ["custom/model-v1"] };
      },
    },
    modelPolicyMutation: {
      async replacePolicyWithAudit(mutationInput: {
        actorUserId: string;
        enabledModels: PlatformModelRef[];
        activeModel: PlatformModelRef;
      }) {
        mutationCalls.push(mutationInput);
        const previous = modelPolicy.current;
        const saved = policyRecord({
          enabledModels: mutationInput.enabledModels,
          activeModel: mutationInput.activeModel,
        });
        const summaryFormatter = (modelPolicyMysql as unknown as {
          formatPlatformModelPolicyAuditSummary?: (
            before: PlatformModelPolicyRecord | null,
            after: PlatformModelPolicyRecord,
          ) => string;
        }).formatPlatformModelPolicyAuditSummary;
        const event = {
          actorUserId: mutationInput.actorUserId,
          action: "platform.model_policy.update",
          entityType: "platform_model_policy",
          entityId: "platform",
          result: "ok" as const,
          summary: summaryFormatter
            ? summaryFormatter(previous, saved)
            : "model policy summary unavailable",
        };
        auditAttempts.push(event);
        if (modelPolicy.failReplace) throw new Error("model_policy_write_down");
        if (input.failAudit) {
          throw Object.assign(new Error("model_policy_audit_store_down"), {
            code: "model_policy_audit_failed",
          });
        }
        modelPolicy.current = saved;
        auditEvents.push(event);
        return saved;
      },
    },
    auditRepository,
    now: () => NOW,
  });

  return {
    service,
    modelPolicy,
    auditEvents,
    auditAttempts,
    mutationCalls,
    get modelDiscoveryCalls() {
      return modelDiscoveryCalls;
    },
  };
}

test("model policy audit summary deterministically preserves active and enabled before/after refs", () => {
  const formatSummary = (modelPolicyMysql as unknown as {
    formatPlatformModelPolicyAuditSummary?: (
      before: PlatformModelPolicyRecord | null,
      after: PlatformModelPolicyRecord,
    ) => string;
  }).formatPlatformModelPolicyAuditSummary;
  assert.equal(typeof formatSummary, "function");

  const before = policyRecord({
    enabledModels: [
      { provider: "codex_oauth", model: "gpt-5.4" },
      { provider: "openai_compatible", model: "custom/model-v2" },
    ],
    activeModel: { provider: "codex_oauth", model: "gpt-5.4" },
  });
  const after = policyRecord({
    enabledModels: [
      { provider: "openai_compatible", model: "custom/model-v1" },
      { provider: "codex_oauth", model: "gpt-5.5" },
    ],
    activeModel: { provider: "codex_oauth", model: "gpt-5.5" },
  });
  assert.equal(
    formatSummary!(before, after),
    "Updated platform model policy: active codex_oauth/gpt-5.4 -> codex_oauth/gpt-5.5; enabled [codex_oauth/gpt-5.4, openai_compatible/custom/model-v2] -> [codex_oauth/gpt-5.5, openai_compatible/custom/model-v1].",
  );
});

test("getPlatformModelPolicy returns null or the current serialized policy", async () => {
  const empty = createHarness({ policy: null });
  assert.deepEqual(await empty.service.getPlatformModelPolicy("admin-token"), { policy: null });

  const current = policyRecord({
    enabledModels: [
      { provider: "codex_oauth", model: "gpt-5.5" },
      { provider: "codex_oauth", model: "gpt-5.4" },
    ],
    activeModel: { provider: "codex_oauth", model: "gpt-5.5" },
  });
  const configured = createHarness({ policy: current });
  assert.deepEqual(await configured.service.getPlatformModelPolicy("admin-token"), {
    policy: {
      enabledModels: current.enabledModels,
      activeModel: current.activeModel,
      updatedAt: NOW.toISOString(),
    },
  });
});

test("replacePlatformModelPolicy normalizes duplicates and writes the global audit event", async () => {
  const previous = policyRecord({
    enabledModels: [{ provider: "codex_oauth", model: "gpt-5.4" }],
    activeModel: { provider: "codex_oauth", model: "gpt-5.4" },
  });
  const { service, auditEvents, mutationCalls } = createHarness({ policy: previous });

  const response = await service.replacePlatformModelPolicy("admin-token", {
    enabledModels: [
      { provider: "codex_oauth", model: " gpt-5.5 " },
      { provider: "codex_oauth", model: "gpt-5.5" },
      { provider: "codex_oauth", model: "gpt-5.4" },
    ],
    activeModel: { provider: "codex_oauth", model: " gpt-5.5 " },
  }, "user_platform_admin");

  const expectedPolicy = {
    enabledModels: [
      { provider: "codex_oauth", model: "gpt-5.5" },
      { provider: "codex_oauth", model: "gpt-5.4" },
    ],
    activeModel: { provider: "codex_oauth", model: "gpt-5.5" },
    updatedAt: NOW.toISOString(),
  };
  assert.deepEqual(response, { policy: expectedPolicy });
  assert.deepEqual(auditEvents, [{
    actorUserId: "user_platform_admin",
    action: "platform.model_policy.update",
    entityType: "platform_model_policy",
    entityId: "platform",
    result: "ok",
    summary: "Updated platform model policy: active codex_oauth/gpt-5.4 -> codex_oauth/gpt-5.5; enabled [codex_oauth/gpt-5.4] -> [codex_oauth/gpt-5.4, codex_oauth/gpt-5.5].",
  }]);
  assert.deepEqual(mutationCalls, [{
    actorUserId: "user_platform_admin",
    enabledModels: expectedPolicy.enabledModels,
    activeModel: expectedPolicy.activeModel,
  }]);
  assert.doesNotMatch(JSON.stringify(auditEvents), /test-key|secret_/);
});

test("replacePlatformModelPolicy rejects empty enabled models before persistence", async () => {
  const previous = policyRecord({
    enabledModels: [{ provider: "codex_oauth", model: "gpt-5.4" }],
    activeModel: { provider: "codex_oauth", model: "gpt-5.4" },
  });
  const { service, modelPolicy, auditEvents } = createHarness({ policy: previous });

  await assert.rejects(
    service.replacePlatformModelPolicy("admin-token", {
      enabledModels: [],
      activeModel: { provider: "codex_oauth", model: "gpt-5.5" },
    }, "user_platform_admin"),
    (error: unknown) => (error as { message?: string; status?: number }).message === "model_policy_enabled_models_required"
      && (error as { status?: number }).status === 400,
  );
  assert.equal(modelPolicy.current, previous);
  assert.equal(modelPolicy.replaceCalls.length, 0);
  assert.deepEqual(auditEvents, []);
});

test("replacePlatformModelPolicy requires the active model to be enabled", async () => {
  const previous = policyRecord({
    enabledModels: [{ provider: "codex_oauth", model: "gpt-5.4" }],
    activeModel: { provider: "codex_oauth", model: "gpt-5.4" },
  });
  const { service, modelPolicy, auditEvents } = createHarness({ policy: previous });

  await assert.rejects(
    service.replacePlatformModelPolicy("admin-token", {
      enabledModels: [{ provider: "codex_oauth", model: "gpt-5.4" }],
      activeModel: { provider: "codex_oauth", model: "gpt-5.5" },
    }, "user_platform_admin"),
    (error: unknown) => (error as { message?: string; status?: number }).message === "model_policy_active_model_not_enabled"
      && (error as { status?: number }).status === 400,
  );
  assert.equal(modelPolicy.current, previous);
  assert.equal(modelPolicy.replaceCalls.length, 0);
  assert.deepEqual(auditEvents, []);
});

test("activation requires a healthy credential and positive Codex capability evidence", async () => {
  const unhealthy = createHarness({
    credentials: [credential({ id: "cred_codex", provider: "codex_oauth", state: "unhealthy" })],
  });
  await assert.rejects(
    unhealthy.service.replacePlatformModelPolicy("admin-token", {
      enabledModels: [{ provider: "codex_oauth", model: "gpt-5.5" }],
      activeModel: { provider: "codex_oauth", model: "gpt-5.5" },
    }, "user_platform_admin"),
    (error: unknown) => (error as { message?: string; status?: number }).message === "model_policy_active_model_has_no_healthy_credential"
      && (error as { status?: number }).status === 422,
  );

  const unavailable = createHarness({
    codexStatus: {
      available: false,
      source: "unavailable",
      label: "Unavailable",
      checkedAt: NOW.toISOString(),
    },
  });
  await assert.rejects(
    unavailable.service.replacePlatformModelPolicy("admin-token", {
      enabledModels: [{ provider: "codex_oauth", model: "gpt-5.5" }],
      activeModel: { provider: "codex_oauth", model: "gpt-5.5" },
    }, "user_platform_admin"),
    (error: unknown) => (error as { message?: string; status?: number }).message === "model_policy_capability_evidence_unavailable"
      && (error as { status?: number }).status === 503,
  );

  assert.equal(unhealthy.modelPolicy.replaceCalls.length, 0);
  assert.equal(unavailable.modelPolicy.replaceCalls.length, 0);
  assert.deepEqual(unhealthy.auditEvents, []);
  assert.deepEqual(unavailable.auditEvents, []);
});

test("every enabled model requires authoritative capability evidence", async () => {
  const unsupportedCodex = createHarness();
  await assert.rejects(
    unsupportedCodex.service.replacePlatformModelPolicy("admin-token", {
      enabledModels: [
        { provider: "codex_oauth", model: "gpt-5.5" },
        { provider: "codex_oauth", model: "invented-model" },
      ],
      activeModel: { provider: "codex_oauth", model: "gpt-5.5" },
    }, "user_platform_admin"),
    (error: unknown) => (error as { message?: string; status?: number }).message === "model_policy_enabled_model_unsupported"
      && (error as { status?: number }).status === 422,
  );
  assert.equal(unsupportedCodex.mutationCalls.length, 0);

  const unverifiableNonActive = createHarness({
    credentials: [
      credential({ id: "cred_codex", provider: "codex_oauth" }),
      credential({ id: "cred_openai", provider: "openai" }),
    ],
  });
  await assert.rejects(
    unverifiableNonActive.service.replacePlatformModelPolicy("admin-token", {
      enabledModels: [
        { provider: "codex_oauth", model: "gpt-5.5" },
        { provider: "openai", model: "client-claimed-model" },
      ],
      activeModel: { provider: "codex_oauth", model: "gpt-5.5" },
    }, "user_platform_admin"),
    (error: unknown) => (error as { message?: string; status?: number }).message === "model_policy_activation_not_verifiable_for_provider"
      && (error as { status?: number }).status === 422,
  );
  assert.equal(unverifiableNonActive.mutationCalls.length, 0);
});

test("OpenAI-compatible activation uses credential model discovery as capability evidence", async () => {
  const supported = createHarness({
    credentials: [credential({ id: "cred_custom", provider: "openai_compatible" })],
    openAiCompatibleModels: ["custom/model-v1"],
  });
  const result = await supported.service.replacePlatformModelPolicy("admin-token", {
    enabledModels: [{ provider: "openai_compatible", model: "custom/model-v1" }],
    activeModel: { provider: "openai_compatible", model: "custom/model-v1" },
  }, "user_platform_admin");
  assert.equal(result.policy?.activeModel.model, "custom/model-v1");

  const unsupported = createHarness({
    credentials: [credential({ id: "cred_custom", provider: "openai_compatible" })],
    openAiCompatibleModels: ["custom/model-v2"],
  });
  await assert.rejects(
    unsupported.service.replacePlatformModelPolicy("admin-token", {
      enabledModels: [{ provider: "openai_compatible", model: "custom/model-v1" }],
      activeModel: { provider: "openai_compatible", model: "custom/model-v1" },
    }, "user_platform_admin"),
    (error: unknown) => (error as { message?: string; status?: number }).message === "model_policy_enabled_model_unsupported"
      && (error as { status?: number }).status === 422,
  );
  assert.equal(unsupported.modelPolicy.replaceCalls.length, 0);
  assert.deepEqual(unsupported.auditEvents, []);
});

test("OpenAI-compatible validation discovers once per credential for multiple enabled models", async () => {
  const harness = createHarness({
    credentials: [credential({ id: "cred_custom", provider: "openai_compatible" })],
    openAiCompatibleModels: ["custom/model-v1", "custom/model-v2"],
  });

  const result = await harness.service.replacePlatformModelPolicy("admin-token", {
    enabledModels: [
      { provider: "openai_compatible", model: "custom/model-v1" },
      { provider: "openai_compatible", model: "custom/model-v2" },
    ],
    activeModel: { provider: "openai_compatible", model: "custom/model-v1" },
  }, "user_platform_admin");

  assert.equal(result.policy.enabledModels.length, 2);
  assert.equal(harness.modelDiscoveryCalls, 1);
});

test("OpenAI-compatible validation preserves transient secret and provider failures", async () => {
  const secretFailure = createHarness({
    credentials: [credential({ id: "cred_custom", provider: "openai_compatible" })],
    secretLookupError: new Error("secret store unavailable"),
  });
  await assert.rejects(
    secretFailure.service.replacePlatformModelPolicy("admin-token", {
      enabledModels: [{ provider: "openai_compatible", model: "custom/model-v1" }],
      activeModel: { provider: "openai_compatible", model: "custom/model-v1" },
    }, "user_platform_admin"),
    (error: unknown) => (error as { message?: string; status?: number }).message === "model_policy_credential_lookup_failed"
      && (error as { status?: number }).status === 503,
  );

  const timeoutFailure = createHarness({
    credentials: [credential({ id: "cred_custom", provider: "openai_compatible" })],
    modelDiscoveryError: new ProviderTransportError("timeout", {
      code: "openai_compatible_models_timeout",
      statusCode: 504,
    }),
  });
  await assert.rejects(
    timeoutFailure.service.replacePlatformModelPolicy("admin-token", {
      enabledModels: [{ provider: "openai_compatible", model: "custom/model-v1" }],
      activeModel: { provider: "openai_compatible", model: "custom/model-v1" },
    }, "user_platform_admin"),
    (error: unknown) => (error as { message?: string; status?: number }).message === "model_policy_model_discovery_timeout"
      && (error as { status?: number }).status === 504,
  );

  const providerFailure = createHarness({
    credentials: [credential({ id: "cred_custom", provider: "openai_compatible" })],
    modelDiscoveryError: new ProviderTransportError("upstream unavailable", {
      code: "openai_compatible_request_failed",
      statusCode: 502,
    }),
  });
  await assert.rejects(
    providerFailure.service.replacePlatformModelPolicy("admin-token", {
      enabledModels: [{ provider: "openai_compatible", model: "custom/model-v1" }],
      activeModel: { provider: "openai_compatible", model: "custom/model-v1" },
    }, "user_platform_admin"),
    (error: unknown) => (error as { message?: string; status?: number }).message === "model_policy_model_discovery_failed"
      && (error as { status?: number }).status === 502,
  );
});

test("raw OpenAI and Anthropic activation is rejected when provider capability cannot be verified", async () => {
  for (const provider of ["openai", "anthropic"] as const) {
    const harness = createHarness({ credentials: [credential({ id: `cred_${provider}`, provider })] });
    await assert.rejects(
      harness.service.replacePlatformModelPolicy("admin-token", {
        enabledModels: [{ provider, model: "claimed-model" }],
        activeModel: { provider, model: "claimed-model" },
      }, "user_platform_admin"),
      (error: unknown) => (error as { message?: string; status?: number }).message === "model_policy_activation_not_verifiable_for_provider"
        && (error as { status?: number }).status === 422,
    );
    assert.equal(harness.modelPolicy.replaceCalls.length, 0);
    assert.deepEqual(harness.auditEvents, []);
  }
});

test("failed model policy replacement preserves the previous policy and records no success audit", async () => {
  const previous = policyRecord({
    enabledModels: [{ provider: "codex_oauth", model: "gpt-5.4" }],
    activeModel: { provider: "codex_oauth", model: "gpt-5.4" },
  });
  const harness = createHarness({ policy: previous });
  harness.modelPolicy.failReplace = true;

  await assert.rejects(
    harness.service.replacePlatformModelPolicy("admin-token", {
      enabledModels: [{ provider: "codex_oauth", model: "gpt-5.5" }],
      activeModel: { provider: "codex_oauth", model: "gpt-5.5" },
    }, "user_platform_admin"),
    /model_policy_write_down/,
  );
  assert.equal(harness.modelPolicy.current, previous);
  assert.deepEqual(harness.auditEvents, []);
});

test("PUT does not report success when required model policy audit persistence fails", async () => {
  const previous = policyRecord({
    enabledModels: [{ provider: "codex_oauth", model: "gpt-5.4" }],
    activeModel: { provider: "codex_oauth", model: "gpt-5.4" },
  });
  const harness = createHarness({ policy: previous, failAudit: true });
  const app = createApp({ admin: harness.service });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${port}/admin/api/ai-infrastructure/model-policy`,
      {
        method: "PUT",
        headers: { cookie: ADMIN_COOKIE, "content-type": "application/json" },
        body: JSON.stringify({
          enabledModels: [{ provider: "codex_oauth", model: "gpt-5.5" }],
          activeModel: { provider: "codex_oauth", model: "gpt-5.5" },
        }),
      },
    );

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "model_policy_audit_failed" });
    assert.deepEqual(harness.auditEvents, []);
    assert.equal(harness.auditAttempts.length, 1);
    assert.equal(harness.modelPolicy.current, previous);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("model policy routes return payloads and stable read/write errors", async () => {
  const harness = createHarness();
  const app = createApp({ admin: harness.service });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}/admin/api/ai-infrastructure/model-policy`;

    const empty = await fetch(baseUrl, { headers: { cookie: ADMIN_COOKIE } });
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { policy: null });

    const saved = await fetch(baseUrl, {
      method: "PUT",
      headers: { cookie: ADMIN_COOKIE, "content-type": "application/json" },
      body: JSON.stringify({
        enabledModels: [{ provider: "codex_oauth", model: "gpt-5.5" }],
        activeModel: { provider: "codex_oauth", model: "gpt-5.5" },
      }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), {
      policy: {
        enabledModels: [{ provider: "codex_oauth", model: "gpt-5.5" }],
        activeModel: { provider: "codex_oauth", model: "gpt-5.5" },
        updatedAt: NOW.toISOString(),
      },
    });
    assert.equal(harness.mutationCalls[0]?.actorUserId, "user_platform_admin");

    harness.modelPolicy.failRead = true;
    const readFailure = await fetch(baseUrl, { headers: { cookie: ADMIN_COOKIE } });
    assert.equal(readFailure.status, 502);
    assert.deepEqual(await readFailure.json(), { error: "model_policy_read_failed" });

    harness.modelPolicy.failRead = false;
    harness.modelPolicy.failReplace = true;
    const writeFailure = await fetch(baseUrl, {
      method: "PUT",
      headers: { cookie: ADMIN_COOKIE, "content-type": "application/json" },
      body: JSON.stringify({
        enabledModels: [{ provider: "codex_oauth", model: "gpt-5.4" }],
        activeModel: { provider: "codex_oauth", model: "gpt-5.4" },
      }),
    });
    assert.equal(writeFailure.status, 502);
    assert.deepEqual(await writeFailure.json(), { error: "model_policy_replace_failed" });
  } finally {
    server.close();
    await once(server, "close");
  }
});
