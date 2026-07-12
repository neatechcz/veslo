import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

import type { OrganizationBillingEntitlement } from "../src/billing/organization-billing.js"

Object.assign(process.env, {
  DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_den",
  BETTER_AUTH_SECRET: "12345678901234567890123456789012",
  BETTER_AUTH_URL: "https://den.example.test",
})

const { createProxyRouter } = await import("../src/managed-ai/http/proxy.js")

type TestOrg = {
  id: string
  name: string
  slug: string
  ownerUserId: string
  membershipId: string
  role: "member" | "organization_admin"
  status: "active" | "disabled" | "removed"
}

function createOrg(id: string): TestOrg {
  return {
    id,
    name: id,
    slug: id,
    ownerUserId: "user_gateway",
    membershipId: `membership_${id}`,
    role: "member",
    status: "active",
  }
}

function createEntitlement(
  overrides: Partial<OrganizationBillingEntitlement> = {},
): OrganizationBillingEntitlement {
  return {
    mode: "managed_ai",
    effectiveMode: "managed_ai",
    status: "active",
    canUseManagedAi: true,
    canUseByokOrLocalProvider: true,
    canReadHistory: true,
    licenseLimit: 1,
    activeUserCount: 1,
    isInGracePeriod: false,
    warning: null,
    managedAiBlockingReason: null,
    byokOrLocalProviderBlockingReason: null,
    ...overrides,
  }
}

function createEntitlementApp(input: {
  organizations: TestOrg[]
  requestedOrganizations?: Record<string, TestOrg | null>
  entitlements: Record<string, OrganizationBillingEntitlement>
  upstreamCalls?: { count: number }
  aiAccess?: { shouldNotRun?: boolean }
}) {
  const upstreamCalls = input.upstreamCalls ?? { count: 0 }
  const app = express()
  app.use(express.json())
  app.use(
    createProxyRouter({
      denInferenceMode: "legacy_rollback",
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
      organizationAccess: {
        async listUserOrganizations(userId: string) {
          assert.equal(userId, "user_gateway")
          return input.organizations
        },
        async findUserOrganization(userId: string, orgId: string) {
          assert.equal(userId, "user_gateway")
          return input.requestedOrganizations?.[orgId] ?? null
        },
      },
      organizationBilling: {
        async deriveEntitlement(orgId: string) {
          const entitlement = input.entitlements[orgId]
          if (!entitlement) {
            assert.fail(`missing test entitlement for ${orgId}`)
          }
          return entitlement
        },
      },
      ...(input.aiAccess
        ? {
            aiAccess: {
              async getUserAiAccess() {
                if (input.aiAccess?.shouldNotRun) {
                  assert.fail("AI access policy lookup should run after managed AI billing gate")
                }
                return {
                  id: "ai_access_user_gateway",
                  userId: "user_gateway",
                  enabled: true,
                  provider: "openai",
                  defaultModel: "gpt-4o-mini",
                  allowedModels: ["gpt-4o-mini"],
                  createdAt: new Date("2026-04-10T10:00:00.000Z"),
                  updatedAt: new Date("2026-04-10T10:00:00.000Z"),
                }
              },
            },
          }
        : {}),
      credentials: {
        async getCredentialRecordById() {
          return null
        },
        async listHealthyCredentialRecordIds() {
          return []
        },
        async getCredentialRecordByBindingId() {
          return {
            id: "credential_openai",
          }
        },
        async markCredentialState() {},
      },
      usageRepository: {
        async recordUsage() {},
      },
      leaseBroker: {
        async getOrCreateActiveLease(scope: { ownerUserId: string; provider: string; sessionId: string }) {
          return {
            id: "lease_1",
            ownerUserId: scope.ownerUserId,
            provider: scope.provider,
            sessionId: scope.sessionId,
            activeBindingId: "binding_1",
          }
        },
        async handleUpstreamFailure() {
          assert.fail("failure handler should not be reached")
        },
      },
      tokenBroker: {
        async getUpstreamAuth() {
          return { kind: "api-key", value: "upstream-key" }
        },
      },
      openAiTransport: {
        async chatCompletions() {
          upstreamCalls.count += 1
          return {
            status: 200,
            body: {
              id: "chatcmpl_ok",
              model: "gpt-4o-mini",
            },
            headers: { "content-type": "application/json" },
          }
        },
      },
      anthropicTransport: {
        async messages() {
          assert.fail("anthropic transport should not be reached")
        },
      },
      codexOAuthTransport: {
        async chatCompletions() {
          assert.fail("codex oauth transport should not be reached")
        },
      },
      openAiCompatibleTransport: {
        async chatCompletions() {
          assert.fail("openai-compatible transport should not be reached")
        },
      },
    } as never),
  )
  return app
}

