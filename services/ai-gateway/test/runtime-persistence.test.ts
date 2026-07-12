import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { AiAccessRepository } from "../src/access/repository.js";
import type { AiGatewayDb } from "../src/db/index.js";
import { createApp, createDefaultProxyDependencies, createDefaultRuntimeState, createDefaultUserCredentialDependencies, type RuntimeState } from "../src/index.js";
import { getPlatformCredentialOwnerUserId } from "../src/credentials/platform-owner.js";
import { MySqlCredentialRepository } from "../src/credentials/mysql-repository.js";
import { MySqlSecretStore } from "../src/credentials/mysql-secret-store.js";
import type { CredentialBinding, CredentialRecord, CredentialRepository, MarkCredentialStateInput } from "../src/credentials/repository.js";
import type { SecretStore, StoredSecret } from "../src/credentials/secret-store.js";
import type { UpstreamAuth } from "../src/credentials/token-broker.js";
import { MySqlLeaseRepository } from "../src/leases/mysql-repository.js";
import { MySqlPlatformModelPolicyRepository } from "../src/model-policy/mysql-repository.js";
import type { PlatformModelPolicyRepository } from "../src/model-policy/repository.js";
import * as modelPolicyMysql from "../src/model-policy/mysql-repository.js";
import * as defaultRuntime from "../src/runtime/default-runtime.js";
import type {
  CreateSessionLeaseInput,
  LeaseRepository,
  RebindSessionLeaseInput,
  ResolveLeaseInput,
  SessionLease,
} from "../src/leases/repository.js";
import type { UsageRepository } from "../src/usage/repository.js";

class PersistentSecretStore implements SecretStore {
  private readonly secrets = new Map<string, StoredSecret>();
  private secretCounter = 0;

  async put(secret: StoredSecret): Promise<{ secretRef: string }> {
    const secretRef = `secret_${++this.secretCounter}`;
    this.secrets.set(secretRef, secret);
    return { secretRef };
  }

  async get(secretRef: string): Promise<StoredSecret> {
    const secret = this.secrets.get(secretRef);
    if (!secret) {
      throw new Error(`secret_not_found:${secretRef}`);
    }
    return secret;
  }

  async replace(secretRef: string, secret: StoredSecret): Promise<void> {
    if (!this.secrets.has(secretRef)) {
      throw new Error(`secret_not_found:${secretRef}`);
    }

    this.secrets.set(secretRef, secret);
  }
}

class PersistentCredentialRepository implements CredentialRepository {
  private readonly records = new Map<string, CredentialRecord>();
  private readonly bindings = new Map<string, CredentialBinding>();
  private recordCounter = 0;
  private bindingCounter = 0;

  async getCredentialRecordById(credentialRecordId: string): Promise<CredentialRecord | null> {
    return this.records.get(credentialRecordId) ?? null;
  }

  async listHealthyCredentialRecordIds(): Promise<string[]> {
    return Array.from(this.records.values())
      .filter((record) => record.state === "healthy")
      .map((record) => record.id);
  }

  async listEligibleBindings(input: {
    ownerUserId: string;
    provider: string;
    excludeBindingId?: string;
  }): Promise<CredentialBinding[]> {
    return Array.from(this.bindings.values()).filter((binding) => {
      if (binding.ownerUserId !== input.ownerUserId) return false;
      if (binding.provider !== input.provider) return false;
      if (input.excludeBindingId && binding.id === input.excludeBindingId) return false;

      const record = this.records.get(binding.credentialRecordId);
      return record?.state === "healthy";
    });
  }

  async listActiveLeasesByCredential(_credentialIds: string[]): Promise<Array<{ credentialId: string; activeLeases: number }>> {
    return [];
  }

  async getCredentialRecordByBindingId(bindingId: string): Promise<CredentialRecord | null> {
    const binding = this.bindings.get(bindingId);
    return binding ? this.records.get(binding.credentialRecordId) ?? null : null;
  }

