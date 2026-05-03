import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"

import { createApp } from "../src/index.js"

test("GET /admin/credentials serves the admin shell with an admin-only platform credential form", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/credentials`)

    assert.equal(response.status, 200)
    const html = await response.text()
    assert.match(html, /AI Gateway Admin/i)
    assert.match(html, /Credentials/i)
    assert.match(html, /Users/i)
    assert.match(html, /Sign in with Browser/i)
    assert.doesNotMatch(html, /<form[^>]+id="login-form"/i)
    assert.match(html, /id="credential-create-provider"/)
    assert.match(html, /id="credential-create-name"/)
    assert.match(html, /id="credential-create-base-url"/)
    assert.match(html, /id="credential-create-secret"/)
    assert.match(html, /id="credential-create-submit"/)
    assert.match(html, /Codex \/ ChatGPT runtime profile/)
    assert.match(html, /<option value="codex_oauth">Codex \/ ChatGPT runtime<\/option>/)
    assert.match(html, /<option value="openai_compatible">OpenAI-compatible provider<\/option>/)
    assert.match(html, /Paste the provider API key or the full Codex auth\.json\./)
    assert.match(html, /<th>Last refresh<\/th>\s*<th>Cached tokens<\/th>\s*<th>Eligibility<\/th>\s*<th>Codex limits<\/th>/)
    assert.match(html, /Cached tokens/)
    assert.match(html, /Eligibility/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js uses browser handoff auth instead of custom email-password sign-in", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/app.js`)

    assert.equal(response.status, 200)
    const script = await response.text()
    assert.match(script, /\/auth\/browser\/start/)
    assert.match(script, /\/auth\/browser\/exchange/)
    assert.match(script, /host\.docker\.internal/)
    assert.match(script, /127\.0\.0\.1/)
    assert.doesNotMatch(script, /\/admin\/api\/auth\/sign-in/)
    assert.doesNotMatch(script, /loginPassword/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js preserves auth callback query params until browser exchange completes", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/app.js`)

    assert.equal(response.status, 200)
    const script = await response.text()
    assert.match(script, /const nextPath = page === "overview" \? "\/admin" : `\/admin\/\$\{page\}`/)
    assert.match(script, /const nextUrl = `\$\{nextPath\}\$\{location\.search\}\$\{location\.hash\}`/)
    assert.match(script, /if \(location\.pathname !== nextPath\) {\s*history\.replaceState\(null, "", nextUrl\);\s*}/)
    assert.doesNotMatch(script, /history\.replaceState\(null, "", nextPath\)/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js supports transactionId callbacks and forbidden admin access messaging", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/app.js`)

    assert.equal(response.status, 200)
    const script = await response.text()
    assert.match(
      script,
      /params\.get\("transactionId"\)\?\.trim\(\)\s*\|\|\s*params\.get\("sessionId"\)\?\.trim\(\)\s*\|\|\s*""/,
    )
    assert.match(
      script,
      /payload\?\.error === "forbidden"\s*\?\s*"You do not have admin access\."\s*:\s*"Unable to verify session\."/,
    )
    assert.match(
      script,
      /payload\?\.error === "forbidden"\s*\?\s*"You do not have admin access\."\s*:\s*payload\?\.error\s*\|\|\s*payload\?\.message\s*\|\|\s*"Browser sign in failed\."/,
    )
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js keeps the stored admin token during transient session verification failures", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/app.js`)

    assert.equal(response.status, 200)
    const script = await response.text()
    assert.match(
      script,
      /const shouldClearToken = payload\?\.error === "unauthorized" \|\| payload\?\.error === "forbidden"/,
    )
    assert.match(
      script,
      /if \(shouldClearToken\) {\s*state\.token = ""\s*localStorage\.removeItem\(STORAGE_KEY\)/,
    )
    assert.match(script, /setStatus\("Session check failed", "stored token kept"\)/)
    assert.doesNotMatch(
      script,
      /state\.token = ""\s*localStorage\.removeItem\(STORAGE_KEY\)\s*showLogin\(/,
    )
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/users includes admin-managed ai access controls in the user editor", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/users`)

    assert.equal(response.status, 200)
    const html = await response.text()
    assert.match(html, /AI access/i)
    assert.match(html, /id="user-ai-access-enabled"/)
    assert.match(html, /id="user-ai-access-provider"/)
    assert.match(html, /id="user-ai-access-credential"/)
    assert.match(html, /id="user-ai-access-default-model"/)
    assert.match(html, /id="user-ai-access-allowed-models"/)
    assert.match(html, /id="user-save-status"/)
    assert.match(html, /<option value="codex_oauth">Codex \/ ChatGPT runtime<\/option>/)
    assert.match(html, /<option value="openai_compatible">OpenAI-compatible provider<\/option>/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/usage includes a credential usage section", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/usage`)

    assert.equal(response.status, 200)
    const html = await response.text()
    assert.match(html, /Credential usage/i)
    assert.match(html, /id="usage-credential-table-body"/)
    assert.match(html, /Codex limits/i)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js renders credential usage and Codex limits status", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/app.js`)

    assert.equal(response.status, 200)
    const script = await response.text()
    assert.match(script, /usageCredentialTableBody/)
    assert.match(script, /credentialUsage/)
    assert.match(script, /formatCredentialUpstreamStatus/)
    assert.match(script, /formatCredentialLimitSummary/)
    assert.match(script, /renderCredentialCodexStatus/)
    assert.match(script, /renderCredentialEligibility/)
    assert.match(script, /all_codex_credentials_exhausted/)
    assert.match(script, /Eligibility status unavailable/)
    assert.match(script, /credential\.provider !== "codex_oauth"[\s\S]*<span class="muted">N\/A<\/span>/)
    assert.match(script, /reasonText = eligibility\.reason === CODEX_EXHAUSTED_REASON/)
    assert.match(script, /escapeHtml\(`\$\{reason\}\$\{reset\}`\.trim\(\)\)/)
    assert.doesNotMatch(script, /eligibility\.state === "exhausted" \? ` \(\$\{CODEX_EXHAUSTED_REASON\}\)`/)
    assert.doesNotMatch(script, /all_codex_credentials_exhausted status unavailable/)
    assert.match(script, /Codex OK, limits unknown/)
    assert.match(script, /5h: unknown/)
    assert.match(script, /Weekly: unknown/)
    assert.match(script, /Codex limits unavailable/)
    assert.match(script, /No upstream status/)
    assert.match(script, /limits\?\.fiveHour/)
    assert.match(script, /limits\?\.weekly/)
    assert.doesNotMatch(script, /if \(!limits\) \{\s*return "";\s*}/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js loads and saves per-user ai access assignments", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/app.js`)

    assert.equal(response.status, 200)
    const script = await response.text()
    assert.match(script, /\/users\/\$\{encodeURIComponent\([^)]+\)\}\/ai-access/)
    assert.match(script, /user-ai-access-provider/)
    assert.match(script, /user-ai-access-credential/)
    assert.match(script, /user-ai-access-default-model/)
    assert.match(script, /user-ai-access-allowed-models/)
    assert.match(script, /availableCredentials/)
    assert.match(script, /Select assigned credential/)
    assert.match(script, /No eligible Codex credential/)
    assert.match(script, /No healthy Codex credentials with OK upstream status are available for assignment\./)
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
      /if \(!wasCreating && selectedUser\?\.id\) \{[\s\S]*await saveUserAiAccess\(selectedUser\.id,\s*aiAccessInput\)/,
    )
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js creates platform credentials from the Credentials page", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/app.js`)

    assert.equal(response.status, 200)
    const script = await response.text()
    assert.match(script, /credential-create-provider/)
    assert.match(script, /credential-create-name/)
    assert.match(script, /credential-create-base-url/)
    assert.match(script, /credential-create-secret/)
    assert.match(script, /credential-create-submit/)
    assert.match(script, /await fetchJson\("\/credentials", \{\s*method: "POST"/)
    assert.match(script, /provider === "openai_compatible"[\s\S]*requestBody\.baseUrl = baseUrl/)
    assert.match(script, /Credential created and attached to the platform pool\./)
    assert.match(
      script,
      /async function createCredential\(\) \{[\s\S]*await fetchJson\("\/credentials", \{\s*method: "POST"[\s\S]*await refreshSelectedUserAiAccessOptions\(\)/,
    )
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js surfaces inline user save and load failures", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/app.js`)

    assert.equal(response.status, 200)
    const script = await response.text()
    assert.match(script, /function setUserSaveStatus\(message, tone = "neutral"\)/)
    assert.match(script, /function findUserByEmail\(email\)/)
    assert.match(script, /That email already exists\. Showing the existing user record instead\./)
    assert.match(script, /Unable to load users:/)
    assert.match(script, /Unable to save user:/)
    assert.match(script, /els\.userSaveButton\.disabled = true/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/api/session returns 401 when no bearer token is present", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/session`)
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: "unauthorized" })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/api/credentials rejects invalid bearer tokens before serving read models", async () => {
  const app = createApp({
    admin: {
      async startBrowserAuth() {
        return {
          authorizeUrl: "https://den.example.test/?desktopOnboarding=1&sid=test",
          sessionId: "session_test",
          expiresAt: null,
        }
      },
      async exchangeBrowserAuth() {
        throw new Error("unused")
      },
      async getSession() {
        throw Object.assign(new Error("forbidden"), { status: 403 })
      },
      async listUsers() {
        return []
      },
      async createUser() {
        throw new Error("unused")
      },
      async updateUser() {
        throw new Error("unused")
      },
      async disableUser() {
        throw new Error("unused")
      },
      async enableUser() {
        throw new Error("unused")
      },
      async deleteUser() {
        return
      },
      async listCredentials() {
        return { credentials: [{ id: "cred_1" }] as never[] }
      },
      async listSessions() {
        return { sessions: [] }
      },
      async getUsage() {
        return {
          summary: { totalTokens: 0, totalRequests: 0 },
          groupBy: "total",
          filters: { credentials: [], users: [], orgs: [] },
          series: [],
          topCredentials: [],
          topUsers: [],
          topOrgs: [],
        }
      },
      async listAlerts() {
        return { alerts: [] }
      },
      async listAudit() {
        return { events: [] }
      },
    },
  })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/credentials`, {
      headers: {
        authorization: "Bearer not-a-real-token",
      },
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: "forbidden" })
  } finally {
    server.close()
    await once(server, "close")
  }
})
