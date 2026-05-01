import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

Object.assign(process.env, {
  DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_den",
  BETTER_AUTH_SECRET: "12345678901234567890123456789012",
  BETTER_AUTH_URL: "https://den.example.test",
  MANAGED_AI_SECRET_KEY: "abcdefghijklmnopqrstuvwxyz123456",
})

const { createManagedAiAdminUiRouter } = await import("../src/managed-ai/http/admin.js")

function createSession() {
  return {
    user: {
      id: "user_admin",
      email: "admin@example.test",
      emailVerified: true,
      name: "Admin",
    },
    platformAdmin: true,
    activeOrgId: null,
    organizations: [],
  }
}

function createUiApp() {
  const app = express()
  app.use(express.json())
  app.use(
    createManagedAiAdminUiRouter({
      async getAdminSession() {
        return createSession()
      },
      openAiOAuth: {
        async startAuthorization() {
          return { authorizeUrl: "https://auth.openai.com/oauth/authorize?client_id=test" }
        },
        async exchangeCode() {
          throw new Error("unused")
        },
        async refreshToken() {
          throw new Error("unused")
        },
      },
      alerts: {
        async listAlerts() {
          return []
        },
      },
      audit: {
        async recordEvent() {
          return
        },
      },
      credentials: {
        async listAdminCredentials() {
          return []
        },
      } as any,
      secrets: {} as any,
    }),
  )
  return app
}

test("GET /admin/credentials serves the DEN admin shell with Codex runtime controls and fallback provider credentials", async () => {
  const app = createUiApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/credentials`)

    assert.equal(response.status, 200)
    const html = await response.text()
    assert.match(html, /Veslo Admin/i)
    assert.match(html, /Credentials/i)
    assert.match(html, /Users/i)
    assert.match(html, /Sign in with Browser/i)
    assert.match(html, /Codex \/ ChatGPT runtime profile/i)
    assert.match(html, /Server-side Codex worker profile/i)
    assert.match(html, /Legacy OpenAI fallback/i)
    assert.match(html, /Legacy Anthropic fallback/i)
    assert.match(html, /id="credential-openai-connect"/)
    assert.match(html, /id="credential-openai-status"/)
    assert.match(html, /id="credential-codex-name"/)
    assert.match(html, /id="credential-codex-secret"/)
    assert.match(html, /id="credential-codex-submit"/)
    assert.match(html, /id="credential-codex-status"/)
    assert.match(html, /Shared Codex runtime credential/i)
    assert.match(html, /id="credential-anthropic-name"/)
    assert.match(html, /id="credential-anthropic-secret"/)
    assert.match(html, /id="credential-anthropic-submit"/)
    assert.match(html, /id="user-ai-access-provider"/)
    assert.match(html, /id="user-ai-access-credential"/)
    assert.match(html, /<option value="codex_oauth">Codex \/ ChatGPT runtime<\/option>/)
    assert.match(html, /Cached tokens/i)
    assert.match(html, /Eligibility/i)
    assert.match(html, /id="usage-credential-table-body"/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js uses DEN desktop auth and OpenAI OAuth credential routes", async () => {
  const app = createUiApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/app.js`)

    assert.equal(response.status, 200)
    const script = await response.text()
    assert.match(script, /\/v2\/desktop-auth\/start/)
    assert.match(script, /\/v2\/desktop-auth\/exchange/)
    assert.match(script, /\/credentials\/openai\/oauth\/start/)
    assert.match(script, /\/credentials\/openai\/oauth\/exchange/)
    assert.match(script, /credential-openai-connect/)
    assert.match(script, /credential-codex-submit/)
    assert.match(script, /credential-codex-secret/)
    assert.match(script, /Primary routing credential for the server-side Codex worker/)
    assert.match(script, /credential-anthropic-submit/)
    assert.match(script, /Fallback only: connect platform OpenAI OAuth/)
    assert.match(script, /Anthropic legacy fallback/)
    assert.match(script, /cachedTokens/)
    assert.match(script, /totalTokens/)
    assert.match(script, /renderCredentialEligibility/)
    assert.match(script, /reasonText = eligibility\.reason === CODEX_EXHAUSTED_REASON/)
    assert.match(script, /credential\.provider !== "codex_oauth"[\s\S]*<span class="status-chip info">N\/A<\/span>/)
    assert.match(script, /<span class="status-chip \$\{escapeHtml\(tone\)\}">\$\{escapeHtml\(eligibility\.state\)\}<\/span>/)
    assert.match(script, /escapeHtml\(`\$\{reason\}\$\{reset\}`\.trim\(\)\)/)
    assert.match(script, /if \(state === "eligible"\) return "success"/)
    assert.match(script, /if \(state === "exhausted" \|\| state === "draining"\) return "warning"/)
    assert.match(script, /if \(state === "revoked" \|\| state === "unhealthy"\) return "danger"/)
    assert.match(script, /resetAt/)
    assert.match(script, /all_codex_credentials_exhausted/)
    assert.doesNotMatch(script, /eligibility\.state === "exhausted" \? ` \(\$\{CODEX_EXHAUSTED_REASON\}\)`/)
    assert.doesNotMatch(script, /all_codex_credentials_exhausted status unavailable/)
    assert.match(script, /availableCredentials/)
    assert.match(script, /user-ai-access-credential/)
    assert.match(script, /Select assigned credential/)
    assert.match(script, /credentialId:\s*typeof payload\.credentialId === "string" \? payload\.credentialId : null/)
    assert.match(script, /credentialId:\s*readAiAccessCredentialValue\(\)/)
    assert.match(
      script,
      /async function saveUserAiAccess\(userId,\s*input = null\)[\s\S]*const aiAccessInput = input && typeof input === "object"[\s\S]*credentialId: readAiAccessCredentialValue\(\)/,
    )
    assert.match(
      script,
      /async function saveUser\(\) \{[\s\S]*const aiAccessInput = \{\s*\.\.\.readAiAccessFormValue\(\),\s*credentialId: readAiAccessCredentialValue\(\),\s*}\s*;[\s\S]*await loadUsers\(\);[\s\S]*await saveUserAiAccess\(selectedUser\.id,\s*aiAccessInput\)/,
    )
    assert.match(
      script,
      /async function createCodexCredential\(\) \{[\s\S]*await fetchJson\("\/credentials", \{\s*method: "POST"[\s\S]*await refreshSelectedUserAiAccessOptions\(\)/,
    )
    assert.match(
      script,
      /const shouldClearToken = payload\?\.error === "unauthorized" \|\| payload\?\.error === "forbidden"/,
    )
  } finally {
    server.close()
    await once(server, "close")
  }
})