async function requestOpenAi(app: express.Express, init?: { headers?: Record<string, string>; query?: string }) {
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    return await fetch(
      `http://127.0.0.1:${port}/providers/openai/v1/chat/completions${init?.query ?? ""}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer gateway-access-token",
          "content-type": "application/json",
          "x-veslo-session-id": "session_entitlement_1",
          ...init?.headers,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "hello" }],
        }),
      },
    )
  } finally {
    server.close()
    await once(server, "close")
  }
}

test("unpaid organization is blocked before upstream provider calls", async () => {
  const upstreamCalls = { count: 0 }
  const response = await requestOpenAi(
    createEntitlementApp({
      organizations: [createOrg("org_unpaid")],
      entitlements: {
        org_unpaid: createEntitlement({
          mode: "none",
          effectiveMode: "none",
          status: "none",
          canUseManagedAi: false,
          canUseByokOrLocalProvider: false,
          licenseLimit: 0,
          managedAiBlockingReason: "payment_required",
          byokOrLocalProviderBlockingReason: "payment_required",
        }),
      },
      upstreamCalls,
    }),
  )

  assert.equal(response.status, 402)
  assert.equal(upstreamCalls.count, 0)
  assert.deepEqual(await response.json(), {
    error: "payment_required",
    message: "Managed AI billing access is required for this organization.",
    reason: "payment_required",
    orgId: "org_unpaid",
    entitlement: {
      effectiveMode: "none",
      status: "none",
      canUseManagedAi: false,
      canUseByokOrLocalProvider: false,
      canReadHistory: true,
      managedAiBlockingReason: "payment_required",
      byokOrLocalProviderBlockingReason: "payment_required",
    },
  })
})

test("Local Models organization is blocked from Den managed AI while BYOK/local remains allowed", async () => {
  const response = await requestOpenAi(
    createEntitlementApp({
      organizations: [createOrg("org_local_models")],
      entitlements: {
        org_local_models: createEntitlement({
          mode: "local_models",
          effectiveMode: "local_models",
          status: "active",
          canUseManagedAi: false,
          canUseByokOrLocalProvider: true,
          managedAiBlockingReason: "tier_not_allowed",
          byokOrLocalProviderBlockingReason: null,
        }),
      },
    }),
    {
      headers: {
        "x-veslo-den-org-id": "org_local_models",
      },
    },
  )

  assert.equal(response.status, 402)
  assert.deepEqual(await response.json(), {
    error: "payment_required",
    message: "Managed AI billing access is required for this organization.",
    reason: "tier_not_allowed",
    orgId: "org_local_models",
    entitlement: {
      effectiveMode: "local_models",
      status: "active",
      canUseManagedAi: false,
      canUseByokOrLocalProvider: true,
      canReadHistory: true,
      managedAiBlockingReason: "tier_not_allowed",
      byokOrLocalProviderBlockingReason: null,
    },
  })
})

test("managed AI billing gate runs before user AI access policy lookup", async () => {
  const response = await requestOpenAi(
    createEntitlementApp({
      organizations: [createOrg("org_blocked_before_policy")],
      entitlements: {
        org_blocked_before_policy: createEntitlement({
          mode: "none",
          effectiveMode: "none",
          status: "none",
          canUseManagedAi: false,
          managedAiBlockingReason: "payment_required",
        }),
      },
      aiAccess: { shouldNotRun: true },
    }),
    {
      headers: {
        "x-veslo-den-org-id": "org_blocked_before_policy",
      },
    },
  )

  assert.equal(response.status, 402)
})

test("paid managed AI organization passes through to existing provider routing", async () => {
  const upstreamCalls = { count: 0 }
  const response = await requestOpenAi(
    createEntitlementApp({
      organizations: [createOrg("org_paid")],
      entitlements: {
        org_paid: createEntitlement(),
      },
      upstreamCalls,
    }),
    {
      headers: {
        "x-veslo-den-org-id": "org_paid",
      },
    },
  )

  assert.equal(response.status, 200)
  assert.equal(upstreamCalls.count, 1)
  assert.deepEqual(await response.json(), {
    id: "chatcmpl_ok",
    model: "gpt-4o-mini",
  })
})

test("missing org header with multiple organizations returns org_context_required", async () => {
  const response = await requestOpenAi(
    createEntitlementApp({
      organizations: [createOrg("org_1"), createOrg("org_2")],
      entitlements: {},
    }),
  )

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: "org_context_required" })
})

test("requested inaccessible organization returns organization_forbidden", async () => {
  const response = await requestOpenAi(
    createEntitlementApp({
      organizations: [createOrg("org_1")],
      entitlements: {},
    }),
    {
      headers: {
        "x-veslo-den-org-id": "org_forbidden",
      },
    },
  )

  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: "organization_forbidden" })
})

test("requested disabled organization membership cannot authorize managed AI inference", async () => {
  const response = await requestOpenAi(
    createEntitlementApp({
      organizations: [{ ...createOrg("org_disabled"), status: "disabled" }],
      entitlements: {
        org_disabled: createEntitlement(),
      },
    }),
    {
      headers: {
        "x-veslo-den-org-id": "org_disabled",
      },
    },
  )

  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: "organization_forbidden" })
})

for (const status of ["disabled", "removed"] as const) {
  test(`requested ${status} membership found outside the active organization list returns organization_forbidden`, async () => {
    const orgId = `org_${status}_default_lookup`
    const response = await requestOpenAi(
      createEntitlementApp({
        organizations: [],
        requestedOrganizations: {
          [orgId]: { ...createOrg(orgId), status },
        },
        entitlements: {
          [orgId]: createEntitlement(),
        },
      }),
      {
        headers: {
          "x-veslo-den-org-id": orgId,
        },
      },
    )

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: "organization_forbidden" })
  })
}

test("removed organization membership is treated as no managed AI organization context", async () => {
  const response = await requestOpenAi(
    createEntitlementApp({
      organizations: [{ ...createOrg("org_removed"), status: "removed" }],
      entitlements: {
        org_removed: createEntitlement(),
      },
    }),
  )

  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: "organization_required" })
})

test("users without organizations return organization_required", async () => {
  const response = await requestOpenAi(
    createEntitlementApp({
      organizations: [],
      entitlements: {},
    }),
  )

  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: "organization_required" })
})

test("org resolution prefers x-veslo-org-id before Den org header and query", async () => {
  const upstreamCalls = { count: 0 }
  const response = await requestOpenAi(
    createEntitlementApp({
      organizations: [createOrg("org_primary"), createOrg("org_den"), createOrg("org_query")],
      entitlements: {
        org_primary: createEntitlement(),
        org_den: createEntitlement({
          canUseManagedAi: false,
          managedAiBlockingReason: "payment_required",
        }),
        org_query: createEntitlement({
          canUseManagedAi: false,
          managedAiBlockingReason: "payment_required",
        }),
      },
      upstreamCalls,
    }),
    {
      query: "?orgId=org_query",
      headers: {
        "x-veslo-org-id": "org_primary",
        "x-veslo-den-org-id": "org_den",
      },
    },
  )

  assert.equal(response.status, 200)
  assert.equal(upstreamCalls.count, 1)
})
