import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"

import { AutomaticUserAiAccessInfrastructureError } from "../src/access/automatic-user-access.js"
import { ManagedAiEntitlementLookupError } from "../src/billing/den-managed-ai-entitlement-resolver.js"
import { createApp } from "../src/index.js"

function createOrderedProxyApp(input: {
  events: string[]
  entitlement: () => Promise<{ orgId: string; canUseManagedAi: boolean }>
  accessError?: Error & { status?: number; code?: string }
}) {
  return createApp({
    proxy: {
      gatewaySessions: {
        async resolveSession() {
          input.events.push("session")
          return { token: "den-token", user: { id: "user_1", email: "user@example.test" } }
        },
      },
      managedAiEntitlement: {
        async resolve(request) {
          input.events.push("entitlement")
          assert.deepEqual(request, { token: "den-token", requestedOrgId: "org_1" })
          return input.entitlement()
        },
      },
      automaticUserAiAccess: {
        async getOrCreateUserAiAccess() {
          input.events.push("access")
          if (input.accessError) throw input.accessError
          return {
            id: "access_1",
            userId: "user_1",
            enabled: true,
            provider: "openai",
            credentialId: null,
            defaultModel: "gpt-5.4",
            allowedModels: ["gpt-5.4"],
            assignmentOrigin: "admin_assigned",
            createdAt: new Date(),
            updatedAt: new Date(),
          }
        },
        async buildEnabledUpdate() {
          throw new Error("unused")
        },
      },
      modelPolicy: {
        async getPolicy() {
          input.events.push("policy")
          return {
            id: "platform" as const,
            enabledModels: [{ provider: "openai" as const, model: "gpt-5.4" }],
            activeModel: { provider: "openai" as const, model: "gpt-5.4" },
            createdAt: new Date(),
            updatedAt: new Date(),
          }
        },
      },
      leaseBroker: {
        async getOrCreateActiveLease() {
          input.events.push("lease")
          return {
            id: "lease_1",
            ownerUserId: "user_1",
            provider: "openai" as const,
            sessionId: "session_1",
            activeBindingId: "binding_1",
          }
        },
        async handleUpstreamFailure() {
          throw new Error("unused")
        },
      } as never,
      tokenBroker: {
        async getUpstreamAuth() {
          input.events.push("credential")
          return { kind: "oauth" as const, value: "token" }
        },
      },
      openAiTransport: {
        async chatCompletions(request) {
          input.events.push("transport")
          return { status: 200, body: { id: "response_1", model: request.body.model } }
        },
      },
      credentials: {
        async getCredentialRecordById() { return null },
        async listHealthyCredentialRecordIds() { return [] },
        async getCredentialRecordByBindingId() { return null },
        async markCredentialState() {},
      },
      usageRepository: { async recordUsage() {} },
      anthropicTransport: { async messages() { throw new Error("unused") } },
      codexOAuthTransport: { async chatCompletions() { throw new Error("unused") } },
      openAiCompatibleTransport: { async chatCompletions() { throw new Error("unused") } },
      secrets: {} as never,
    } as any,
  })
}

async function request(app: ReturnType<typeof createApp>) {
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/providers/openai/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer den-token",
        "content-type": "application/json",
        "x-veslo-den-org-id": "org_1",
        "x-veslo-session-id": "session_1",
      },
      body: JSON.stringify({ messages: [] }),
    })
    return { status: response.status, body: await response.json() }
  } finally {
    server.close()
    await once(server, "close")
  }
}

test("Gateway resolves session and entitlement before user access, lease, and credential", async () => {
  const events: string[] = []
  const response = await request(createOrderedProxyApp({
    events,
    async entitlement() {
      return { orgId: "org_1", canUseManagedAi: true }
    },
  }))

  assert.equal(response.status, 200)
  assert.deepEqual(events, ["session", "entitlement", "access", "policy", "lease", "credential", "transport"])
})

test("denied entitlement returns stable 402 before user access or model resolution", async () => {
  const events: string[] = []
  const response = await request(createOrderedProxyApp({
    events,
    async entitlement() {
      return { orgId: "org_1", canUseManagedAi: false }
    },
  }))

  assert.equal(response.status, 402)
  assert.deepEqual(response.body, { error: "managed_ai_entitlement_denied" })
  assert.deepEqual(events, ["session", "entitlement"])
})

test("unavailable entitlement returns stable 503 before user access or model resolution", async () => {
  const events: string[] = []
  const response = await request(createOrderedProxyApp({
    events,
    async entitlement() {
      throw new ManagedAiEntitlementLookupError("managed_ai_entitlement_unavailable", 503)
    },
  }))

  assert.equal(response.status, 503)
  assert.deepEqual(response.body, { error: "managed_ai_entitlement_unavailable" })
  assert.deepEqual(events, ["session", "entitlement"])
})

test("Gateway preserves safe org-context errors without leaking DEN response details", async () => {
  const events: string[] = []
  const response = await request(createOrderedProxyApp({
    events,
    async entitlement() {
      throw new ManagedAiEntitlementLookupError("organization_forbidden", 403)
    },
  }))

  assert.equal(response.status, 403)
  assert.deepEqual(response.body, { error: "organization_forbidden" })
  assert.deepEqual(events, ["session", "entitlement"])
})

test("automatic access infrastructure failure is a stable 503 after entitlement", async () => {
  const events: string[] = []
  const error = new AutomaticUserAiAccessInfrastructureError("gateway_platform_model_policy_unavailable")
  const response = await request(createOrderedProxyApp({
    events,
    accessError: error,
    async entitlement() { return { orgId: "org_1", canUseManagedAi: true } },
  }))

  assert.equal(response.status, 503)
  assert.deepEqual(response.body, { error: "gateway_platform_model_policy_unavailable" })
  assert.deepEqual(events, ["session", "entitlement", "access"])
})
