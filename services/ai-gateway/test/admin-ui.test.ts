import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"

import { createApp } from "../src/index.js"
import type {
  AdminService,
  AdminSessionSnapshot,
  AuthPayload,
  BrowserAuthExchangeInput,
  BrowserAuthStartInput,
  BrowserAuthStartPayload,
  CreateCredentialInput,
  CreateUserInput,
  ListCredentialsInput,
  UpdateUserAiAccessInput,
  UpdateUserInput,
  UsageGroupBy,
} from "../src/http/admin.js"

const ADMIN_COOKIE = "veslo.ai-gateway.admin.token=admin-token"

function adminSession(): AdminSessionSnapshot {
  return {
    user: {
      id: "user_admin",
      email: "admin@example.test",
      emailVerified: true,
      name: "Admin User",
    },
    platformAdmin: true,
    activeOrgId: "org_admin",
    organizations: [
      {
        id: "org_admin",
        name: "Admin Org",
        slug: "admin-org",
        ownerUserId: "user_admin",
        role: "owner",
      },
    ],
  }
}

function createAdminServiceStub(overrides: Partial<AdminService> = {}): AdminService {
  const service: AdminService = {
    async startBrowserAuth(_input: BrowserAuthStartInput): Promise<BrowserAuthStartPayload> {
      return {
        authorizeUrl: "https://api.veslo.work/?desktopOnboarding=1&sid=session_test&intent=signin",
        sessionId: "session_test",
        expiresAt: null,
      }
    },
    async exchangeBrowserAuth(_input: BrowserAuthExchangeInput): Promise<AuthPayload> {
      return {
        token: "admin-token",
        denApiBase: "https://api.veslo.work",
        session: adminSession(),
      }
    },
    async getSession(token: string) {
      if (token !== "admin-token") {
        throw Object.assign(new Error("forbidden"), { status: 403 })
      }
      return adminSession()
    },
    async listUsers() {
      return []
    },
    async createUser(_token: string, _input: CreateUserInput) {
      throw new Error("unused")
    },
    async getEligibleCodexCredentialForAutoAssign() {
      return null
    },
    async updateUser(_token: string, _userId: string, _input: UpdateUserInput) {
      throw new Error("unused")
    },
    async getUserAiAccess() {
      return { aiAccess: null, availableCredentials: [] }
    },
    async upsertUserAiAccess(_token: string, _userId: string, _input: UpdateUserAiAccessInput) {
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
    async listCredentials(_token: string, _input?: ListCredentialsInput) {
      return { credentials: [] }
    },
    async listCredentialModels(_token: string, credentialId: string) {
      return { credentialId, models: [] }
    },
    async createCredential(_token: string, _input: CreateCredentialInput, _actorUserId: string | null) {
      throw new Error("unused")
    },
    async revokeCredential() {
      throw new Error("unused")
    },
    async drainCredential() {
      throw new Error("unused")
    },
    async rotateCredential() {
      throw new Error("unused")
    },
    async deleteCredential() {
      throw new Error("unused")
    },
    async listSessions() {
      return { sessions: [] }
    },
    async getUsage(_token: string, input: { groupBy: UsageGroupBy; credentialId: string | null; userId: string | null; orgId: string | null }) {
      return {
        summary: { totalTokens: 0, totalRequests: 0 },
        groupBy: input.groupBy,
        filters: { credentials: [], users: [], orgs: [] },
        series: [],
        topCredentials: [],
        topUsers: [],
        topOrgs: [],
        credentialUsage: [],
      }
    },
    async listAlerts() {
      return { alerts: [] }
    },
    async acknowledgeAlert() {
      throw new Error("unused")
    },
    async resolveAlert() {
      throw new Error("unused")
    },
    async listAudit() {
      return { events: [] }
    },
  }

  return { ...service, ...overrides }
}

test("GET /admin/credentials redirects unauthenticated browsers to the existing Den login page", async () => {
  const calls: BrowserAuthStartInput[] = []
  const app = createApp({
    admin: createAdminServiceStub({
      async startBrowserAuth(input) {
        calls.push(input)
        return {
          authorizeUrl: "https://api.veslo.work/?desktopOnboarding=1&sid=session_test&intent=signin",
          sessionId: "session_test",
          expiresAt: null,
        }
      },
    }),
  })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/credentials`, { redirect: "manual" })

    assert.equal(response.status, 302)
    const location = response.headers.get("location")
    assert.ok(location)
    const redirect = new URL(location)
    assert.equal(redirect.origin, "https://api.veslo.work")
    assert.equal(redirect.searchParams.get("desktopOnboarding"), "1")
    assert.equal(redirect.searchParams.get("sid"), "session_test")
    assert.equal(redirect.searchParams.get("intent"), "signin")
    assert.equal(redirect.searchParams.get("view"), "auth")
    assert.match(response.headers.get("set-cookie") ?? "", /veslo\.ai-gateway\.admin\.browser-auth=/)
    assert.equal(calls.length, 1)
    assert.match(calls[0]!.redirectUri, new RegExp(`^http://127\\.0\\.0\\.1:${port}/admin/credentials$`))
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin callback exchanges Den handoff and returns to the original admin path", async () => {
  const exchanges: BrowserAuthExchangeInput[] = []
  const app = createApp({
    admin: createAdminServiceStub({
      async exchangeBrowserAuth(input) {
        exchanges.push(input)
        return {
          token: "admin-token",
          denApiBase: "https://api.veslo.work",
          session: adminSession(),
        }
      },
    }),
  })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const start = await fetch(`http://127.0.0.1:${port}/admin/credentials`, { redirect: "manual" })
    const pendingCookie = start.headers.get("set-cookie")?.split(";")[0] ?? ""
    assert.match(pendingCookie, /veslo\.ai-gateway\.admin\.browser-auth=/)

    const callback = await fetch(`http://127.0.0.1:${port}/admin/credentials?code=code_123&sessionId=session_test`, {
      redirect: "manual",
      headers: {
        cookie: pendingCookie,
      },
    })

    assert.equal(callback.status, 302)
    assert.equal(callback.headers.get("location"), "/admin/credentials")
    const setCookie = callback.headers.get("set-cookie") ?? ""
    assert.match(setCookie, /veslo\.ai-gateway\.admin\.token=admin-token/)
    assert.match(setCookie, /veslo\.ai-gateway\.admin\.browser-auth=;/)
    assert.equal(exchanges.length, 1)
    assert.equal(exchanges[0]!.code, "code_123")
    assert.equal(exchanges[0]!.sessionId, "session_test")
    assert.match(exchanges[0]!.state, /^[A-Za-z0-9_-]+$/)
    assert.match(exchanges[0]!.codeVerifier, /^[A-Za-z0-9_-]+$/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/credentials serves the admin shell with an admin-only platform credential form", async () => {
  const app = createApp({ admin: createAdminServiceStub() })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/credentials`, {
      headers: {
        cookie: ADMIN_COOKIE,
      },
    })

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
    assert.match(html, /id="credentials-show-deleted"/)
    assert.match(html, /Show deleted/)
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

test("GET /admin shell avoids browser favicon and form-field console issues", async () => {
  const app = createApp({ admin: createAdminServiceStub() })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin`, {
      headers: {
        cookie: ADMIN_COOKIE,
      },
    })

    assert.equal(response.status, 200)
    const html = await response.text()
    assert.match(html, /<link rel="icon" href="data:," \/>/)

    const formFieldsMissingIdOrName = Array.from(
      html.matchAll(/<(input|select|textarea)\b([^>]*)>/gi),
      ([fullTag, _tagName, attributes]) => ({
        fullTag,
        hasId: /\bid=/.test(attributes),
        hasName: /\bname=/.test(attributes),
      }),
    ).filter((field) => !field.hasId && !field.hasName)

    assert.deepEqual(formFieldsMissingIdOrName, [])
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

test("GET /admin serves a bottom-right backend connection status driven by admin API requests", async () => {
  const app = createApp({ admin: createAdminServiceStub() })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const shellResponse = await fetch(`http://127.0.0.1:${port}/admin`, {
      headers: {
        cookie: ADMIN_COOKIE,
      },
    })
    const scriptResponse = await fetch(`http://127.0.0.1:${port}/admin/app.js`)

    assert.equal(shellResponse.status, 200)
    assert.equal(scriptResponse.status, 200)

    const html = await shellResponse.text()
    const script = await scriptResponse.text()

    assert.match(html, /id="backend-connection-status"/)
    assert.match(html, /role="status"/)
    assert.match(html, /aria-live="polite"/)
    assert.match(html, /Connecting to AI Gateway/)
    assert.match(script, /pendingAdminRequests/)
    assert.match(script, /setBackendConnectionStatus\("connecting"/)
    assert.match(script, /Still trying to connect to AI Gateway/)
    assert.match(script, /setBackendConnectionStatus\(\s*"offline"/)
    assert.match(script, /setBackendConnectionStatus\("connected"/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js checks the HTTP-only admin cookie before showing the login panel", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/app.js`)

    assert.equal(response.status, 200)
    const script = await response.text()
    assert.doesNotMatch(script, /if \(!state\.token\) \{\s*showLogin\(\);\s*return;\s*\}/)
    assert.match(script, /validating admin cookie/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/users includes admin-managed ai access controls in the user editor", async () => {
  const app = createApp({ admin: createAdminServiceStub() })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/users`, {
      headers: {
        cookie: ADMIN_COOKIE,
      },
    })

    assert.equal(response.status, 200)
    const html = await response.text()
    assert.match(html, /AI access/i)
    assert.match(html, /id="user-ai-access-enabled"/)
    assert.match(html, /id="user-ai-access-provider"/)
    assert.match(html, /id="user-ai-access-credential"/)
    assert.match(html, /id="user-ai-access-default-model"/)
    assert.match(html, /id="user-ai-access-model-options"/)
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
  const app = createApp({ admin: createAdminServiceStub() })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/usage`, {
      headers: {
        cookie: ADMIN_COOKIE,
      },
    })

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
    assert.match(script, /userAiAccessModelOptions/)
    assert.match(script, /user-ai-access-allowed-models/)
    assert.match(script, /availableCredentials/)
    assert.match(script, /Select assigned credential/)
    assert.match(script, /No eligible Codex credential/)
    assert.match(script, /No healthy Codex credentials with OK upstream status are available for assignment\./)
    assert.match(script, /\/credentials\/\$\{encodeURIComponent\(credentialId\)\}\/models/)
    assert.match(script, /selectedProvider !== "codex_oauth" && selectedProvider !== "openai_compatible"/)
    assert.match(script, /defaultModel:\s*typeof payload\?\.defaultModel === "string" \? payload\.defaultModel\.trim\(\) : ""/)
    assert.match(script, /if \(!els\.userAiAccessDefaultModel\.value\.trim\(\) && payload\.defaultModel\) \{/)
    assert.match(script, /Loaded \$\{payload\.models\.length\} models from the assigned credential\./)
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

test("GET /admin/app.js supports showing and soft-deleting credential archive records", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/app.js`)

    assert.equal(response.status, 200)
    const script = await response.text()
    assert.match(script, /showDeletedCredentials:\s*false/)
    assert.match(script, /credentialsShowDeleted:\s*document\.getElementById\("credentials-show-deleted"\)/)
    assert.match(script, /includeDeleted/)
    assert.match(script, /state\.showDeletedCredentials\s*\?\s*"\?includeDeleted=true"\s*:\s*""/)
    assert.match(script, /credential\.deletedAt \? "deleted" : credential\.state/)
    assert.match(script, /data-credential-action="delete"/)
    assert.match(script, /Delete \$\{credential\.name\}\? This moves it to Show Deleted/)
    assert.match(script, /credentialActionRequest\(credential\.id,\s*action\)/)
    assert.match(script, /method:\s*action === "delete" \? "DELETE" : "POST"/)
    assert.match(script, /state\.showDeletedCredentials = true/)
    assert.match(script, /els\.credentialsShowDeleted\.checked = true/)
    assert.match(script, /credential\.deletedAt[\s\S]*data-route-alerts>Open alerts<\/button>/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js supports renaming credentials and preparing local Codex auth upload", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/app.js`)

    assert.equal(response.status, 200)
    const script = await response.text()
    assert.match(script, /codexAuthUploadByCredentialId/)
    assert.match(script, /data-credential-rename-input/)
    assert.match(script, /data-credential-rename/)
    assert.match(script, /async function renameSelectedCredential\(\)/)
    assert.match(script, /method: "PATCH"/)
    assert.match(script, /data-credential-codex-upload/)
    assert.match(script, /codex-auth-upload-session/)
    assert.match(script, /credential-create-codex-upload/)
    assert.match(script, /async function prepareNewCodexCredentialUpload\(\)/)
    assert.match(script, /await fetchJson\("\/credentials\/codex-auth-upload-session"/)
    assert.match(script, /data-codex-auth-upload-command/)
    assert.match(script, /data-codex-auth-upload-copy/)
    assert.match(script, /async function prepareCodexAuthUpload\(\)/)
    assert.match(script, /async function copyCodexAuthUploadCommand\(\)/)
    assert.match(script, /navigator\.clipboard\.writeText\(command\)/)
    assert.match(script, /await refreshSelectedUserAiAccessOptions\(\)/)
    assert.doesNotMatch(script, /window\.prompt\("Paste the fresh Codex auth\.json/)
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

test("GET /admin/api/session accepts the admin token from an HTTP-only cookie", async () => {
  const app = createApp({ admin: createAdminServiceStub() })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/session`, {
      headers: {
        cookie: ADMIN_COOKIE,
      },
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), adminSession())
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
