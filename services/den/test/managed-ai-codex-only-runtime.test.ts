import assert from "node:assert/strict"
import test from "node:test"
import type { OrganizationBillingRepository } from "../src/billing/repository.js"

Object.assign(process.env, {
  DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_den",
  BETTER_AUTH_SECRET: "12345678901234567890123456789012",
  BETTER_AUTH_URL: "https://den.example.test",
  MANAGED_AI_DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_ai_gateway",
  MANAGED_AI_SECRET_KEY: "abcdefghijklmnopqrstuvwxyz123456",
})

for (const key of [
  "MANAGED_AI_OPENAI_CLIENT_ID",
  "MANAGED_AI_OPENAI_CLIENT_SECRET",
  "MANAGED_AI_OPENAI_REDIRECT_BASE",
]) {
  delete process.env[key]
}

const { createDefaultProxyDependencies, createDefaultRuntimeState } = await import("../src/managed-ai/runtime/default-runtime.js")

const organizationBilling = {
  getBillingAccount: async () => null,
  findBillingAccountByStripeSubscriptionId: async () => null,
  findBillingAccountByStripeCustomerId: async () => null,
  upsertBillingAccount: async () => {
    throw new Error("not implemented")
  },
  listAllowedTiers: async () => [],
  setAllowedTiers: async () => [],
  countActiveUsers: async () => 0,
  deriveEntitlement: async () => ({
    mode: "manual_access",
    effectiveMode: "manual_access",
    status: "active",
    canUseManagedAi: true,
    canUseByokOrLocalProvider: true,
    canReadHistory: true,
    licenseLimit: 1,
    activeUserCount: 0,
    isInGracePeriod: false,
    warning: null,
    managedAiBlockingReason: null,
    byokOrLocalProviderBlockingReason: null,
  }),
  assertRequestedQuantitiesCanCoverActiveUsers: async () => {},
  recordBillingEvent: async () => {
    throw new Error("not implemented")
  },
  updateBillingEvent: async () => null,
} satisfies OrganizationBillingRepository

test("default managed ai proxy dependencies allow codex-only runtime without OpenAI OAuth fallback config", () => {
  const runtime = createDefaultRuntimeState({
    db: {},
    secretKey: "abcdefghijklmnopqrstuvwxyz123456",
    organizationBilling,
  })

  const deps = createDefaultProxyDependencies(runtime)

  assert.equal(deps.denInferenceMode, "retired")
  assert.equal(typeof deps.codexOAuthTransport.chatCompletions, "function")
})

test("default openai-compatible transport uses fetch because credentials provide base URLs", async () => {
  const originalFetch = globalThis.fetch
  const fetchCalls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (url, init) => {
    fetchCalls.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify({ id: "chatcmpl_runtime_1" }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    })
  }) as typeof fetch

  try {
    const runtime = createDefaultRuntimeState({
      db: {},
      secretKey: "abcdefghijklmnopqrstuvwxyz123456",
      organizationBilling,
    })
    const deps = createDefaultProxyDependencies(runtime)

    const response = await deps.openAiCompatibleTransport.chatCompletions({
      apiKey: "sk-runtime",
      baseUrl: "https://runtime.example.test/v1",
      body: { model: "custom-model" },
    })

    assert.deepEqual(response.body, { id: "chatcmpl_runtime_1" })
    assert.deepEqual(fetchCalls, [
      {
        url: "https://runtime.example.test/v1/chat/completions",
        init: {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer sk-runtime",
          },
          body: JSON.stringify({ model: "custom-model" }),
        },
      },
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})