  async createUserCredential(input: {
    ownerUserId: string;
    provider: string;
    credentialType: "api_key" | "oauth";
    secretRef: string;
  }): Promise<CredentialRecord> {
    const createdAt = new Date(`2026-04-03T12:0${this.recordCounter}:00.000Z`);
    const record: CredentialRecord = {
      id: `cred_${++this.recordCounter}`,
      ownerUserId: input.ownerUserId,
      provider: input.provider,
      credentialType: input.credentialType,
      state: "healthy",
      secretRef: input.secretRef,
      createdAt,
      updatedAt: createdAt,
      lastFailureAt: null,
    };
    const binding: CredentialBinding = {
      id: `binding_${++this.bindingCounter}`,
      ownerUserId: input.ownerUserId,
      provider: input.provider,
      credentialRecordId: record.id,
      createdAt,
      updatedAt: createdAt,
    };

    this.records.set(record.id, record);
    this.bindings.set(binding.id, binding);
    return record;
  }

  async listUserCredentials(input: {
    ownerUserId: string;
    provider: string;
  }): Promise<CredentialRecord[]> {
    return Array.from(this.records.values()).filter((record) => {
      return record.ownerUserId === input.ownerUserId && record.provider === input.provider;
    });
  }

  async revokeUserCredential(input: {
    ownerUserId: string;
    provider: string;
    credentialId: string;
  }): Promise<CredentialRecord | null> {
    const record = this.records.get(input.credentialId);
    if (!record || record.ownerUserId !== input.ownerUserId || record.provider !== input.provider) {
      return null;
    }

    const revoked: CredentialRecord = {
      ...record,
      state: "revoked",
      updatedAt: new Date("2026-04-03T13:00:00.000Z"),
    };

    this.records.set(revoked.id, revoked);
    return revoked;
  }

  async markCredentialState(input: MarkCredentialStateInput): Promise<void> {
    const record = this.records.get(input.credentialRecordId);
    if (!record) {
      return;
    }

    this.records.set(record.id, {
      ...record,
      state: input.state,
      updatedAt: new Date("2026-04-03T13:30:00.000Z"),
      lastFailureAt: input.state === "healthy" ? null : new Date("2026-04-03T13:30:00.000Z"),
    });
  }
}

class PersistentLeaseRepository implements LeaseRepository {
  private readonly leasesByKey = new Map<string, SessionLease>();
  private leaseCounter = 0;

  public createCalls = 0;

  async getActiveLease(input: ResolveLeaseInput): Promise<SessionLease | null> {
    return this.leasesByKey.get(leaseKey(input)) ?? null;
  }

  async createLeaseIfMissing(input: CreateSessionLeaseInput): Promise<SessionLease> {
    const key = leaseKey(input);
    const existing = this.leasesByKey.get(key);
    if (existing) {
      return existing;
    }

    this.createCalls += 1;
    const lease: SessionLease = {
      id: `lease_${++this.leaseCounter}`,
      ownerUserId: input.ownerUserId,
      provider: input.provider,
      sessionId: input.sessionId,
      activeBindingId: input.activeBindingId,
    };

    this.leasesByKey.set(key, lease);
    return lease;
  }

  async rebindLease(input: RebindSessionLeaseInput): Promise<SessionLease | null> {
    const key = leaseKey(input);
    const existing = this.leasesByKey.get(key);
    if (!existing || existing.activeBindingId !== input.expectedCurrentBindingId) {
      return null;
    }

    const rebound: SessionLease = {
      ...existing,
      activeBindingId: input.nextBindingId,
    };

    this.leasesByKey.set(key, rebound);
    return rebound;
  }
}

function leaseKey(input: ResolveLeaseInput): string {
  return `${input.ownerUserId}:${input.provider}:${input.sessionId}`;
}

function createPersistentRuntime() {
  return {
    db: {} as AiGatewayDb,
    aiAccess: {
      async getUserAiAccess(userId: string) {
        return {
          id: `ai_access_${userId}`,
          userId,
          enabled: true,
          provider: "anthropic",
          defaultModel: "claude-runtime",
          allowedModels: ["claude-runtime"],
          createdAt: new Date("2026-04-03T11:30:00.000Z"),
          updatedAt: new Date("2026-04-03T11:35:00.000Z"),
        };
      },
      async upsertUserAiAccess() {
        throw new Error("unused");
      },
    } satisfies AiAccessRepository,
    credentials: new PersistentCredentialRepository(),
    secrets: new PersistentSecretStore(),
    leases: new PersistentLeaseRepository(),
    modelPolicy: {
      async getPolicy() {
        return null;
      },
      async replacePolicy() {
        throw new Error("unused");
      },
    } satisfies PlatformModelPolicyRepository,
    modelPolicyMutation: {
      async replacePolicyWithAudit() {
        throw new Error("unused");
      },
    },
    usage: {
      async recordUsage() {},
    } satisfies UsageRepository,
  } satisfies RuntimeState;
}

