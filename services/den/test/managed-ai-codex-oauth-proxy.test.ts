import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

import type { UserAiAccessPolicyRecord } from "../src/managed-ai/access/repository.js"
import type {
  CredentialBinding,
  CredentialRecord,
  CredentialRepository,
  ListEligibleBindingsInput,
  MarkCredentialStateInput,
} from "../src/managed-ai/credentials/repository.js"
import { DefaultBindingSelector } from "../src/managed-ai/leases/binding-selector.js"
import { LeaseBroker } from "../src/managed-ai/leases/lease-broker.js"
import type {
  CreateSessionLeaseInput,
  LeaseRepository,
  RebindSessionLeaseInput,
  ResolveLeaseInput,
  SessionLease,
} from "../src/managed-ai/leases/repository.js"
import type { RecordUsageInput } from "../src/managed-ai/usage/repository.js"

Object.assign(process.env, {
  DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_den",
  BETTER_AUTH_SECRET: "12345678901234567890123456789012",
  BETTER_AUTH_URL: "https://den.example.test",
})

const { getPlatformCredentialOwnerUserId } = await import("../src/managed-ai/credentials/platform-owner.js")
const { createProxyRouter } = await import("../src/managed-ai/http/proxy.js")
const { ProviderTransportError } = await import("../src/managed-ai/providers/transport.js")

class TestCredentialRepository implements CredentialRepository {
  public readonly listEligibleBindingsCalls: ListEligibleBindingsInput[] = []

  constructor(
    private readonly recordsByBindingId: Map<string, CredentialRecord>,
    private readonly bindingsByCredentialId: Map<string, CredentialBinding> = new Map(),
    private readonly eligibleBindings: CredentialBinding[] = [],
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
    return Array.from(this.recordsByBindingId.values()).map((record) => record.id)
  }

  async getCredentialRecordByBindingId(bindingId: string): Promise<CredentialRecord | null> {
    return this.recordsByBindingId.get(bindingId) ?? null
  }

  async listEligibleBindings(input: ListEligibleBindingsInput): Promise<CredentialBinding[]> {
    this.listEligibleBindingsCalls.push(input)
    return this.eligibleBindings.filter((binding) => {
      return binding.ownerUserId === input.ownerUserId &&
        binding.provider === input.provider &&
        (!input.excludeBindingId || binding.id !== input.excludeBindingId)
    })
  }

  async getBindingByCredentialId(credentialId: string): Promise<CredentialBinding | null> {
    return this.bindingsByCredentialId.get(credentialId) ?? null
  }

  async markCredentialState(_input: MarkCredentialStateInput): Promise<void> {}
}

class InMemoryLeaseRepository implements LeaseRepository {
  private readonly leasesByKey = new Map<string, SessionLease>()

  async getActiveLease(input: ResolveLeaseInput): Promise<SessionLease | null> {
    return this.leasesByKey.get(leaseKey(input)) ?? null
  }

  async createLeaseIfMissing(input: CreateSessionLeaseInput): Promise<SessionLease> {
    const key = leaseKey(input)
    const existing = this.leasesByKey.get(key)
    if (existing) {
      return existing
    }

    const created: SessionLease = {
      id: `lease_${this.leasesByKey.size + 1}`,
      ownerUserId: input.ownerUserId,
      provider: input.provider,
      sessionId: input.sessionId,
      activeBindingId: input.activeBindingId,
    }
    this.leasesByKey.set(key, created)
    return created
  }

  async rebindLease(input: RebindSessionLeaseInput): Promise<SessionLease | null> {
    const key = leaseKey(input)
    const existing = this.leasesByKey.get(key)
    if (!existing || existing.activeBindingId !== input.expectedCurrentBindingId) {
      return null
    }

    const rebound: SessionLease = {
      ...existing,
      activeBindingId: input.nextBindingId,
    }
    this.leasesByKey.set(key, rebound)
    return rebound
  }
}

