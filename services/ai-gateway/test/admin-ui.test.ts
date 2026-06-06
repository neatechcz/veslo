import assert from "node:assert/strict"
import { once } from "node:events"
import { readFile } from "node:fs/promises"
import type { AddressInfo } from "node:net"
import test from "node:test"

import { createApp } from "../src/index.js"
import { PlatformAdminAllowedPages, PlatformAdminCapabilities } from "../src/http/admin.js"
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
        role: "organization_admin",
      },
    ],
  }
}

function orgAdminSession() {
  return {
    user: {
      id: "user_org_admin",
      email: "org-admin@example.test",
      emailVerified: true,
      name: "Org Admin",
    },
    platformAdmin: false,
    activeOrgId: "org_1",
    organizations: [
      {
        id: "org_1",
        name: "Acme",
        slug: "acme",
        ownerUserId: "user_org_admin",
        role: "organization_admin",
      },
    ],
    capabilities: ["organization", "users"],
    allowedPages: ["organization", "users"],
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
    async listOrganizations() {
      return { organizations: [] }
    },
    async getOrganization() {
      throw new Error("unused")
    },
    async updateOrganization() {
      throw new Error("unused")
    },
    async listOrganizationMembers() {
      return { members: [] }
    },
    async createOrganizationMember() {
      throw new Error("unused")
    },
    async updateOrganizationMember() {
      throw new Error("unused")
    },
    async deleteOrganizationMember() {
      return
    },
    async listOrganizationDomains() {
      return { domains: [] }
    },
    async createOrganizationDomain() {
      throw new Error("unused")
    },
    async updateOrganizationDomain() {
      throw new Error("unused")
    },
    async deleteOrganizationDomain() {
      return
    },
    async listOrganizationInvites() {
      return { invites: [] }
    },
    async createOrganizationInvite() {
      throw new Error("unused")
    },
    async resendOrganizationInvite() {
      throw new Error("unused")
    },
    async revokeOrganizationInvite() {
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

test("GET /admin includes an Organization admin page alongside existing platform pages", async () => {
  const app = createApp({ admin: createAdminServiceStub() })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/organization`, {
      headers: {
        cookie: ADMIN_COOKIE,
      },
    })

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

test("GET /admin shell excludes Sessions navigation and page UI", async () => {
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
    assert.doesNotMatch(html, /href="\/admin\/sessions"/)
    assert.doesNotMatch(html, /data-route="sessions"/)
    assert.doesNotMatch(html, /data-page="sessions"/)
    assert.doesNotMatch(html, /page-sessions/)
    assert.doesNotMatch(html, /18 active sessions/)
    assert.doesNotMatch(html, /Inspect credentials, sessions, usage, alerts, users, and audit events from one place\./)
    assert.doesNotMatch(html, /Collected across sessions, users, and orgs/)
    assert.doesNotMatch(html, /Affected sessions/)
    assert.doesNotMatch(html, /Rebind sessions/)
    assert.doesNotMatch(html, /Session rebinding/)
    assert.doesNotMatch(html, /<option>Session<\/option>/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("AI Gateway admin server defaults exclude Sessions from visible pages and fallback shell", async () => {
  assert.deepEqual(PlatformAdminAllowedPages, ["organization", "users", "credentials", "usage", "alerts", "audit"])
  assert.deepEqual(PlatformAdminCapabilities, [
    "organization",
    "users",
    "credentials",
    "usage",
    "alerts",
    "audit",
    "debugLogs",
    "managedAiUserAccess",
  ])

  const source = await readFile(new URL("../src/http/admin.ts", import.meta.url), "utf8")
  assert.doesNotMatch(source, /<a href="\/admin\/sessions">Sessions<\/a>/)
  assert.doesNotMatch(source, /"sessions",\s*\n\s*"usage"/)
  assert.match(source, /router\.get\("\/admin\/api\/sessions"[\s\S]*requirePlatformAdmin\(res\)/)
})

test("GET /admin/app.js gates organization-admin navigation and platform-only loads by DEN capabilities", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/app.js`)

    assert.equal(response.status, 200)
    const script = await response.text()
    assert.match(script, /const DEFAULT_PAGES = \["organization", "credentials", "usage", "alerts", "users", "audit"\]/)
    assert.match(script, /function allowedPages\(\)/)
    assert.match(script, /function hasCapability\(capability\)/)
    assert.match(script, /function applyAdminCapabilities\(\)/)
    assert.match(script, /runAllowedLoad\("organization", loadOrganization\)/)
    assert.match(script, /runAllowedLoad\("users", loadUsers\)/)
    assert.match(script, /runAllowedLoad\("credentials", loadCredentials\)/)
    assert.doesNotMatch(script, /runAllowedLoad\("sessions", loadSessions\)/)
    assert.doesNotMatch(script, /async function loadSessions\(\)/)
    assert.doesNotMatch(script, /function renderSessions\(\)/)
    assert.doesNotMatch(script, /sessionList:\s*document\.getElementById\("session-list"\)/)
    assert.doesNotMatch(script, /sessionDetail:\s*document\.getElementById\("session-detail"\)/)
    assert.doesNotMatch(script, /selectedSessionId/)
    assert.doesNotMatch(script, /session anomalies/)
    assert.doesNotMatch(script, /New sessions will stop using this credential/)
    assert.doesNotMatch(script, /Active sessions will move to another healthy credential/)
    assert.doesNotMatch(script, /Existing sessions may lose access/)
    assert.match(script, /String\(state\.credentials\.filter\(\(entry\) => !entry\.deletedAt\)\.length\)/)
    assert.match(script, /String\(state\.credentials\.filter\(\(entry\) => !entry\.deletedAt && entry\.state !== "healthy"\)\.length\)/)
    assert.doesNotMatch(script, /String\(state\.credentials\.length\)/)
    assert.match(script, /if \(!hasCapability\("managedAiUserAccess"\)\) \{[\s\S]*return null/)
    assert.match(script, /if \(!hasCapability\("managedAiUserAccess"\)\) \{[\s\S]*return;/)
    assert.match(script, /setActivePage\(firstAllowedPage\(\)\)/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js saves organization membership changes only from the user Save action", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/app.js`)

    assert.equal(response.status, 200)
    const script = await response.text()
    assert.match(script, /function normalizeOrganizationRoleInput\(value\)/)
    assert.match(script, /orgRole:\s*normalizeOrganizationRoleInput\(els\.userRole\.value\)/)
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
    assert.match(script, /<option value="organization_admin">Organization admin<\/option>/)
    assert.match(script, /createUserButtonInline[\s\S]*data-platform-only/)
    assert.doesNotMatch(script, /userRole\.addEventListener\("change"[\s\S]*fetchJson/)
    assert.doesNotMatch(script, /userPlatformAdmin\.addEventListener\("change"[\s\S]*fetchJson/)
    assert.doesNotMatch(script, /userOrg\.addEventListener\("change"[\s\S]*fetchJson/)
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
    assert.match(html, /id="usage-capacity-five-hour"/)
    assert.match(html, /id="usage-capacity-weekly"/)
    assert.match(html, /id="usage-capacity-credentials"/)
    assert.match(html, /Codex limits/i)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("organization admins are forbidden from platform-only gateway admin API routes", async () => {
  const app = createApp({
    admin: createAdminServiceStub({
      async getSession() {
        return orgAdminSession() as unknown as AdminSessionSnapshot
      },
    }),
  })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  const blockedRoutes = [
    ["GET", "/admin/api/credentials"],
    ["GET", "/admin/api/credentials/cred_1/models"],
    ["POST", "/admin/api/credentials"],
    ["DELETE", "/admin/api/credentials/cred_1"],
    ["POST", "/admin/api/credentials/cred_1/revoke"],
    ["POST", "/admin/api/credentials/cred_1/drain"],
    ["POST", "/admin/api/credentials/cred_1/rotate"],
    ["GET", "/admin/api/sessions"],
    ["GET", "/admin/api/usage"],
    ["GET", "/admin/api/alerts"],
    ["POST", "/admin/api/alerts/alert_1/acknowledge"],
    ["POST", "/admin/api/alerts/alert_1/resolve"],
    ["GET", "/admin/api/audit"],
    ["GET", "/admin/api/users/user_1/ai-access"],
    ["PUT", "/admin/api/users/user_1/ai-access"],
    ["POST", "/admin/api/users"],
    ["POST", "/admin/api/users/user_1/disable"],
    ["POST", "/admin/api/users/user_1/enable"],
    ["DELETE", "/admin/api/users/user_1"],
  ] as const

  try {
    const { port } = server.address() as AddressInfo
    for (const [method, path] of blockedRoutes) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          cookie: ADMIN_COOKIE,
          "content-type": "application/json",
        },
        body: method === "GET" ? undefined : JSON.stringify({}),
      })
      assert.equal(response.status, 403, `${method} ${path}`)
      assert.deepEqual(await response.json(), { error: "forbidden" }, `${method} ${path}`)
    }
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("organization admins can access session, users, and organization gateway admin API routes", async () => {
  const app = createApp({
    admin: {
      ...createAdminServiceStub({
        async getSession() {
          return orgAdminSession() as unknown as AdminSessionSnapshot
        },
        async listUsers() {
          return [{
            id: "user_1",
            name: "Member",
            email: "member@example.test",
            emailVerified: true,
            platformAdmin: false,
            disabled: false,
            memberships: [{
              membershipId: "member_1",
              orgId: "org_1",
              orgName: "Acme",
              orgSlug: "acme",
              role: "member",
            }],
          }]
        },
      }),
      async listOrganizations() {
        return {
          organizations: [{
            id: "org_1",
            name: "Acme",
            slug: "acme",
            ownerUserId: "user_org_admin",
            seatLimit: 10,
          }],
        }
      },
      async listOrganizationDomains() {
        return { domains: [] }
      },
      async listOrganizationInvites() {
        return { invites: [] }
      },
    } as any,
  })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const sessionResponse = await fetch(`http://127.0.0.1:${port}/admin/api/session`, {
      headers: { cookie: ADMIN_COOKIE },
    })
    assert.equal(sessionResponse.status, 200)
    assert.deepEqual((await sessionResponse.json()).allowedPages, ["organization", "users"])

    const usersResponse = await fetch(`http://127.0.0.1:${port}/admin/api/users`, {
      headers: { cookie: ADMIN_COOKIE },
    })
    assert.equal(usersResponse.status, 200)
    assert.equal((await usersResponse.json()).users.length, 1)

    const organizationsResponse = await fetch(`http://127.0.0.1:${port}/admin/api/organizations`, {
      headers: { cookie: ADMIN_COOKIE },
    })
    assert.equal(organizationsResponse.status, 200)
    assert.deepEqual((await organizationsResponse.json()).organizations.map((entry: { id: string }) => entry.id), ["org_1"])

    const domainsResponse = await fetch(`http://127.0.0.1:${port}/admin/api/organizations/org_1/domains`, {
      headers: { cookie: ADMIN_COOKIE },
    })
    assert.equal(domainsResponse.status, 200)
    assert.deepEqual(await domainsResponse.json(), { domains: [] })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("POST /admin/api/organizations/:orgId/invites/:inviteId/resend forwards invite resend payloads", async () => {
  let captured: unknown = null
  const admin = createAdminServiceStub() as AdminService & {
    resendOrganizationInvite?: (
      token: string,
      orgId: string,
      inviteId: string,
    ) => Promise<{
      invite: {
        id: string
        orgId: string
        email: string
        role: "member" | "organization_admin"
        status: "pending" | "accepted" | "revoked"
        invitedByUserId: string | null
        acceptedByUserId: string | null
        expiresAt: string | null
        acceptedAt: string | null
        revokedAt: string | null
        createdAt: string
        updatedAt: string
      }
      inviteToken: string
    }>
  }
  admin.resendOrganizationInvite = async (token, orgId, inviteId) => {
    captured = { token, orgId, inviteId }
    return {
      invite: {
        id: inviteId,
        orgId,
        email: "invited@example.test",
        role: "member",
        status: "pending",
        invitedByUserId: "user_admin",
        acceptedByUserId: null,
        expiresAt: null,
        acceptedAt: null,
        revokedAt: null,
        createdAt: "2026-06-06T08:00:00.000Z",
        updatedAt: "2026-06-06T09:00:00.000Z",
      },
      inviteToken: "invite_token_once",
    }
  }
  const app = createApp({ admin })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/organizations/org_1/invites/invite_1/resend`, {
      method: "POST",
      headers: { cookie: ADMIN_COOKIE },
    })

    assert.equal(response.status, 200)
    assert.deepEqual(captured, {
      token: "admin-token",
      orgId: "org_1",
      inviteId: "invite_1",
    })
    assert.deepEqual(await response.json(), {
      invite: {
        id: "invite_1",
        orgId: "org_1",
        email: "invited@example.test",
        role: "member",
        status: "pending",
        invitedByUserId: "user_admin",
        acceptedByUserId: null,
        expiresAt: null,
        acceptedAt: null,
        revokedAt: null,
        createdAt: "2026-06-06T08:00:00.000Z",
        updatedAt: "2026-06-06T09:00:00.000Z",
      },
      inviteToken: "invite_token_once",
    })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("POST /admin/api/organizations/:orgId/invites/:inviteId/resend preserves DEN invite errors", async () => {
  const admin = createAdminServiceStub() as AdminService & {
    resendOrganizationInvite?: () => Promise<never>
  }
  admin.resendOrganizationInvite = async () => {
    throw Object.assign(new Error("invite_already_accepted"), { status: 409 })
  }
  const app = createApp({ admin })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/organizations/org_1/invites/invite_1/resend`, {
      method: "POST",
      headers: { cookie: ADMIN_COOKIE },
    })

    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error: "invite_already_accepted" })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("PATCH /admin/api/users forwards organization membership fields on Save", async () => {
  let capturedInput: unknown = null
  const app = createApp({
    admin: createAdminServiceStub({
      async updateUser(_token, userId, input) {
        capturedInput = input
        return {
          id: userId,
          name: "Member",
          email: "member@example.test",
          emailVerified: true,
          platformAdmin: false,
          disabled: false,
          memberships: [{
            membershipId: "member_1",
            orgId: "org_1",
            orgName: "Acme",
            orgSlug: "acme",
            role: "organization_admin",
          }],
        } as never
      },
    }),
  })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_1`, {
      method: "PATCH",
      headers: {
        cookie: ADMIN_COOKIE,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Member",
        platformAdmin: false,
        orgId: "org_1",
        orgRole: "organization_admin",
      }),
    })

    assert.equal(response.status, 200)
    assert.deepEqual(capturedInput, {
      name: "Member",
      platformAdmin: false,
      orgId: "org_1",
      orgRole: "organization_admin",
    })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("organization admin user Save payloads update only membership fields", async () => {
  let capturedInput: unknown = null
  const app = createApp({
    admin: createAdminServiceStub({
      async getSession() {
        return orgAdminSession() as unknown as AdminSessionSnapshot
      },
      async updateUser(_token, userId, input) {
        capturedInput = input
        return {
          id: userId,
          name: "Member",
          email: "member@example.test",
          emailVerified: true,
          platformAdmin: false,
          disabled: false,
          memberships: [{
            membershipId: "member_1",
            orgId: "org_1",
            orgName: "Acme",
            orgSlug: "acme",
            role: "organization_admin",
          }],
        } as never
      },
    }),
  })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_1`, {
      method: "PATCH",
      headers: {
        cookie: ADMIN_COOKIE,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        orgId: "org_1",
        orgRole: "organization_admin",
      }),
    })

    assert.equal(response.status, 200)
    assert.deepEqual(capturedInput, {
      orgId: "org_1",
      orgRole: "organization_admin",
    })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("organization admin user Save payloads reject platform-only fields", async () => {
  let updateCalled = false
  const app = createApp({
    admin: createAdminServiceStub({
      async getSession() {
        return orgAdminSession() as unknown as AdminSessionSnapshot
      },
      async updateUser() {
        updateCalled = true
        throw new Error("platform-only payload should not be forwarded")
      },
    }),
  })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_1`, {
      method: "PATCH",
      headers: {
        cookie: ADMIN_COOKIE,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Member",
        platformAdmin: false,
        orgId: "org_1",
        orgRole: "organization_admin",
      }),
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: "forbidden" })
    assert.equal(updateCalled, false)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("POST /admin/api/users forwards organization_admin role on create", async () => {
  let capturedInput: unknown = null
  const app = createApp({
    admin: createAdminServiceStub({
      async createUser(_token, input) {
        capturedInput = input
        return {
          id: "user_1",
          name: input.name,
          email: input.email,
          emailVerified: false,
          platformAdmin: false,
          disabled: false,
          memberships: [{
            membershipId: "member_1",
            orgId: "org_1",
            orgName: "Acme",
            orgSlug: "acme",
            role: "organization_admin",
          }],
        } as never
      },
    }),
  })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/users`, {
      method: "POST",
      headers: {
        cookie: ADMIN_COOKIE,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email: "member@example.test",
        name: "Member",
        platformAdmin: false,
        orgId: "org_1",
        orgRole: "organization_admin",
      }),
    })

    assert.equal(response.status, 201)
    assert.deepEqual(capturedInput, {
      email: "member@example.test",
      name: "Member",
      platformAdmin: false,
      orgId: "org_1",
      orgRole: "organization_admin",
    })
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
    assert.match(script, /capacity/)
    assert.match(script, /function renderUsageCapacity\(capacity\)/)
    assert.match(script, /formatCapacityRemaining/)
    assert.match(script, /fiveHourRemainingPercent/)
    assert.match(script, /weeklyRemainingPercent/)
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

test("GET /admin/app.js supports reconnecting Codex credentials in place", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/app.js`)

    assert.equal(response.status, 200)
    const script = await response.text()
    assert.match(script, /credential\.provider === "codex_oauth"[\s\S]*data-credential-action="reconnect"/)
    assert.match(script, /Reconnect \$\{credential\.name\}\? Paste a fresh Codex auth\.json/)
    assert.match(script, /window\.prompt\("Paste the fresh Codex auth\.json/)
    assert.match(script, /\/credentials\/\$\{encodedCredentialId\}\/reconnect/)
    assert.match(script, /body:\s*JSON\.stringify\(\{\s*secret:\s*reconnectSecret/)
    assert.match(script, /await refreshSelectedUserAiAccessOptions\(\)/)
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
