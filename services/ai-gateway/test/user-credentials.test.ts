import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"

import { EncryptedSecretStore } from "../src/credentials/encrypted-secret-store.js"
import type { CredentialBinding, CredentialRecord } from "../src/credentials/repository.js"
import type { SecretStore } from "../src/credentials/secret-store.js"
import { createApp } from "../src/index.js"

type UserSession = {
  token: string
  user: {
    id: string
    email?: string
    name?: string
  }
}

class TestCredentialRepository {
  private readonly records = new Map<string, CredentialRecord>()
  private readonly bindings = new Map<string, CredentialBinding>()
  private recordCounter = 0
  private bindingCounter = 0

  async getCredentialRecordById(credentialRecordId: string): Promise<CredentialRecord | null> {
    return this.records.get(credentialRecordId) ?? null
  }

  async listHealthyCredentialRecordIds(): Promise<string[]> {
    return Array.from(this.records.values())
      .filter((record) => record.state === "healthy")
      .map((record) => record.id)
  }

  async listEligibleBindings(input: {
    ownerUserId: string
    provider: string
    excludeBindingId?: string
  }): Promise<CredentialBinding[]> {
    return Array.from(this.bindings.values()).filter((binding) => {
      if (binding.ownerUserId !== input.ownerUserId) return false
      if (binding.provider !== input.provider) return false
      if (input.excludeBindingId && binding.id === input.excludeBindingId) return false

      const record = this.records.get(binding.credentialRecordId)
      return record?.state === "healthy"
    })
  }

  async getCredentialRecordByBindingId(bindingId: string): Promise<CredentialRecord | null> {
    const binding = this.bindings.get(bindingId)
    return binding ? this.records.get(binding.credentialRecordId) ?? null : null
  }

  async markCredentialState(input: { credentialRecordId: string; state: CredentialRecord["state"] }): Promise<void> {
    const record = this.records.get(input.credentialRecordId)
    if (!record) return
    this.records.set(record.id, {
      ...record,
      state: input.state,
      updatedAt: new Date("2026-04-02T11:00:00.000Z"),
      lastFailureAt: input.state === "healthy" ? null : new Date("2026-04-02T11:00:00.000Z"),
    })
  }

  async createUserCredential(input: {
    ownerUserId: string
    provider: string
    credentialType: "api_key" | "oauth"
    secretRef: string
  }): Promise<CredentialRecord> {
    const createdAt = new Date(`2026-04-02T10:0${this.recordCounter}:00.000Z`)
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
    }

    const binding: CredentialBinding = {
      id: `binding_${++this.bindingCounter}`,
      ownerUserId: input.ownerUserId,
      provider: input.provider,
      credentialRecordId: record.id,
      createdAt,
      updatedAt: createdAt,
    }

    this.records.set(record.id, record)
    this.bindings.set(binding.id, binding)
    return record
  }

  async listUserCredentials(input: {
    ownerUserId: string
    provider: string
  }): Promise<CredentialRecord[]> {
    return Array.from(this.records.values()).filter((record) => {
      return record.ownerUserId === input.ownerUserId && record.provider === input.provider
    })
  }

  async revokeUserCredential(input: {
    ownerUserId: string
    provider: string
    credentialId: string
  }): Promise<CredentialRecord | null> {
    const record = this.records.get(input.credentialId)
    if (!record || record.ownerUserId !== input.ownerUserId || record.provider !== input.provider) {
      return null
    }

    const revoked: CredentialRecord = {
      ...record,
      state: "revoked",
      updatedAt: new Date("2026-04-02T12:00:00.000Z"),
    }
    this.records.set(revoked.id, revoked)
    return revoked
  }

  getLatestBinding() {
    return Array.from(this.bindings.values()).at(-1) ?? null
  }
}

function createUserCredentialApp(overrides: {
  session?: UserSession
  startAuthorization?: (input: { userId: string }) => Promise<{ authorizeUrl: string }>
  exchangeCode?: (input: { code: string; userId: string }) => Promise<{
    accessToken: string
    refreshToken: string
    expiresAt: string
  }>
  repository?: TestCredentialRepository
  secrets?: SecretStore
}) {
  const session = overrides.session ?? {
    token: "den_token_123",
    user: {
      id: "user_123",
      email: "user@example.test",
    },
  }
  const repository = overrides.repository ?? new TestCredentialRepository()
  const secrets =
    overrides.secrets ?? new EncryptedSecretStore("task7_secret_key_32_bytes_minimum_____")
  const authorizationCalls: Array<{ userId: string }> = []
  const exchangeCalls: Array<{ code: string; userId: string }> = []

  const app = createApp({
    userCredentials: {
      sessionResolver: {
        async resolveSession(token: string) {
          assert.equal(token, session.token)
          return session
        },
      },
      openAiOAuth: {
        async startAuthorization(input: { userId: string }) {
          authorizationCalls.push(input)
          if (overrides.startAuthorization) {
            return overrides.startAuthorization(input)
          }
          return {
            authorizeUrl: `https://openai.example.test/authorize?user=${encodeURIComponent(input.userId)}`,
          }
        },
        async exchangeCode(input: { code: string; userId: string }) {
          exchangeCalls.push(input)
          if (overrides.exchangeCode) {
            return overrides.exchangeCode(input)
          }
          return {
            accessToken: "openai_access_token",
            refreshToken: "openai_refresh_token",
            expiresAt: "2026-04-03T10:00:00.000Z",
          }
        },
      },
      credentials: repository,
      secrets,
    } as never,
  })

  return {
    app,
    repository,
    secrets,
    authorizationCalls,
    exchangeCalls,
    authHeader: { authorization: `Bearer ${session.token}` },
  }
}