function createRuntimeBackedApp(input: {
  runtime: RuntimeState;
  transportCalls: Array<{ upstreamAuth: UpstreamAuth; body: unknown }>;
}) {
  return createApp({
    userCredentials: createDefaultUserCredentialDependencies(input.runtime, {
      sessionResolver: {
        async resolveSession(token: string) {
          assert.equal(token, "user-access-token");
          return {
            token,
            user: {
              id: "user_runtime",
              email: "runtime@example.test",
            },
          };
        },
      },
    }),
    proxy: createDefaultProxyDependencies(input.runtime, {
      gatewaySessions: {
        async resolveSession(token: string) {
          assert.equal(token, "gateway-access-token");
          return {
            token,
            user: {
              id: "user_runtime",
              email: "runtime@example.test",
            },
          };
        },
      },
      openAiTransport: {
        async chatCompletions() {
          assert.fail("openai transport should not be used");
        },
      },
      anthropicTransport: {
        async messages(request: { upstreamAuth: UpstreamAuth; body: unknown }) {
          input.transportCalls.push(request);
          return {
            status: 200,
            headers: {
              "x-upstream-request-id": "anthropic_req_runtime",
            },
            body: {
              id: "msg_runtime",
              type: "message",
              model: "claude-runtime",
            },
          };
        },
      },
    }),
  });
}

test("createDefaultRuntimeState uses MySQL-backed runtime stores", () => {
  const runtime = createDefaultRuntimeState({
    db: {} as AiGatewayDb,
    secretKey: "test_secret_key_32_bytes_minimum____",
  });

  assert.ok(runtime.credentials instanceof MySqlCredentialRepository);
  assert.ok(runtime.secrets instanceof MySqlSecretStore);
  assert.ok(runtime.leases instanceof MySqlLeaseRepository);
  assert.ok(runtime.modelPolicy instanceof MySqlPlatformModelPolicyRepository);
  const MutationConstructor = (modelPolicyMysql as unknown as {
    MySqlPlatformModelPolicyMutation?: new (...args: never[]) => unknown;
  }).MySqlPlatformModelPolicyMutation;
  assert.equal(typeof MutationConstructor, "function");
  assert.ok(runtime.modelPolicyMutation instanceof MutationConstructor!);
});

test("default admin dependencies reuse the shared runtime model policy stores", () => {
  const runtime = createPersistentRuntime();
  const createDependencies = (defaultRuntime as unknown as {
    createDefaultAdminDependencies?: (state: RuntimeState) => {
      modelPolicyRepository: unknown;
      modelPolicyMutation: unknown;
      credentialWriteRepository: unknown;
      credentialSecretLookupRepository: unknown;
      aiAccessRepository: unknown;
      alertRepository: unknown;
      usageRepository: unknown;
      auditRepository: unknown;
      secretStore: unknown;
    };
  }).createDefaultAdminDependencies;

  assert.equal(typeof createDependencies, "function");
  const dependencies = createDependencies!(runtime);
  assert.equal(dependencies.modelPolicyRepository, runtime.modelPolicy);
  assert.equal(dependencies.modelPolicyMutation, runtime.modelPolicyMutation);
  assert.equal(dependencies.credentialWriteRepository, runtime.credentials);
  assert.equal(dependencies.credentialSecretLookupRepository, runtime.credentials);
  assert.equal(dependencies.aiAccessRepository, runtime.aiAccess);
  assert.equal(dependencies.alertRepository, runtime.alerts);
  assert.equal(dependencies.usageRepository, runtime.usage);
  assert.equal(dependencies.auditRepository, runtime.audit);
  assert.equal(dependencies.secretStore, runtime.secrets);
});

