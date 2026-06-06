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

test("GET /admin/credentials serves the DEN admin shell with Codex inference controls and fallback provider credentials", async () => {
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
    assert.match(html, /Server-side Codex inference credential/i)
    assert.match(html, /Legacy OpenAI fallback/i)
    assert.match(html, /Legacy Anthropic fallback/i)
    assert.match(
      html,
      /<option>All providers<\/option>\s*<option>Codex \/ ChatGPT<\/option>\s*<option>OpenAI-compatible provider<\/option>\s*<option>OpenAI<\/option>/,
    )
    assert.match(html, /id="credential-openai-connect"/)
    assert.match(html, /id="credential-openai-status"/)
    assert.match(html, /id="credential-codex-name"/)
    assert.match(html, /id="credential-codex-secret"/)
    assert.match(html, /id="credential-codex-submit"/)
    assert.match(html, /id="credential-codex-status"/)
    assert.match(html, /Shared Codex OAuth credential/i)
    assert.match(html, /id="credential-openai-compatible-name"/)
    assert.match(html, /id="credential-openai-compatible-base-url"/)
    assert.match(html, /id="credential-openai-compatible-secret"/)
    assert.match(html, /id="credential-openai-compatible-submit"/)
    assert.match(html, /id="credential-openai-compatible-status"/)
    assert.match(html, /id="credential-anthropic-name"/)
    assert.match(html, /id="credential-anthropic-secret"/)
    assert.match(html, /id="credential-anthropic-submit"/)
    assert.match(html, /id="user-ai-access-provider"/)
    assert.match(html, /id="user-ai-access-credential"/)
    assert.match(html, /<option value="codex_oauth">Codex \/ ChatGPT runtime<\/option>/)
    assert.match(html, /<option value="openai_compatible">OpenAI-compatible provider<\/option>/)
    assert.match(html, /Cached tokens/i)
    assert.match(html, /Eligibility/i)
    assert.match(html, /<th>Last refresh<\/th>\s*<th>Cached tokens<\/th>\s*<th>Eligibility<\/th>\s*<th>Codex limits<\/th>/)
    assert.match(html, /<th>Last used<\/th>\s*<th>Eligibility<\/th>\s*<th>Upstream status<\/th>/)
    assert.match(html, /id="usage-credential-table-body"/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/organization serves the DEN admin shell with organization management", async () => {
  const app = createUiApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/organization`)

    assert.equal(response.status, 200)
    const html = await response.text()
    assert.match(html, /data-route="organization"/)
    assert.match(html, /data-page="organization"/)
    assert.match(html, /Organization details/i)
    assert.match(html, /Enabled domains/i)
    assert.match(html, /Pending invites/i)
    assert.match(html, /id="organization-save-button"/)
    assert.match(html, /id="organization-seat-limit"/)
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
    assert.match(script, /Primary routing credential for Codex OAuth inference proxying/)
    assert.match(script, /credential-openai-compatible-base-url/)
    assert.match(script, /credential-openai-compatible-submit/)
    assert.match(script, /async function createOpenAiCompatibleCredential\(\)/)
    assert.match(script, /provider: "openai_compatible", baseUrl, secret/)
    assert.match(script, /els\.credentialOpenAiCompatibleSubmit\.addEventListener\("click", \(\) => void createOpenAiCompatibleCredential\(\)\)/)
    assert.match(script, /credential-anthropic-submit/)
    assert.match(script, /Fallback only: connect platform OpenAI OAuth/)
    assert.match(script, /Anthropic legacy fallback/)
    assert.match(script, /cachedTokens/)
    assert.match(script, /totalTokens/)
    assert.match(script, /if \(provider === "openai_compatible"\) return "OpenAI-compatible provider"/)
    assert.match(script, /formatCredentialUpstreamStatus/)
    assert.match(script, /formatCredentialLimitSummary/)
    assert.match(script, /formatLimitWindowSummary/)
    assert.match(script, /renderCredentialCodexStatus/)
    assert.match(script, /renderCredentialEligibility/)
    // The static admin script binds DOM nodes at module load, so this test keeps helper coverage source-based.
    assert.match(script, /reasonText = eligibility\.reason === CODEX_EXHAUSTED_REASON/)
    assert.match(script, /credential\.provider !== "codex_oauth"[\s\S]*<span class="muted">N\/A<\/span>/)
    assert.match(script, /<span class="status-chip \$\{escapeHtml\(tone\)\}">\$\{escapeHtml\(eligibility\.state\)\}<\/span>/)
    assert.match(script, /escapeHtml\(`\$\{reason\}\$\{reset\}`\.trim\(\)\)/)
    assert.match(script, /if \(state === "eligible"\) return "success"/)
    assert.match(script, /if \(state === "exhausted" \|\| state === "draining"\) return "warning"/)
    assert.match(script, /if \(state === "revoked" \|\| state === "unhealthy"\) return "danger"/)
    assert.match(script, /resetAt/)
    assert.match(script, /all_codex_credentials_exhausted/)
    assert.match(script, /Codex upstream/)
    assert.match(script, /Codex limits/)
    assert.match(script, /Codex OK, limits unknown/)
    assert.match(script, /5h: unknown/)
    assert.match(script, /Weekly: unknown/)
    assert.match(script, /Codex limits unavailable/)
    assert.match(script, /No upstream status/)
    assert.match(script, /upstreamStatus\.limitSummary/)
    assert.doesNotMatch(script, /eligibility\.state === "exhausted" \? ` \(\$\{CODEX_EXHAUSTED_REASON\}\)`/)
    assert.doesNotMatch(script, /all_codex_credentials_exhausted status unavailable/)
    assert.match(script, /availableCredentials/)
    assert.match(script, /user-ai-access-credential/)
    assert.match(script, /Select assigned credential/)
    assert.match(script, /const DEFAULT_PAGES = \["organization", "credentials", "sessions", "usage", "alerts", "users", "audit"\]/)
    assert.match(script, /function allowedPages\(\)/)
    assert.match(script, /function hasCapability\(capability\)/)
    assert.match(script, /function applyAdminCapabilities\(\)/)
    assert.match(script, /runAllowedLoad\("organization", loadOrganization\)/)
    assert.match(script, /runAllowedLoad\("users", loadUsers\)/)
    assert.match(script, /runAllowedLoad\("credentials", loadCredentials\)/)
    assert.match(script, /if \(!hasCapability\("managedAiUserAccess"\)\) \{[\s\S]*return null/)
    assert.match(script, /if \(!hasCapability\("managedAiUserAccess"\)\) \{[\s\S]*return;/)
    assert.match(script, /function normalizeOrganizationRoleInput\(value\)/)
    assert.match(script, /orgRole:\s*normalizeOrganizationRoleInput\(els\.userRole\.value\)/)
    assert.match(script, /<option value="organization_admin">Organization admin<\/option>/)
    assert.match(script, /function buildUserUpdatePayload\(payload\)/)
    assert.match(script, /data-invite-resend/)
    assert.match(script, /async function resendOrganizationInvite\(card\)/)
    assert.match(script, /\/invites\/\$\{encodeURIComponent\(inviteId\)\}\/resend/)
    assert.match(script, /event\.target\.closest\("\[data-invite-resend\]"\)/)
    assert.match(
      script,
      /if \(state\.session\?\.platformAdmin !== true\) \{[\s\S]*return \{[\s\S]*orgId: payload\.orgId,[\s\S]*orgRole: payload\.orgRole,[\s\S]*\}/,
    )
    assert.match(
      script,
      /await fetchJson\(`\/users\/\$\{encodeURIComponent\(user\.id\)\}`,[\s\S]*body: JSON\.stringify\(buildUserUpdatePayload\(payload\)\)/,
    )
    assert.match(script, /createUserButtonInline[\s\S]*data-platform-only/)
    assert.match(script, /provider:\s*typeof entry\.provider === "string" \? entry\.provider\.trim\(\) : ""/)
    assert.match(script, /function currentUserAiAccessAvailableCredentials\(userId,\s*provider = ""\)[\s\S]*entry\.provider === provider/)
    assert.match(script, /selectedProvider === "codex_oauth" \|\| selectedProvider === "openai_compatible"/)
    assert.match(script, /Create a healthy OpenAI-compatible credential first, then assign it here\./)
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