test("POST /api/providers/openai/oauth/start returns authorize url for the signed-in user", async () => {
  const runtime = createUserCredentialApp({})
  const server = runtime.app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/api/providers/openai/oauth/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...runtime.authHeader,
      },
      body: JSON.stringify({}),
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      authorizeUrl: "https://openai.example.test/authorize?user=user_123",
    })
    assert.deepEqual(runtime.authorizationCalls, [{ userId: "user_123" }])
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("POST /api/providers/openai/oauth/callback stores refreshed oauth secret and binding", async () => {
  const runtime = createUserCredentialApp({})
  const server = runtime.app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/api/providers/openai/oauth/callback`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...runtime.authHeader,
      },
      body: JSON.stringify({ code: "oauth_code_123" }),
    })

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.credential.provider, "openai")
    assert.equal(payload.credential.credentialType, "oauth")
    assert.equal(payload.credential.state, "healthy")
    assert.equal(payload.credential.lastFailureAt, null)
    assert.deepEqual(runtime.exchangeCalls, [{ code: "oauth_code_123", userId: "user_123" }])

    const stored = await runtime.repository.listUserCredentials({
      ownerUserId: "user_123",
      provider: "openai",
    })
    assert.equal(stored.length, 1)

    const secret = await runtime.secrets.get(stored[0]!.secretRef)
    assert.deepEqual(secret, {
      kind: "openai_oauth",
      accessToken: "openai_access_token",
      refreshToken: "openai_refresh_token",
      expiresAt: "2026-04-03T10:00:00.000Z",
    })

    const binding = runtime.repository.getLatestBinding()
    assert.ok(binding)
    assert.equal(binding?.provider, "openai")
    assert.equal(binding?.credentialRecordId, stored[0]!.id)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("POST /api/providers/anthropic/api-keys stores an encrypted api key and binding", async () => {
  const runtime = createUserCredentialApp({})
  const server = runtime.app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/api/providers/anthropic/api-keys`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...runtime.authHeader,
      },
      body: JSON.stringify({ apiKey: "sk-ant-secret" }),
    })

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.credential.provider, "anthropic")
    assert.equal(payload.credential.credentialType, "api_key")
    assert.equal(payload.credential.state, "healthy")

    const stored = await runtime.repository.listUserCredentials({
      ownerUserId: "user_123",
      provider: "anthropic",
    })
    assert.equal(stored.length, 1)

    const secret = await runtime.secrets.get(stored[0]!.secretRef)
    assert.deepEqual(secret, {
      kind: "api_key",
      apiKey: "sk-ant-secret",
    })

    const binding = runtime.repository.getLatestBinding()
    assert.ok(binding)
    assert.equal(binding?.provider, "anthropic")
    assert.equal(binding?.credentialRecordId, stored[0]!.id)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /api/providers/:provider/credentials never returns raw secrets", async () => {
  const runtime = createUserCredentialApp({})
  const server = runtime.app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo

    await fetch(`http://127.0.0.1:${port}/api/providers/anthropic/api-keys`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...runtime.authHeader,
      },
      body: JSON.stringify({ apiKey: "sk-ant-secret" }),
    })

    const response = await fetch(`http://127.0.0.1:${port}/api/providers/anthropic/credentials`, {
      headers: runtime.authHeader,
    })

    assert.equal(response.status, 200)
    const payload = await response.json()
    const serialized = JSON.stringify(payload)
    assert.match(serialized, /anthropic/)
    assert.doesNotMatch(serialized, /sk-ant-secret/)
    assert.doesNotMatch(serialized, /accessToken/)
    assert.doesNotMatch(serialized, /refreshToken/)
    assert.deepEqual(Object.keys(payload.credentials[0]!).sort(), [
      "createdAt",
      "credentialType",
      "id",
      "lastFailureAt",
      "provider",
      "state",
      "updatedAt",
    ])
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("DELETE /api/providers/:provider/credentials/:id revokes the credential", async () => {
  const runtime = createUserCredentialApp({})
  const server = runtime.app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo

    const createResponse = await fetch(`http://127.0.0.1:${port}/api/providers/anthropic/api-keys`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...runtime.authHeader,
      },
      body: JSON.stringify({ apiKey: "sk-ant-secret" }),
    })
    const created = await createResponse.json()

    const response = await fetch(
      `http://127.0.0.1:${port}/api/providers/anthropic/credentials/${encodeURIComponent(created.credential.id)}`,
      {
        method: "DELETE",
        headers: runtime.authHeader,
      },
    )

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.credential.state, "revoked")

    const stored = await runtime.repository.getCredentialRecordById(created.credential.id)
    assert.equal(stored?.state, "revoked")

    const eligibleBindings = await runtime.repository.listEligibleBindings({
      ownerUserId: "user_123",
      provider: "anthropic",
    })
    assert.equal(eligibleBindings.length, 0)
  } finally {
    server.close()
    await once(server, "close")
  }
})
