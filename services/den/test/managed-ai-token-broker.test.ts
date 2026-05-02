import assert from "node:assert/strict"
import test from "node:test"

import type {
  CredentialBinding,
  CredentialRecord,
  CredentialRepository,
  MarkCredentialStateInput,
} from "../src/managed-ai/credentials/repository.js"
import { DefaultTokenBroker, OpenAiOAuthRefreshError } from "../src/managed-ai/credentials/default-token-broker.js"
import { EncryptedSecretStore } from "../src/managed-ai/credentials/encrypted-secret-store.js"

class InMemoryCredentialRepository implements CredentialRepository {
  public readonly markCalls: MarkCredentialStateInput[] = []

  constructor(
    private readonly recordsByBindingId: Map<string, CredentialRecord>,
    private readonly bindings: CredentialBinding[] = [],
  ) {}

  async getCredentialRecordById(credentialRecordId: string): Promise<CredentialRecord | null> {
    for (const record of this.recordsByBindingId.values()) {
      if (record.id === credentialRecordId) {
        return record
      }
    }
    return null
  }

  async listHealthyCredentialRecordIds(): Promise<string[]> {
    return Array.from(this.recordsByBindingId.values())
      .filter((record) => record.state === "healthy")
      .map((record) => record.id)
  }

  async listEligibleBindings(): Promise<CredentialBinding[]> {
    return this.bindings
  }

  async getCredentialRecordByBindingId(bindingId: string): Promise<CredentialRecord | null> {
    return this.recordsByBindingId.get(bindingId) ?? null
  }

  async markCredentialState(input: MarkCredentialStateInput): Promise<void> {
    this.markCalls.push(input)
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
  }
}

test("returns api key auth for anthropic bindings", async () => {
  const secretStore = new EncryptedSecretStore("test_secret_key_32_bytes_minimum____", {
    secret_1: {
      kind: "api_key",
      apiKey: "sk-ant-test",
    },
  })
  const credentials = new InMemoryCredentialRepository(
    new Map([
      [
        "binding_api_key",
        createCredentialRecord({
          provider: "anthropic",
          credentialType: "api_key",
        }),
      ],
    ]),
  )

  const broker = new DefaultTokenBroker({
    credentials,
    secrets: secretStore,
    now: () => new Date("2026-04-01T12:00:00.000Z"),
  })

  const auth = await broker.getUpstreamAuth({ bindingId: "binding_api_key" })

  assert.deepEqual(auth, {
    kind: "api-key",
    value: "sk-ant-test",
  })
})

test("rejects openai-compatible secrets instead of treating them as oauth", async () => {
  const secretStore = new EncryptedSecretStore("test_secret_key_32_bytes_minimum____", {
    secret_1: {
      kind: "openai_compatible_api_key",
      apiKey: "sk-compatible-test",
      baseUrl: "https://compatible.example.test/v1",
    },
  })
  const credentials = new InMemoryCredentialRepository(
    new Map([
      [
        "binding_openai_compatible",
        createCredentialRecord({
          provider: "openai_compatible",
          credentialType: "api_key",
        }),
      ],
    ]),
  )

  const broker = new DefaultTokenBroker({
    credentials,
    secrets: secretStore,
    now: () => new Date("2026-04-01T12:00:00.000Z"),
  })

  await assert.rejects(
    () => broker.getUpstreamAuth({ bindingId: "binding_openai_compatible" }),
    {
      message: "unsupported_secret_kind:openai_compatible_api_key",
    },
  )
})

test("refreshes expired openai oauth tokens before proxying", async () => {
  const secretStore = new EncryptedSecretStore("test_secret_key_32_bytes_minimum____", {
    secret_1: {
      kind: "openai_oauth",
      accessToken: "expired_access",
      refreshToken: "refresh_token_live",
      expiresAt: "2026-04-01T11:59:00.000Z",
    },
  })
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
  )

  const broker = new DefaultTokenBroker({
    credentials,
    secrets: secretStore,
    now: () => new Date("2026-04-01T12:00:00.000Z"),
    refreshOpenAiOAuth: async () => ({
      kind: "openai_oauth",
      accessToken: "fresh_access",
      refreshToken: "fresh_refresh",
      expiresAt: "2026-04-01T13:00:00.000Z",
    }),
  })

  const auth = await broker.getUpstreamAuth({ bindingId: "binding_refresh" })

  assert.deepEqual(auth, {
    kind: "oauth",
    value: "fresh_access",
  })
  assert.deepEqual(await secretStore.get("secret_1"), {
    kind: "openai_oauth",
    accessToken: "fresh_access",
    refreshToken: "fresh_refresh",
    expiresAt: "2026-04-01T13:00:00.000Z",
  })
})

test("marks revoked oauth credentials unhealthy without leaking tokens", async () => {
  const secretStore = new EncryptedSecretStore("test_secret_key_32_bytes_minimum____", {
    secret_1: {
      kind: "openai_oauth",
      accessToken: "sensitive_access_token",
      refreshToken: "sensitive_refresh_token",
      expiresAt: "2026-04-01T11:59:00.000Z",
    },
  })
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
  )

  const broker = new DefaultTokenBroker({
    credentials,
    secrets: secretStore,
    now: () => new Date("2026-04-01T12:00:00.000Z"),
    refreshOpenAiOAuth: async () => {
      throw new OpenAiOAuthRefreshError("permanent_credential", "revoked_token")
    },
  })

  await assert.rejects(
    () => broker.getUpstreamAuth({ bindingId: "binding_revoked" }),
    (error: unknown) => {
      assert.ok(error instanceof OpenAiOAuthRefreshError)
      assert.equal(error.kind, "permanent_credential")
      assert.equal(error.message, "revoked_token")
      assert.doesNotMatch(error.message, /sensitive_access_token|sensitive_refresh_token/)
      return true
    },
  )

  assert.deepEqual(credentials.markCalls, [
    {
      credentialRecordId: "cred_revoked",
      state: "unhealthy",
      reason: "revoked_token",
    },
  ])
})