function leaseKey(input: ResolveLeaseInput): string {
  return `${input.ownerUserId}:${input.provider}:${input.sessionId}`
}

function createCredentialRecord(overrides: Partial<CredentialRecord> = {}): CredentialRecord {
  return {
    id: "cred_codex_1",
    name: null,
    ownerUserId: "platform:codex_oauth",
    provider: "codex_oauth",
    credentialType: "oauth",
    state: "healthy",
    secretRef: "secret_codex_1",
    createdAt: new Date("2026-04-10T00:00:00.000Z"),
    updatedAt: new Date("2026-04-10T00:00:00.000Z"),
    lastFailureAt: null,
    ...overrides,
  }
}

function createAiAccess(): UserAiAccessPolicyRecord {
  return {
    id: "ai_access_user_gateway",
    userId: "user_gateway",
    enabled: true,
    provider: "codex_oauth",
    credentialId: "cred_codex_assigned",
    defaultModel: "gpt-5.4",
    allowedModels: ["gpt-5.4"],
    createdAt: new Date("2026-04-10T10:00:00.000Z"),
    updatedAt: new Date("2026-04-10T10:00:00.000Z"),
  }
}

test("codex_oauth proxy forwards through the worker transport with a sticky lease", async () => {
  const recordUsageCalls: RecordUsageInput[] = []
  const transportBodies: unknown[] = []
  const transportAuthJson: Array<string | null | undefined> = []
  const secretAuthJson = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      refresh_token: "proxy-refresh-token",
      account_id: "acct_proxy",
    },
  })
  const credentials = new TestCredentialRepository(
    new Map([
      [
        "binding_codex_assigned",
        createCredentialRecord({
          id: "cred_codex_assigned",
        }),
      ],
      [
        "binding_codex_fallback",
        createCredentialRecord({
          id: "cred_codex_fallback",
        }),
      ],
    ]),
    new Map([
      [
        "cred_codex_assigned",
        {
          id: "binding_codex_assigned",
          ownerUserId: getPlatformCredentialOwnerUserId("codex_oauth"),
          provider: "codex_oauth",
          credentialRecordId: "cred_codex_assigned",
          createdAt: new Date("2026-04-10T00:00:00.000Z"),
          updatedAt: new Date("2026-04-10T00:00:00.000Z"),
        },
      ],
      [
        "cred_codex_fallback",
        {
          id: "binding_codex_fallback",
          ownerUserId: getPlatformCredentialOwnerUserId("codex_oauth"),
          provider: "codex_oauth",
          credentialRecordId: "cred_codex_fallback",
          createdAt: new Date("2026-04-10T00:00:00.000Z"),
          updatedAt: new Date("2026-04-10T00:00:00.000Z"),
        },
      ],
    ]),
    [
      {
        id: "binding_codex_fallback",
        ownerUserId: getPlatformCredentialOwnerUserId("codex_oauth"),
        provider: "codex_oauth",
        credentialRecordId: "cred_codex_fallback",
        createdAt: new Date("2026-04-10T00:00:00.000Z"),
        updatedAt: new Date("2026-04-10T00:00:00.000Z"),
      },
      {
        id: "binding_codex_assigned",
        ownerUserId: getPlatformCredentialOwnerUserId("codex_oauth"),
        provider: "codex_oauth",
        credentialRecordId: "cred_codex_assigned",
        createdAt: new Date("2026-04-10T00:00:00.000Z"),
        updatedAt: new Date("2026-04-10T00:00:00.000Z"),
      },
    ],
  )

  const app = express()
  app.use(express.json())
  app.use(
    createProxyRouter({
      gatewaySessions: {
        async resolveSession(token: string) {
          assert.equal(token, "gateway-access-token")
          return {
            token,
            user: {
              id: "user_gateway",
              email: "gateway@example.test",
            },
          }
        },
      },
      aiAccess: {
        async getUserAiAccess(userId: string) {
          assert.equal(userId, "user_gateway")
          return createAiAccess()
        },
      },
      credentials,
      secrets: {
        async get(secretRef: string) {
          assert.match(secretRef, /^secret_codex_/)
          return {
            kind: "codex_auth_json",
            authJson: secretAuthJson,
          }
        },
      },
      usageRepository: {
        async recordUsage(input: RecordUsageInput) {
          recordUsageCalls.push(input)
        },
      },
      leaseBroker: new LeaseBroker(new InMemoryLeaseRepository(), new DefaultBindingSelector(credentials)),
      tokenBroker: {
        async getUpstreamAuth() {
          assert.fail("token broker should not run for codex worker route")
        },
      },
      openAiTransport: {
        async chatCompletions() {
          assert.fail("openai transport should not be reached in codex proxy test")
        },
      },
      anthropicTransport: {
        async messages() {
          assert.fail("anthropic transport should not be reached in codex proxy test")
        },
      },
      codexOAuthTransport: {
        async chatCompletions(input: { body: unknown; authJson?: string | null }) {
          transportBodies.push(input.body)
          transportAuthJson.push(input.authJson)
          return {
            status: 200,
            headers: {
              "x-request-id": "codex_req_usage_1",
            },
            body: {
              id: "chatcmpl_codex_usage_1",
              object: "chat.completion",
              model: "gpt-5.4",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "ok" },
                  finish_reason: "stop",
                },
              ],
              usage: null,
            },
          }
        },
      },
    } as never),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/providers/codex_oauth/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-access-token",
        "content-type": "application/json",
        "x-veslo-session-id": "session_codex_1",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      id: "chatcmpl_codex_usage_1",
      object: "chat.completion",
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: null,
    })
    assert.deepEqual(transportBodies, [
      {
        model: "gpt-5.4",
        messages: [{ role: "user", content: "hello" }],
      },
    ])
    assert.deepEqual(transportAuthJson, [secretAuthJson])
    assert.deepEqual(recordUsageCalls, [
      {
        requestId: "codex_req_usage_1",
        ownerUserId: "user_gateway",
        provider: "codex_oauth",
        sessionId: "session_codex_1",
        credentialId: "cred_codex_assigned",
        bindingId: "binding_codex_assigned",
        model: "gpt-5.4",
        inputTokens: undefined,
        outputTokens: undefined,
      },
    ])
    assert.deepEqual(credentials.listEligibleBindingsCalls, [])
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("codex_oauth proxy fails when the assigned credential is unavailable", async () => {
  const app = express()
  app.use(express.json())
  app.use(
    createProxyRouter({
      gatewaySessions: {
        async resolveSession() {
          return {
            token: "gateway-access-token",
            user: {
              id: "user_gateway",
              email: "gateway@example.test",
            },
          }
        },
      },
      aiAccess: {
        async getUserAiAccess() {
          return createAiAccess()
        },
      },
      credentials: new TestCredentialRepository(new Map()),
      secrets: {
        async get() {
          assert.fail("secret store should not run when the assigned credential is unavailable")
        },
      },
      usageRepository: {
        async recordUsage() {
          assert.fail("usage should not be recorded when the assigned credential is unavailable")
        },
      },
      leaseBroker: {
        async getOrCreateActiveLease() {
          assert.fail("lease broker should not run when the assigned credential is unavailable")
        },
        async handleUpstreamFailure() {
          assert.fail("failure handler should not run when the assigned credential is unavailable")
        },
      } as never,
      tokenBroker: {
        async getUpstreamAuth() {
          assert.fail("token broker should not run for codex worker route")
        },
      },
      openAiTransport: {
        async chatCompletions() {
          assert.fail("openai transport should not be reached in codex proxy test")
        },
      },
      anthropicTransport: {
        async messages() {
          assert.fail("anthropic transport should not be reached in codex proxy test")
        },
      },
      codexOAuthTransport: {
        async chatCompletions() {
          assert.fail("codex transport should not run when the assigned credential is unavailable")
        },
      },
    } as never),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/providers/codex_oauth/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-access-token",
        "content-type": "application/json",
        "x-veslo-session-id": "session_codex_missing_1",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), {
      error: "assigned_credential_unavailable",
    })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("codex_oauth proxy preserves structured runtime incompatibility failures", async () => {
  const secretAuthJson = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      refresh_token: "proxy-refresh-token",
      account_id: "acct_proxy",
    },
  })
  const credentials = new TestCredentialRepository(
    new Map([
      [
        "binding_codex_assigned",
        createCredentialRecord({
          id: "cred_codex_assigned",
        }),
      ],
    ]),
    new Map([
      [
        "cred_codex_assigned",
        {
          id: "binding_codex_assigned",
          ownerUserId: getPlatformCredentialOwnerUserId("codex_oauth"),
          provider: "codex_oauth",
          credentialRecordId: "cred_codex_assigned",
          createdAt: new Date("2026-04-10T00:00:00.000Z"),
          updatedAt: new Date("2026-04-10T00:00:00.000Z"),
        },
      ],
    ]),
  )

  const app = express()
  app.use(express.json())
  app.use(
    createProxyRouter({
      gatewaySessions: {
        async resolveSession(token: string) {
          assert.equal(token, "gateway-access-token")
          return {
            token,
            user: {
              id: "user_gateway",
              email: "gateway@example.test",
            },
          }
        },
      },
      aiAccess: {
        async getUserAiAccess(userId: string) {
          assert.equal(userId, "user_gateway")
          return {
            ...createAiAccess(),
            allowedModels: ["gpt-5.4", "gpt-5.5"],
          }
        },
      },
      credentials,
      secrets: {
        async get(secretRef: string) {
          assert.equal(secretRef, "secret_codex_1")
          return {
            kind: "codex_auth_json",
            authJson: secretAuthJson,
          }
        },
      },
      usageRepository: {
        async recordUsage() {
          assert.fail("usage should not be recorded when the worker transport fails")
        },
      },
      leaseBroker: {
        async getOrCreateActiveLease(scope: ResolveLeaseInput) {
          return {
            id: "lease_codex_1",
            ownerUserId: scope.ownerUserId,
            provider: scope.provider,
            sessionId: scope.sessionId,
            activeBindingId: "binding_codex_assigned",
          }
        },
        async handleUpstreamFailure() {
          assert.fail("failure handler should not run for codex worker route")
        },
      } as never,
      tokenBroker: {
        async getUpstreamAuth() {
          assert.fail("token broker should not run for codex worker route")
        },
      },
      openAiTransport: {
        async chatCompletions() {
          assert.fail("openai transport should not be reached in codex proxy test")
        },
      },
      anthropicTransport: {
        async messages() {
          assert.fail("anthropic transport should not be reached in codex proxy test")
        },
      },
      codexOAuthTransport: {
        async chatCompletions() {
          throw new ProviderTransportError("codex_runtime_incompatible", {
            statusCode: 502,
            code: "codex_runtime_incompatible",
            body: {
              error: {
                code: "codex_runtime_incompatible",
                type: "runtime_incompatible",
                message:
                  "The Codex runtime bundled with Veslo is too old for gpt-5.5. Update Veslo to a build with the current veslo-code/Codex runtime, then retry.",
              },
            },
          })
        },
      },
    } as never),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/providers/codex_oauth/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-access-token",
        "content-type": "application/json",
        "x-veslo-session-id": "session_codex_1",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    assert.equal(response.status, 502)
    assert.deepEqual(await response.json(), {
      error: {
        code: "codex_runtime_incompatible",
        type: "runtime_incompatible",
        message:
          "The Codex runtime bundled with Veslo is too old for gpt-5.5. Update Veslo to a build with the current veslo-code/Codex runtime, then retry.",
      },
    })
  } finally {
    server.close()
    await once(server, "close")
  }
})
