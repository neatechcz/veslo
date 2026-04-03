import assert from "node:assert/strict";
import test from "node:test";

import { OpenAiOAuthRefreshError } from "../src/credentials/default-token-broker.js";
import { EncryptedSecretStore } from "../src/credentials/encrypted-secret-store.js";
import type {
  CredentialBinding,
  CredentialRecord,
  CredentialRepository,
  MarkCredentialStateInput,
} from "../src/credentials/repository.js";
import { createDefaultProxyDependencies, type RuntimeState } from "../src/index.js";
import type {
  CreateSessionLeaseInput,
  LeaseRepository,
  RebindSessionLeaseInput,
  ResolveLeaseInput,
  SessionLease,
} from "../src/leases/repository.js";
import type { UsageRepository } from "../src/usage/repository.js";

class InMemoryCredentialRepository implements CredentialRepository {
  public readonly markCalls: MarkCredentialStateInput[] = [];

  constructor(
    private readonly recordsByBindingId: Map<string, CredentialRecord>,
    private readonly bindings: CredentialBinding[] = [],
  ) {}

  async getCredentialRecordById(credentialRecordId: string): Promise<CredentialRecord | null> {
    for (const record of this.recordsByBindingId.values()) {
      if (record.id === credentialRecordId) {
        return record;
      }
    }

    return null;
  }

  async listHealthyCredentialRecordIds(): Promise<string[]> {
    return Array.from(this.recordsByBindingId.values())
      .filter((record) => record.state === "healthy")
      .map((record) => record.id);
  }

  async listEligibleBindings(): Promise<CredentialBinding[]> {
    return this.bindings;
  }

  async getCredentialRecordByBindingId(bindingId: string): Promise<CredentialRecord | null> {
    return this.recordsByBindingId.get(bindingId) ?? null;
  }

  async markCredentialState(input: MarkCredentialStateInput): Promise<void> {
    this.markCalls.push(input);
  }
}

class UnusedLeaseRepository implements LeaseRepository {
  async getActiveLease(_input: ResolveLeaseInput): Promise<SessionLease | null> {
    return null;
  }

  async createLeaseIfMissing(_input: CreateSessionLeaseInput): Promise<SessionLease> {
    throw new Error("lease_repository_not_used");
  }

  async rebindLease(_input: RebindSessionLeaseInput): Promise<SessionLease | null> {
    throw new Error("lease_repository_not_used");
  }
}

function createCredentialRecord(overrides: Partial<CredentialRecord> = {}): CredentialRecord {
  return {
    id: "cred_1",
    ownerUserId: "user_1",
    provider: "openai",
    credentialType: "oauth",
    state: "healthy",
    secretRef: "secret_1",
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    ...overrides,
  };
}

function createRuntime(input: {
  credentials: CredentialRepository;
  secrets: EncryptedSecretStore;
}): RuntimeState {
  return {
    credentials: input.credentials,
    secrets: input.secrets,
    leases: new UnusedLeaseRepository(),
    usage: {
      async recordUsage() {},
    } satisfies UsageRepository,
  };
}

test("default proxy runtime wiring refreshes expired openai oauth credentials", async () => {
  const secrets = new EncryptedSecretStore("test_secret_key_32_bytes_minimum____", {
    secret_1: {
      kind: "openai_oauth",
      accessToken: "expired_access",
      refreshToken: "refresh_token_live",
      expiresAt: "2026-04-01T11:59:00.000Z",
    },
  });
  const credentials = new InMemoryCredentialRepository(
    new Map([
      [
        "binding_refresh",
        createCredentialRecord({
          provider: "openai",
          credentialType: "oauth",
        }),
      ],
    ]),
  );
  const refreshCalls: Array<{ refreshToken: string }> = [];

  const proxy = createDefaultProxyDependencies(createRuntime({ credentials, secrets }), {
    openAiOAuth: {
      async startAuthorization() {
        throw new Error("start_authorization_not_used");
      },
      async exchangeCode() {
        throw new Error("exchange_code_not_used");
      },
      async refreshToken(input: { refreshToken: string }) {
        refreshCalls.push(input);
        return {
          accessToken: "fresh_access",
          refreshToken: "fresh_refresh",
          expiresAt: "2026-04-01T13:00:00.000Z",
        };
      },
    },
  });

  const auth = await proxy.tokenBroker.getUpstreamAuth({ bindingId: "binding_refresh" });

  assert.deepEqual(auth, {
    kind: "oauth",
    value: "fresh_access",
  });
  assert.deepEqual(refreshCalls, [{ refreshToken: "refresh_token_live" }]);
  assert.deepEqual(await secrets.get("secret_1"), {
    kind: "openai_oauth",
    accessToken: "fresh_access",
    refreshToken: "fresh_refresh",
    expiresAt: "2026-04-01T13:00:00.000Z",
  });
});

test("default proxy runtime wiring marks permanently invalid oauth credentials unhealthy", async () => {
  const secrets = new EncryptedSecretStore("test_secret_key_32_bytes_minimum____", {
    secret_1: {
      kind: "openai_oauth",
      accessToken: "expired_access",
      refreshToken: "refresh_token_live",
      expiresAt: "2026-04-01T11:59:00.000Z",
    },
  });
  const credentials = new InMemoryCredentialRepository(
    new Map([
      [
        "binding_revoked",
        createCredentialRecord({
          id: "cred_revoked",
          provider: "openai",
          credentialType: "oauth",
        }),
      ],
    ]),
  );

  const proxy = createDefaultProxyDependencies(createRuntime({ credentials, secrets }), {
    openAiOAuth: {
      async startAuthorization() {
        throw new Error("start_authorization_not_used");
      },
      async exchangeCode() {
        throw new Error("exchange_code_not_used");
      },
      async refreshToken() {
        throw new OpenAiOAuthRefreshError("permanent_credential", "invalid_grant");
      },
    },
  });

  await assert.rejects(
    () => proxy.tokenBroker.getUpstreamAuth({ bindingId: "binding_revoked" }),
    (error: unknown) => {
      assert.ok(error instanceof OpenAiOAuthRefreshError);
      assert.equal(error.kind, "permanent_credential");
      assert.equal(error.message, "invalid_grant");
      return true;
    },
  );

  assert.deepEqual(credentials.markCalls, [
    {
      credentialRecordId: "cred_revoked",
      state: "unhealthy",
      reason: "invalid_grant",
    },
  ]);
});
