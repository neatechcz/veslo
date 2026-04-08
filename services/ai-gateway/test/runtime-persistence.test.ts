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