test("createApp model policy PUT uses runtime mutation dependencies without a secondary database", async () => {
  const baseRuntime = createPersistentRuntime();
  const mutationCalls: unknown[] = [];
  const runtime: RuntimeState = {
    ...baseRuntime,
    modelPolicyMutation: {
      async replacePolicyWithAudit(input) {
        mutationCalls.push(input);
        return {
          id: "platform",
          enabledModels: input.enabledModels,
          activeModel: input.activeModel,
          createdAt: new Date("2026-07-12T00:00:00.000Z"),
          updatedAt: new Date("2026-07-12T00:00:00.000Z"),
        };
      },
    },
  };
  const app = createApp({
    runtime,
    adminDependencies: {
      denClient: {
        async getSession() {
          return {
            user: {
              id: "user_runtime_admin",
              email: "runtime-admin@example.test",
              emailVerified: true,
              name: "Runtime Admin",
            },
            platformAdmin: true,
            activeOrgId: null,
            organizations: [],
          };
        },
      },
      credentialReadRepository: {
        async listAdminCredentials() {
          return [{
            id: "cred_runtime_codex",
            name: "Runtime Codex",
            provider: "codex_oauth",
            type: "oauth",
            state: "healthy",
            scope: "platform",
            activeLeases: 0,
            alertCount: 0,
            lastRefreshAt: "2026-07-12T00:00:00.000Z",
            lastFailureAt: null,
            cachedTokens: 0,
            totalTokens: 0,
            nextRotationAt: null,
            linkedAlertIds: [],
          }];
        },
      },
      codexStatusProvider: {
        async getStatus() {
          return {
            available: true,
            source: "codex_status",
            label: "Available",
          };
        },
      },
    },
  } as never);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/ai-infrastructure/model-policy`, {
      method: "PUT",
      headers: {
        authorization: "Bearer admin-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        enabledModels: [{ provider: "codex_oauth", model: "gpt-5.5" }],
        activeModel: { provider: "codex_oauth", model: "gpt-5.5" },
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(mutationCalls.length, 1);
    assert.deepEqual(mutationCalls[0], {
      actorUserId: "user_runtime_admin",
      enabledModels: [{ provider: "codex_oauth", model: "gpt-5.5" }],
      activeModel: { provider: "codex_oauth", model: "gpt-5.5" },
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("default runtime credential repository exposes admin credential listing for Codex rotation", () => {
  const runtime = createDefaultRuntimeState({
    db: {} as AiGatewayDb,
    secretKey: "test_secret_key_32_bytes_minimum____",
  });

  assert.equal(typeof runtime.credentials.listAdminCredentials, "function");
});

test("default proxy dependencies wire hosted provider transports to global fetch", async () => {
  const runtime = createPersistentRuntime();
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    return new Response(JSON.stringify({ id: `provider_${fetchCalls.length}`, ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": `provider_req_${fetchCalls.length}`,
      },
    });
  }) as typeof fetch;

  try {
    const proxy = createDefaultProxyDependencies(runtime, {
      gatewaySessions: {
        async resolveSession() {
          throw new Error("gateway_session_not_used");
        },
      },
    });

    await proxy.openAiTransport.chatCompletions({
      upstreamAuth: { kind: "api-key", value: "sk-openai-runtime" },
      body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hello" }] },
    });
    await proxy.anthropicTransport.messages({
      upstreamAuth: { kind: "api-key", value: "sk-ant-runtime" },
      body: { model: "claude-3-7-sonnet-latest", max_tokens: 64, messages: [{ role: "user", content: "hello" }] },
    });

    assert.equal(fetchCalls.length, 2);
    assert.equal(fetchCalls[0]?.url, "https://api.openai.com/v1/chat/completions");
    assert.equal(fetchCalls[0]?.init?.method, "POST");
    assert.equal((fetchCalls[0]?.init?.headers as Record<string, string>)?.authorization, "Bearer sk-openai-runtime");
    assert.equal(fetchCalls[1]?.url, "https://api.anthropic.com/v1/messages");
    assert.equal(fetchCalls[1]?.init?.method, "POST");
    assert.equal((fetchCalls[1]?.init?.headers as Record<string, string>)?.["x-api-key"], "sk-ant-runtime");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("default proxy dependencies inject Codex status provider into binding selection", async () => {
  const runtime = createPersistentRuntime();
  const storedSecret = await runtime.secrets.put({
    kind: "api_key",
    apiKey: "not-codex-auth-json",
  });
  await runtime.credentials.createUserCredential?.({
    ownerUserId: getPlatformCredentialOwnerUserId("codex_oauth"),
    provider: "codex_oauth",
    credentialType: "oauth",
    secretRef: storedSecret.secretRef,
  });
  const proxy = createDefaultProxyDependencies(runtime, {
    gatewaySessions: {
      async resolveSession() {
        throw new Error("gateway_session_not_used");
      },
    },
    now: () => new Date("2026-04-30T10:00:00.000Z"),
  });

  await assert.rejects(
    proxy.leaseBroker.getOrCreateActiveLease({
      ownerUserId: "user_runtime",
      bindingOwnerUserId: getPlatformCredentialOwnerUserId("codex_oauth"),
      provider: "codex_oauth",
      sessionId: "session_codex_runtime_status",
    }),
    /no_eligible_codex_credentials:all_codex_credentials_exhausted/,
  );
});

test("runtime-backed dependencies keep platform credentials and leases across app re-instantiation", async () => {
  const runtime = createPersistentRuntime();
  let persistedBindingId = "";
  const firstTransportCalls: Array<{ upstreamAuth: UpstreamAuth; body: unknown }> = [];
  const firstApp = createRuntimeBackedApp({
    runtime,
    transportCalls: firstTransportCalls,
  });
  const firstServer = firstApp.listen(0, "127.0.0.1");
  await once(firstServer, "listening");

  try {
    const { port } = firstServer.address() as AddressInfo;
    const storedSecret = await runtime.secrets.put({
      kind: "api_key",
      apiKey: "sk-ant-runtime",
    });
    const createdCredential = await runtime.credentials.createUserCredential?.({
      ownerUserId: getPlatformCredentialOwnerUserId("anthropic"),
      provider: "anthropic",
      credentialType: "api_key",
      secretRef: storedSecret.secretRef,
    });

    assert.ok(createdCredential);

    const bindings = await runtime.credentials.listEligibleBindings?.({
      ownerUserId: getPlatformCredentialOwnerUserId("anthropic"),
      provider: "anthropic",
    });

    assert.equal(bindings?.length, 1);
    persistedBindingId = bindings?.[0]?.id ?? "";

    const firstProxy = await fetch(`http://127.0.0.1:${port}/providers/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-access-token",
        "content-type": "application/json",
        "x-veslo-session-id": "session_runtime_1",
      },
      body: JSON.stringify({
        model: "claude-runtime",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(firstProxy.status, 200);
    assert.deepEqual(firstTransportCalls, [
      {
        upstreamAuth: {
          kind: "api-key",
          value: "sk-ant-runtime",
        },
        body: {
          model: "claude-runtime",
          messages: [{ role: "user", content: "hello" }],
        },
      },
    ]);
  } finally {
    firstServer.close();
    await once(firstServer, "close");
  }

  const secondTransportCalls: Array<{ upstreamAuth: UpstreamAuth; body: unknown }> = [];
  const secondApp = createRuntimeBackedApp({
    runtime,
    transportCalls: secondTransportCalls,
  });
  const secondServer = secondApp.listen(0, "127.0.0.1");
  await once(secondServer, "listening");

  try {
    const { port } = secondServer.address() as AddressInfo;
    const secondProxy = await fetch(`http://127.0.0.1:${port}/providers/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-access-token",
        "content-type": "application/json",
        "x-veslo-session-id": "session_runtime_1",
      },
      body: JSON.stringify({
        model: "claude-runtime",
        messages: [{ role: "user", content: "hello again" }],
      }),
    });

    assert.equal(secondProxy.status, 200);
    assert.deepEqual(secondTransportCalls, [
      {
        upstreamAuth: {
          kind: "api-key",
          value: "sk-ant-runtime",
        },
        body: {
          model: "claude-runtime",
          messages: [{ role: "user", content: "hello again" }],
        },
      },
    ]);

    assert.equal(runtime.leases.createCalls, 1);
    assert.equal(
      (await runtime.leases.getActiveLease({
        ownerUserId: "user_runtime",
        provider: "anthropic",
        sessionId: "session_runtime_1",
      }))?.activeBindingId,
      persistedBindingId,
    );
  } finally {
    secondServer.close();
    await once(secondServer, "close");
  }
});
