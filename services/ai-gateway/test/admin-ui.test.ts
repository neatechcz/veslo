import assert from "node:assert/strict"
import { once } from "node:events"
import { readFile } from "node:fs/promises"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

import { createApp } from "../src/index.js"
import {
  adminFallbackShellHtml,
  createDefaultAdminService,
  PlatformAdminAllowedPages,
  PlatformAdminCapabilities,
} from "../src/http/admin.js"
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
import type { PlatformModelRef } from "../src/model-policy/repository.js"

const ADMIN_COOKIE = "veslo.ai-gateway.admin.token=admin-token"

function topLevelFunctionSource(source: string, name: string): string {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`))
  assert.notEqual(start, -1, name)
  const remainder = source.slice(start + 1)
  const next = remainder.search(/\n(?:async )?function [A-Za-z0-9_]+\(/)
  return source.slice(start, next === -1 ? source.length : start + 1 + next)
}

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
    async getPlatformModelPolicy() {
      return { policy: null }
    },
    async replacePlatformModelPolicy(
      _token: string,
      _input: { enabledModels: PlatformModelRef[]; activeModel: PlatformModelRef },
    ) {
      throw new Error("unused")
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

function organizationMemberFixture(overrides: Partial<{
  membershipId: string
  userId: string
  name: string
  email: string
  role: "member" | "organization_admin"
  status: "active" | "disabled" | "removed"
  createdAt: string
}> = {}) {
  return {
    membershipId: "membership_1",
    userId: "user_1",
    name: "Member One",
    email: "member@example.test",
    role: "member" as const,
    status: "active" as const,
    createdAt: "2026-07-14T08:00:00.000Z",
    ...overrides,
  }
}

test("GET organization members returns only the exact path organization's service response", async () => {
  const requestedOrganizationIds: string[] = []
  const expected = {
    members: [organizationMemberFixture({ membershipId: "membership_exact", userId: "user_exact" })],
  }
  const app = createApp({
    admin: createAdminServiceStub({
      async listOrganizationMembers(_token, orgId) {
        requestedOrganizationIds.push(orgId)
        return expected
      },
    }),
  })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/organizations/org_exact/members`, {
      headers: { cookie: ADMIN_COOKIE },
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), expected)
    assert.deepEqual(requestedOrganizationIds, ["org_exact"])
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("every organization member route rejects a different organization before calling the service", async () => {
  const serviceCalls: string[] = []
  const app = createApp({
    admin: createAdminServiceStub({
      async getSession() {
        return orgAdminSession() as unknown as AdminSessionSnapshot
      },
      async listOrganizationMembers() {
        serviceCalls.push("list")
        return { members: [] }
      },
      async createOrganizationMember() {
        serviceCalls.push("create")
        return { member: organizationMemberFixture() }
      },
      async updateOrganizationMember() {
        serviceCalls.push("update")
        return { member: organizationMemberFixture() }
      },
      async deleteOrganizationMember() {
        serviceCalls.push("delete")
      },
    }),
  })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const requests = [
      { method: "GET", pathname: "/admin/api/organizations/org_2/members" },
      { method: "POST", pathname: "/admin/api/organizations/org_2/members", body: { email: "member@example.test", role: "member" } },
      { method: "PATCH", pathname: "/admin/api/organizations/org_2/members/membership_1", body: { role: "organization_admin" } },
      { method: "DELETE", pathname: "/admin/api/organizations/org_2/members/membership_1" },
    ]

    for (const request of requests) {
      const response = await fetch(`http://127.0.0.1:${port}${request.pathname}`, {
        method: request.method,
        headers: {
          cookie: ADMIN_COOKIE,
          ...(request.body ? { "content-type": "application/json" } : {}),
        },
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      })
      assert.equal(response.status, 403, `${request.method} ${request.pathname}`)
    }
    assert.deepEqual(serviceCalls, [])
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("every organization member route requires organization capability before calling the service", async () => {
  const serviceCalls: string[] = []
  const app = createApp({
    admin: createAdminServiceStub({
      async getSession() {
        return { ...orgAdminSession(), capabilities: ["users"] } as unknown as AdminSessionSnapshot
      },
      async listOrganizationMembers() {
        serviceCalls.push("list")
        return { members: [] }
      },
      async createOrganizationMember() {
        serviceCalls.push("create")
        return { member: organizationMemberFixture() }
      },
      async updateOrganizationMember() {
        serviceCalls.push("update")
        return { member: organizationMemberFixture() }
      },
      async deleteOrganizationMember() {
        serviceCalls.push("delete")
      },
    }),
  })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    for (const request of [
      { method: "GET", pathname: "/admin/api/organizations/org_1/members" },
      { method: "POST", pathname: "/admin/api/organizations/org_1/members", body: { email: "member@example.test", role: "member" } },
      { method: "PATCH", pathname: "/admin/api/organizations/org_1/members/membership_1", body: { role: "member" } },
      { method: "DELETE", pathname: "/admin/api/organizations/org_1/members/membership_1" },
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}${request.pathname}`, {
        method: request.method,
        headers: {
          cookie: ADMIN_COOKIE,
          ...(request.body ? { "content-type": "application/json" } : {}),
        },
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      })
      assert.equal(response.status, 403, `${request.method} ${request.pathname}`)
    }
    assert.deepEqual(serviceCalls, [])
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("member routes use the path organization and scoped fields for authorized administrators", async () => {
  const calls: Array<{ operation: string; token: string; orgId: string; memberId?: string; input?: unknown }> = []
  const admin = createAdminServiceStub({
    async listOrganizationMembers(token, orgId) {
      calls.push({ operation: "list", token, orgId })
      return { members: [organizationMemberFixture()] }
    },
    async createOrganizationMember(token, orgId, input) {
      calls.push({ operation: "create", token, orgId, input })
      return { member: organizationMemberFixture() }
    },
    async updateOrganizationMember(token, orgId, memberId, input) {
      calls.push({ operation: "update", token, orgId, memberId, input })
      return { member: organizationMemberFixture({ membershipId: memberId, role: input.role }) }
    },
    async deleteOrganizationMember(token, orgId, memberId) {
      calls.push({ operation: "delete", token, orgId, memberId })
    },
  })
  const app = createApp({ admin })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const headers = { cookie: ADMIN_COOKIE, "content-type": "application/json" }
    const listResponse = await fetch(`http://127.0.0.1:${port}/admin/api/organizations/org_platform/members`, {
      headers: { cookie: ADMIN_COOKIE },
    })
    assert.equal(listResponse.status, 200, "platform admin may route explicitly")

    admin.getSession = async () => orgAdminSession() as unknown as AdminSessionSnapshot
    const createResponse = await fetch(`http://127.0.0.1:${port}/admin/api/organizations/org_1/members`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        organizationId: "org_body",
        orgId: "org_body",
        email: "new-member@example.test",
        role: "organization_admin",
        platformAdmin: true,
      }),
    })
    assert.equal(createResponse.status, 201)
    const updateResponse = await fetch(`http://127.0.0.1:${port}/admin/api/organizations/org_1/members/membership_path`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        organizationId: "org_body",
        orgId: "org_body",
        role: "member",
        disabled: true,
      }),
    })
    assert.equal(updateResponse.status, 200)
    const deleteResponse = await fetch(`http://127.0.0.1:${port}/admin/api/organizations/org_1/members/membership_path`, {
      method: "DELETE",
      headers: { cookie: ADMIN_COOKIE },
    })
    assert.equal(deleteResponse.status, 204)

    assert.deepEqual(calls, [
      { operation: "list", token: "admin-token", orgId: "org_platform" },
      {
        operation: "create",
        token: "admin-token",
        orgId: "org_1",
        input: { email: "new-member@example.test", role: "organization_admin" },
      },
      {
        operation: "update",
        token: "admin-token",
        orgId: "org_1",
        memberId: "membership_path",
        input: { role: "member" },
      },
      { operation: "delete", token: "admin-token", orgId: "org_1", memberId: "membership_path" },
    ])
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/ai-infrastructure redirects unauthenticated browsers to the existing Den login page", async () => {
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
    const response = await fetch(`http://127.0.0.1:${port}/admin/ai-infrastructure`, { redirect: "manual" })

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
    assert.match(calls[0]!.redirectUri, new RegExp(`^http://127\\.0\\.0\\.1:${port}/admin/ai-infrastructure$`))
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
    const start = await fetch(`http://127.0.0.1:${port}/admin/ai-infrastructure`, { redirect: "manual" })
    const pendingCookie = start.headers.get("set-cookie")?.split(";")[0] ?? ""
    assert.match(pendingCookie, /veslo\.ai-gateway\.admin\.browser-auth=/)

    const callback = await fetch(`http://127.0.0.1:${port}/admin/ai-infrastructure?code=code_123&sessionId=session_test`, {
      redirect: "manual",
      headers: {
        cookie: pendingCookie,
      },
    })

    assert.equal(callback.status, 302)
    assert.equal(callback.headers.get("location"), "/admin/ai-infrastructure")
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

test("GET /admin/ai-infrastructure serves the admin shell with an admin-only platform credential form", async () => {
  const app = createApp({ admin: createAdminServiceStub() })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/ai-infrastructure`, {
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
    assert.match(html, /Codex \/ ChatGPT runtime/)
    assert.match(html, /id="credential-detail-modal"/)
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
    assert.match(script, /const callback = readAuthCallbackParams\(\)/)
    assert.match(script, /finally \{\s*clearAuthCallbackParams\(\);\s*clearPendingBrowserAuth/)
    assert.doesNotMatch(script, /const pending = readPendingBrowserAuth\(callback\.sessionId\);\s*clearAuthCallbackParams\(\)/)
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

test("GET /admin/app.js renders inference readiness from the readiness endpoint", async () => {
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

    assert.match(html, /id="readiness-pill"/)
    assert.match(html, /id="readiness-label"/)
    assert.match(script, /async function loadReadiness\(\)/)
    assert.match(script, /fetch\("\/readiness"\)/)
    assert.match(script, /renderReadiness\(\)/)
    assert.doesNotMatch(html, /Gateway healthy/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin serves one fail-closed loading and error surface without realistic seed data", async () => {
  const app = createApp({ admin: createAdminServiceStub() })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin`, {
      headers: { cookie: ADMIN_COOKIE },
    })

    assert.equal(response.status, 200)
    const html = await response.text()

    assert.equal(html.match(/id="admin-page-state"/g)?.length, 1)
    assert.match(html, /id="admin-page-state"[^>]*aria-busy="true"/)
    assert.match(
      html,
      /id="admin-page-loading"[^>]*role="status"[^>]*aria-live="polite"[^>]*>[\s\S]*?Loading data\.\.\./,
    )
    assert.match(html, /id="admin-page-skeleton"[^>]*class="admin-page-skeleton"[^>]*aria-hidden="true"/)
    assert.match(html, /id="admin-page-error"[^>]*class="[^"]*hidden[^"]*"[^>]*role="alert"/)
    assert.match(html, /id="admin-page-error-message"/)
    assert.match(html, /id="admin-page-retry"[^>]*>Retry<\/button>/)
    assert.doesNotMatch(html, /id="app-panel"[^>]*aria-live=/)

    const skeletonStart = html.indexOf('<div id="admin-page-skeleton"')
    const skeletonEnd = html.indexOf("<!-- /admin-page-skeleton -->", skeletonStart)
    assert.notEqual(skeletonStart, -1)
    assert.notEqual(skeletonEnd, -1)
    const skeleton = html.slice(skeletonStart, skeletonEnd)
    assert.equal(skeleton.replace(/<[^>]*>/g, "").trim(), "")
    assert.doesNotMatch(skeleton, /aria-label=|data-[\w-]+=|style=/)

    assert.doesNotMatch(html, /<strong>\s*(?:18|2|41)\s*<\/strong>/)
    for (const realisticSeed of [
      "Stable",
      "2 credential alerts",
      "Credential outage",
      "Usage spike",
      "Vaclav Soukup",
      "Václav Soukup",
      "Alena Novak",
      "Martin Kriz",
      "821k",
      "412k",
      "OpenAI org key",
      "Anthropic shared key",
      "route_1884",
      "+12% vs yesterday",
      "Credential inventory will load after sign-in.",
      "Credential usage will load after sign-in.",
    ]) {
      assert.doesNotMatch(html, new RegExp(realisticSeed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    }
    for (const hostId of [
      "organization-directory-list", "organization-domain-list", "organization-invite-list",
      "organization-billing-summary", "organization-audit-list", "model-policy-list",
      "credentials-table-body", "usage-capacity-five-hour", "usage-capacity-five-hour-note",
      "usage-capacity-weekly", "usage-capacity-weekly-note", "usage-capacity-measured",
      "usage-capacity-measured-note", "usage-capacity-credentials", "usage-chart-bars",
      "usage-total-tokens", "usage-total-requests", "usage-top-credential", "usage-series",
      "usage-credential-table-body", "alert-list", "user-list", "audit-list",
    ]) {
      assert.match(html, new RegExp(`id="${hostId}"[^>]*>\\s*<\\/`), hostId)
    }

    for (const controlId of [
      "organization-save-button", "organization-name", "organization-seat-limit",
      "organization-domain-add-button", "organization-invite-send-button", "organization-billing-interval",
      "organization-billing-basic", "organization-billing-extended", "organization-billing-checkout",
      "organization-billing-plan-save", "organization-billing-portal", "organization-billing-cancel",
      "organization-billing-platform-mode", "organization-billing-platform-status",
      "organization-billing-manual-enabled", "organization-billing-manual-expires",
      "organization-billing-platform-save", "model-policy-save-button", "model-policy-credential",
      "model-policy-discover-button", "model-policy-discovered-model", "model-policy-add-button",
      "credential-search", "credential-provider-filter", "credential-state-filter", "credentials-show-deleted",
      "credential-create-provider", "credential-create-name", "credential-create-base-url",
      "credential-create-secret", "credential-create-submit", "credential-create-codex-upload",
      "usage-group-by", "usage-filter-credential", "usage-filter-user", "usage-filter-org",
      "create-user-button-inline", "user-search", "user-status-filter", "user-role-filter",
      "audit-search", "audit-date-range", "audit-actor-filter", "audit-entity-filter",
    ]) {
      assert.match(html, new RegExp(`id="${controlId}"[^>]*disabled`), controlId)
    }
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js atomically isolates route generations and keeps readiness in the background", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const script = await (await fetch(`http://127.0.0.1:${port}/admin/app.js`)).text()

    for (const importedName of [
      "beginAdminPageLoad", "completeAdminPageLoad", "createAdminPageLoadState",
      "failAdminPageLoad", "isAdminPageLoadCurrent",
    ]) {
      assert.match(script, new RegExp(`\\b${importedName}\\b`), importedName)
    }
    assert.match(script, /from "\.\/admin-page-load-state\.js"/)
    assert.match(script, /pageLoad:\s*createAdminPageLoadState\(\)/)
    assert.match(script, /organizationDirectory:\s*\[\]/)
    assert.match(script, /organizationMembers:\s*\[\]/)
    assert.equal(script.match(/let routeLoadAbortController = null;/g)?.length, 1)
    assert.doesNotMatch(script, /organizationLoadAbortController/)

    assert.match(script, /function beginRouteDataLoad\(route\)/)
    assert.match(script, /beginRouteDataLoad\(route\)[\s\S]*routeLoadAbortController\?\.abort\(\)[\s\S]*beginAdminPageLoad\(state\.pageLoad, route\)[\s\S]*closeAllModals\(\)[\s\S]*clearRouteOwnedState\(\)[\s\S]*renderAdminPageState\(\)[\s\S]*renderRoute\(\)/)
    assert.match(script, /renderAdminPageState\(\);\s*renderRoute\(\);\s*setRouteActionsDisabled\(true\);\s*return request/)
    assert.match(script, /function clearRouteOwnedState\(\)[\s\S]*state\.credentials = \[\][\s\S]*state\.alerts = \[\][\s\S]*state\.audit = \[\][\s\S]*state\.users = \[\][\s\S]*state\.organizationDirectory = \[\][\s\S]*state\.organizationMembers = \[\][\s\S]*state\.organizationDomains = \[\][\s\S]*state\.organizationInvites = \[\][\s\S]*state\.organizationBilling = null[\s\S]*state\.organizationAudit = \[\][\s\S]*state\.usage = null/)
    for (const selectedState of [
      "selectedCredentialId", "selectedAlertId", "selectedAuditId", "selectedUserId",
      "selectedOrganizationMemberId", "selectedOrganizationDomainId", "selectedOrganizationInviteId",
    ]) {
      assert.match(script, new RegExp(`state\\.${selectedState} = null`), selectedState)
    }
    assert.match(script, /function currentRouteSubjects\(\)/)
    assert.match(script, /function finishRouteDataLoad\(request, result, empty, focusHeading\)[\s\S]*isAdminPageLoadCurrent\(state\.pageLoad, request\)[\s\S]*completeAdminPageLoad\(state\.pageLoad, request, empty\)[\s\S]*Object\.assign\(state, result\)[\s\S]*renderCurrentRouteData\(\)[\s\S]*renderAdminPageState\(\)[\s\S]*applyAdminCapabilities\(\)/)
    assert.match(script, /function failRouteDataLoad\(request, error\)[\s\S]*AbortError[\s\S]*401[\s\S]*showLogin\([\s\S]*403[\s\S]*Access denied[\s\S]*404[\s\S]*Organization not found[\s\S]*Unable to load data[\s\S]*renderAdminPageState\(\)/)
    assert.match(script, /fetchJson\([^\n]+\{ signal \}\)/)
    assert.match(script, /Promise\.all\(/)
    assert.match(script, /adminPageRetry\.addEventListener\("click", \(\) => void loadRouteData\(state\.route\)\)/)
    assert.match(script, /showApp\(\);\s*void loadReadiness\(\);\s*await loadRouteData\(state\.route, activeLoad\)/)
    assert.doesNotMatch(script, /async function loadRouteData\(route, activeLoad = null\)[\s\S]{0,360}await loadReadiness\(\)/)
    assert.match(script, /function renderAdminPageState\(\)[\s\S]*aria-busy[\s\S]*Access denied|function renderAdminPageState\(\)/)
    assert.match(script, /function setRouteActionsDisabled\(disabled\)/)
    for (const loaderName of ["loadCredentials", "loadAlerts", "loadAudit", "loadUsers", "loadUsage", "loadUserAiAccess"]) {
      const loader = topLevelFunctionSource(script, loaderName)
      assert.match(loader, /beginCurrentRouteMutation\(/, `${loaderName} begins a route mutation`)
      assert.match(loader, /isCurrentRouteMutation\(/, `${loaderName} guards late completion`)
    }
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js keeps an empty organization member route renderable", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const script = await (await fetch(`http://127.0.0.1:${port}/admin/app.js`)).text()
    const userStatus = topLevelFunctionSource(script, "userStatus")
    const renderUsers = topLevelFunctionSource(script, "renderUsers")

    assert.match(renderUsers, /populateUserEditor\(currentUser\(\)\)/)
    assert.match(userStatus, /if \(!user\) return "No user selected"/)
    assert.ok(
      userStatus.indexOf("if (!user)") < userStatus.indexOf('user.status'),
      "the empty selection guard must run before organization member status is read",
    )
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js keeps organization workspace data and member actions path scoped", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const script = await (await fetch(`http://127.0.0.1:${port}/admin/app.js`)).text()
    const workspaceLoader = topLevelFunctionSource(script, "loadOrganizationWorkspace")
    const platformLoader = topLevelFunctionSource(script, "loadPlatformRouteResult")
    const routeSubjects = topLevelFunctionSource(script, "currentRouteSubjects")
    const memberAdapter = topLevelFunctionSource(script, "organizationMemberToRouteSubject")
    const saveUser = topLevelFunctionSource(script, "saveUser")
    const loadUsers = topLevelFunctionSource(script, "loadUsers")
    const finishRoute = topLevelFunctionSource(script, "finishRouteDataLoad")
    const clearRoute = topLevelFunctionSource(script, "clearRouteOwnedState")

    assert.match(workspaceLoader, /fetchJson\(`\/organizations\/\$\{encodedOrganizationId\}`[^\n]*\{ signal \}\)/)
    assert.match(workspaceLoader, /fetchJson\(`\/organizations\/\$\{encodedOrganizationId\}\/members`[^\n]*\{ signal \}\)/)
    assert.doesNotMatch(workspaceLoader, /fetchJson\("\/organizations"/)
    assert.doesNotMatch(workspaceLoader, /fetchJson\("\/users"/)
    assert.match(workspaceLoader, /route\.page === "domains-invites"[\s\S]*\/domains[\s\S]*\/invites/)
    assert.match(workspaceLoader, /route\.page === "members" \|\| route\.page === "ai-access"[\s\S]*\/members/)
    assert.match(workspaceLoader, /await Promise\.all\(requests\)/)
    assert.match(workspaceLoader, /organizationMembers:\s*\[\]/)
    assert.match(workspaceLoader, /result\.organizationMembers = Array\.isArray\(routePayloads\[0\]\?\.members\)/)
    assert.doesNotMatch(workspaceLoader, /result\.users\s*=/)

    assert.equal(platformLoader.match(/fetchJson\("\/users"/g)?.length, 2)
    assert.match(platformLoader, /route\.page === "overview"[\s\S]*fetchJson\("\/users"/)
    assert.match(platformLoader, /route\.page === "platform-users"[\s\S]*fetchJson\("\/users"/)
    assert.match(loadUsers, /state\.route\?\.area !== "platform"[\s\S]*state\.route\.page !== "platform-users"[\s\S]*return/)

    assert.match(routeSubjects, /state\.route\?\.area === "organization"/)
    assert.match(routeSubjects, /state\.organizationMembers\.map\(\(member\) => organizationMemberToRouteSubject\(member,/)
    assert.match(routeSubjects, /return state\.users/)
    for (const field of ["membershipId", "userId", "name", "email", "role", "status"]) {
      assert.match(memberAdapter, new RegExp(`\\b${field}\\b`), field)
    }
    assert.match(memberAdapter, /orgId:\s*organization\.id/)
    assert.match(memberAdapter, /orgName:\s*organization\.name\s*\|\|\s*organization\.id/)
    assert.doesNotMatch(memberAdapter, /organization\.slug/)
    assert.doesNotMatch(memberAdapter, /\borgSlug\s*:/)
    assert.match(memberAdapter, /platformAdmin:\s*false/)

    assert.match(finishRoute, /Array\.isArray\(result\.organizationMembers\)[\s\S]*result\.selectedUserId = result\.organizationMembers\[0\]\?\.userId \|\| null/)
    assert.match(finishRoute, /result\.selectedOrganizationMemberId = result\.organizationMembers\[0\]\?\.membershipId \|\| null/)
    assert.match(clearRoute, /state\.organizationMembers = \[\][\s\S]*state\.selectedUserId = null[\s\S]*state\.selectedOrganizationMemberId = null/)

    assert.match(saveUser, /state\.route\?\.area === "organization"[\s\S]*state\.route\.page === "members"/)
    assert.match(saveUser, /`\/organizations\/\$\{encodeURIComponent\(organizationId\)\}\/members\/\$\{encodeURIComponent\(targetUser\.membershipId\)\}`/)
    assert.match(saveUser, /method:\s*"PATCH"[\s\S]*body:\s*JSON\.stringify\(\{ role: membershipRole \}\)/)
    assert.match(saveUser, /state\.organizationMembers = state\.organizationMembers\.map/)

    assert.match(script, /organizationDirectoryCache:\s*\[\]/)
    assert.match(script, /function refreshOrganizationChromeDirectory\(/)
    assert.match(script, /state\.session\?\.organizations/)
    assert.match(script, /state\.organizationDirectoryCache/)
    assert.match(script, /result\.organizationDirectory[\s\S]*state\.organizationDirectoryCache = \[\.\.\.result\.organizationDirectory\]/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js clears a visible route before refresh session verification starts", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const script = await (await fetch(`http://127.0.0.1:${port}/admin/app.js`)).text()
    const bootstrap = topLevelFunctionSource(script, "bootstrapSession")
    const beginIndex = bootstrap.indexOf("beginRouteDataLoad(state.route)")
    const sessionIndex = bootstrap.indexOf('api("/session"')

    assert.notEqual(beginIndex, -1)
    assert.notEqual(sessionIndex, -1)
    assert.ok(beginIndex < sessionIndex, "visible route load must begin before /session")
    assert.match(bootstrap, /refreshVisibleRoute[\s\S]*activeLoad/)
    assert.match(bootstrap, /loadRouteData\(state\.route, activeLoad\)/)
    assert.match(bootstrap, /abandonRouteDataLoad\(activeLoad\)[\s\S]*showLogin\(/)
    assert.match(script, /refreshButton\.addEventListener\("click", \(\) => void bootstrapSession\(\{ refreshVisibleRoute: true \}\)\)/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js loading lock disables page, topbar, and organization context actions", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const script = await (await fetch(`http://127.0.0.1:${port}/admin/app.js`)).text()
    const disabling = topLevelFunctionSource(script, "setRouteActionsDisabled")

    assert.match(disabling, /if \(!disabled\) return/)
    assert.match(disabling, /routeOwnedControls/)
    assert.match(disabling, /page\.inert = true/)
    assert.doesNotMatch(disabling, /appPanel\.inert = true/)
    assert.match(disabling, /els\.refreshButton\.disabled = true/)
    assert.match(disabling, /els\.createUserButton\.disabled = true/)
    assert.match(disabling, /els\.createUserButtonInline\.disabled = true/)
    assert.match(disabling, /els\.organizationSelectorInput\.disabled = true/)
    assert.match(script, /beginRouteDataLoad\(route\)[\s\S]*setRouteActionsDisabled\(true\)/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js releases only capability-permitted controls after atomic render", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const script = await (await fetch(`http://127.0.0.1:${port}/admin/app.js`)).text()
    const finish = topLevelFunctionSource(script, "finishRouteDataLoad")
    const release = topLevelFunctionSource(script, "releaseRouteActionsForCurrentRoute")
    const orderedSteps = [
      "completeAdminPageLoad(state.pageLoad, request, empty)",
      "Object.assign(state, result)",
      "renderCurrentRouteData()",
      "renderAdminPageState()",
      "applyAdminCapabilities()",
      "releaseRouteActionsForCurrentRoute({ focusHeading })",
    ]
    let previous = -1
    for (const step of orderedSteps) {
      const index = finish.indexOf(step)
      assert.ok(index > previous, `${step} must follow the prior completion step`)
      previous = index
    }
    assert.match(script, /routeActionsLocked:\s*true/)
    assert.match(release, /adminUserRoutePermissions\(state\.route, routeAccessSnapshot\(\)\)/)
    assert.match(release, /canPerformAdminRouteAction\(\s*state\.route,\s*routeAccessSnapshot\(\),/)
    assert.doesNotMatch(release, /routeOwnedControls[\s\S]*disabled = false/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js synchronously clears credential secrets and generated commands", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const script = await (await fetch(`http://127.0.0.1:${port}/admin/app.js`)).text()
    const clearDom = topLevelFunctionSource(script, "clearRouteOwnedDom")
    const clearState = topLevelFunctionSource(script, "clearRouteOwnedState")
    const beginLoad = topLevelFunctionSource(script, "beginRouteDataLoad")

    for (const field of ["credentialCreateName", "credentialCreateBaseUrl", "credentialCreateSecret", "credentialCreateCodexCommand"]) {
      assert.match(clearDom, new RegExp(`els\\.${field}\\.value = ""`), field)
    }
    assert.match(clearDom, /els\.credentialCreateStatus\.textContent = ""/)
    assert.match(clearDom, /els\.modelPolicyStatus\.textContent = ""/)
    assert.match(clearDom, /delete els\.credentialCreateStatus\.dataset\.tone/)
    assert.match(clearDom, /delete els\.modelPolicyStatus\.dataset\.tone/)
    assert.match(clearDom, /els\.credentialCreateCodexCommand\.classList\.add\("hidden"\)/)
    assert.match(clearDom, /els\.credentialCreateCodexCopy\.classList\.add\("hidden"\)/)
    assert.match(clearDom, /els\.credentialCreateCodexCopy\.disabled = true/)
    assert.match(clearDom, /els\.credentialCreateCodexCommand\.disabled = true/)
    assert.match(clearState, /state\.codexAuthCredentialUpload = null/)
    assert.match(clearState, /state\.codexAuthUploadByCredentialId = \{\}/)
    assert.match(clearState, /modelDiscoveryAbortController\?\.abort\(\)[\s\S]*modelDiscoveryAbortController = null/)
    assert.ok(beginLoad.indexOf("clearRouteOwnedState()") < beginLoad.indexOf("renderAdminPageState()"))
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js binds every async admin mutation to the current page generation", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const script = await (await fetch(`http://127.0.0.1:${port}/admin/app.js`)).text()
    assert.match(script, /function beginCurrentRouteMutation\(key, route = state\.route\)/)
    assert.match(script, /beginAdminRouteMutation\(state\.mutations, key, route, state\.pageLoad\)/)
    assert.match(script, /function isCurrentRouteMutation\(mutation\)/)
    assert.match(script, /isAdminRouteMutationCurrent\(state\.mutations, mutation, state\.route, state\.pageLoad\)/)

    for (const functionName of [
      "saveModelPolicy", "discoverModelsForPolicy", "createCredential", "prepareNewCodexCredentialUpload",
      "copyNewCodexCredentialUploadCommand", "runCredentialAction", "renameSelectedCredential",
      "prepareCodexAuthUpload", "copyCodexAuthUploadCommand", "runAlertAction",
      "runOrganizationBillingAction", "saveOrganization", "saveOrganizationDomainModal", "deleteOrganizationDomain",
      "createOrganizationInvite", "resendOrganizationInvite", "revokeOrganizationInvite", "saveUser",
      "saveUserAiAccess", "toggleUserDisabled", "deleteUser",
    ]) {
      const source = topLevelFunctionSource(script, functionName)
      assert.match(source, /beginCurrentRouteMutation\(/, `${functionName} captures page generation`)
      assert.match(source, /isCurrentRouteMutation\(/, `${functionName} guards completion`)
    }

    for (const functionName of ["refreshCredentialOperations", "refreshAlertOperations", "refreshSelectedUserAiAccessOptions", "loadOrganization"]) {
      const source = topLevelFunctionSource(script, functionName)
      assert.match(source, /mutation = beginCurrentRouteMutation\(/, `${functionName} accepts one captured context`)
    }
    for (const functionName of ["loadCredentials", "loadAlerts", "loadAudit", "loadUsers", "loadUsage", "loadUserAiAccess"]) {
      const source = topLevelFunctionSource(script, functionName)
      const guardIndex = source.indexOf("isCurrentRouteMutation(")
      const requestIndex = source.indexOf("await fetchJson(")
      assert.ok(guardIndex !== -1 && guardIndex < requestIndex, `${functionName} rejects stale parent context before request`)
    }
    assert.doesNotMatch(script, /await refreshCredentialOperations\(\);/)
    assert.doesNotMatch(script, /await refreshAlertOperations\(\);/)
    assert.doesNotMatch(script, /await refreshSelectedUserAiAccessOptions\(\);/)
    assert.doesNotMatch(script, /await loadOrganization\(\);/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js signs out fail-closed before the best-effort network request", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const script = await (await fetch(`http://127.0.0.1:${port}/admin/app.js`)).text()
    const signOut = topLevelFunctionSource(script, "signOut")
    const networkIndex = signOut.indexOf("await clearServerAdminSession(token)")
    assert.notEqual(networkIndex, -1)
    for (const step of [
      "routeLoadAbortController?.abort()",
      "modelDiscoveryAbortController?.abort()",
      "closeAllModals()",
      "clearRouteOwnedState()",
      "setRouteActionsDisabled(true)",
      "showLogin(",
      "localStorage.removeItem(STORAGE_KEY)",
    ]) {
      const index = signOut.indexOf(step)
      assert.notEqual(index, -1, step)
      assert.ok(index < networkIndex, `${step} must occur before sign-out network`)
    }
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js releases Codex Copy only for a current prepared command", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const script = await (await fetch(`http://127.0.0.1:${port}/admin/app.js`)).text()
    const renderUpload = topLevelFunctionSource(script, "renderNewCodexCredentialUpload")
    const prepare = topLevelFunctionSource(script, "prepareNewCodexCredentialUpload")
    const release = topLevelFunctionSource(script, "releaseRouteActionsForCurrentRoute")

    assert.match(renderUpload, /credentialCreateCodexCopy\.disabled = !command/)
    assert.match(renderUpload, /credentialCreateCodexCommand\.disabled = !command/)
    assert.match(renderUpload, /credentialCreateCodexCopy\.classList\.toggle\("hidden", !command\)/)
    assert.match(renderUpload, /credentialCreateCodexCommand\.classList\.toggle\("hidden", !command\)/)
    assert.match(prepare, /isCurrentRouteMutation\(mutation\)[\s\S]*state\.codexAuthCredentialUpload = payload[\s\S]*renderNewCodexCredentialUpload\(\)/)
    assert.match(release, /renderNewCodexCredentialUpload\(\)/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js focuses terminal errors and successful destination headings", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const script = await (await fetch(`http://127.0.0.1:${port}/admin/app.js`)).text()
    const pageState = topLevelFunctionSource(script, "renderAdminPageState")
    const release = topLevelFunctionSource(script, "releaseRouteActionsForCurrentRoute")
    const readiness = topLevelFunctionSource(script, "loadReadiness")

    assert.match(pageState, /if \(error\)[\s\S]*adminPageError\.tabIndex = -1[\s\S]*adminPageError\.focus\(/)
    assert.match(release, /focusHeading[\s\S]*pageTitle\.tabIndex = -1[\s\S]*pageTitle\.focus\(\{ preventScroll: true \}\)/)
    assert.match(script, /beginRouteDataLoad\(route\)[\s\S]*const focusHeading = !previousKey \|\| previousKey !== request\?\.key/)
    assert.match(script, /finishRouteDataLoad\(request, result, empty, focusHeading\)[\s\S]*releaseRouteActionsForCurrentRoute\(\{ focusHeading \}\)/)
    assert.doesNotMatch(readiness, /\.focus\(/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js opens Create User only for the owning Platform Users generation", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const script = await (await fetch(`http://127.0.0.1:${port}/admin/app.js`)).text()
    const enter = topLevelFunctionSource(script, "enterCreateMode")
    const load = topLevelFunctionSource(script, "loadRouteData")

    assert.match(script, /function isRouteLoadResultCurrent\(result, route\)/)
    assert.match(enter, /const targetRoute = toPlatformRoute\("platform-users"\)/)
    assert.match(enter, /formatAdminRoute\(state\.route\) === formatAdminRoute\(targetRoute\)[\s\S]*state\.pageLoad\.status === "ready" \|\| state\.pageLoad\.status === "empty"/)
    assert.match(enter, /await setAdminRoute\(targetRoute\)/)
    assert.match(enter, /if \(!isRouteLoadResultCurrent\(routeLoad, targetRoute\)\) return;[\s\S]*openUserEditor\(null\)/)
    assert.doesNotMatch(enter, /\.then\(/)
    assert.match(load, /return completed \? routeLoad : null/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js rejects stale AI access selection completions and errors", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const script = await (await fetch(`http://127.0.0.1:${port}/admin/app.js`)).text()
    const selection = topLevelFunctionSource(script, "loadSelectedUserAiAccess")
    const loadAccess = topLevelFunctionSource(script, "loadUserAiAccess")

    assert.match(selection, /const selectedUserId = state\.selectedUserId/)
    assert.match(selection, /const mutation = beginCurrentRouteMutation\(`user-ai-access-selection:\$\{selectedUserId\}`\)/)
    assert.ok(selection.indexOf("selectedUserId = state.selectedUserId") < selection.indexOf("await loadUserAiAccess(selectedUserId, mutation)"))
    assert.match(loadAccess, /const selection = captureAiAccessMemberSelection\(resolvedUserId\)/)
    assert.match(loadAccess, /if \(!selection \|\| !isCurrentRouteMutation\(activeMutation\)\) return null;/)
    assert.match(loadAccess, /if \(!isCurrentRouteMutation\(activeMutation\) \|\| !isAiAccessMemberSelectionCurrent\(selection\)\) return null;/)
    assert.match(loadAccess, /catch \(error\)[\s\S]*if \(!isCurrentRouteMutation\(activeMutation\) \|\| !isAiAccessMemberSelectionCurrent\(selection\)\) return null;[\s\S]*throw error/)
    assert.match(selection, /if \(!isCurrentRouteMutation\(mutation\) \|\| state\.selectedUserId !== selectedUserId\) return;/)
    assert.match(selection, /catch[\s\S]*if \(!isCurrentRouteMutation\(mutation\) \|\| state\.selectedUserId !== selectedUserId\) return;[\s\S]*Unable to load AI access assignment/)
    assert.match(script, /openUserEditor\(card\.dataset\.userId\);\s*void loadSelectedUserAiAccess\(\);/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.css softens only neutral skeletons and keeps page-state actions accessible", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/app.css`)

    assert.equal(response.status, 200)
    const css = await response.text()
    assert.match(css, /--admin-skeleton-fill:/)
    assert.match(css, /\.admin-page-skeleton\s*\{[^}]*filter:\s*blur\(/s)
    assert.match(css, /\.admin-page-skeleton-shape\s*\{[^}]*background:\s*var\(--admin-skeleton-fill\)/s)
    assert.match(css, /#admin-page-state\[data-state="loading"\]\s*~\s*\[data-page\][\s\S]*?#admin-page-state\[data-state="error"\]\s*~\s*\[data-page\][^{]*\{[^}]*display:\s*none\s*!important/s)
    assert.match(css, /#admin-page-loading[\s\S]*#admin-page-error\s*\{[^}]*filter:\s*none/s)
    assert.match(css, /#admin-page-retry:focus-visible\s*\{[^}]*outline:/s)
    assert.doesNotMatch(css, /\[data-page\][^{]*\{[^}]*filter:\s*blur\(/s)
    assert.match(
      css,
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.admin-page-skeleton-shape\s*\{[^}]*animation:\s*none/s,
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

test("GET /admin/platform-users keeps model choice out of the admin-managed user access editor", async () => {
  const app = createApp({ admin: createAdminServiceStub() })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/platform-users`, {
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
    assert.doesNotMatch(html, /id="user-ai-access-default-model"/)
    assert.doesNotMatch(html, /id="user-ai-access-model-options"/)
    assert.doesNotMatch(html, /id="user-ai-access-allowed-models"/)
    assert.doesNotMatch(html, />Default model</i)
    assert.doesNotMatch(html, />Allowed models</i)
    assert.match(html, /Models are managed centrally in AI Infrastructure/i)
    assert.match(html, /id="user-save-status"/)
    assert.match(html, /<option value="codex_oauth">Codex \/ ChatGPT runtime<\/option>/)
    assert.match(html, /<option value="openai_compatible">OpenAI-compatible provider<\/option>/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/ai-infrastructure presents platform model policy controls", async () => {
  const app = createApp({ admin: createAdminServiceStub() })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/ai-infrastructure`, {
      headers: { cookie: ADMIN_COOKIE },
    })

    assert.equal(response.status, 200)
    const html = await response.text()
    assert.match(html, /data-platform-route="ai-infrastructure"[^>]*>AI Infrastructure</)
    assert.match(html, /id="model-policy-panel"[^>]*data-platform-admin-control/)
    assert.match(html, /id="model-policy-list"/)
    assert.match(html, /id="model-policy-credential"/)
    assert.match(html, /id="model-policy-discovered-model"/)
    assert.match(html, /id="model-policy-discover-button"/)
    assert.match(html, /id="model-policy-add-button"/)
    assert.match(html, /id="model-policy-save-button"[^>]*>Save model policy</)
    assert.match(html, /id="model-policy-status"[^>]*role="status"[^>]*aria-live="polite"/)
    assert.match(html, /id="model-policy-panel"[^>]*aria-busy="false"/)
    assert.doesNotMatch(html, /Choose your model|Switch models?|model picker/i)

    const stateModuleResponse = await fetch(`http://127.0.0.1:${port}/admin/model-policy-editor-state.js`)
    assert.equal(stateModuleResponse.status, 200)
    assert.match(await stateModuleResponse.text(), /export function beginModelPolicySave/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin serves every JavaScript module imported by app.js as JavaScript", async () => {
  const app = createApp({ admin: createAdminServiceStub() })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${port}`
    const headers = { cookie: ADMIN_COOKIE }
    const entryResponse = await fetch(`${baseUrl}/admin/app.js`, { headers })

    assert.equal(entryResponse.status, 200)
    assert.match(entryResponse.headers.get("content-type") ?? "", /(?:java|ecma)script/i)

    const entryScript = await entryResponse.text()
    const fromImportPaths = [...entryScript.matchAll(/\bfrom\s+(["'])(\.\/[^"'?]+\.js)\1/g)]
      .map((match) => match[2])
    const sideEffectImportPaths = [...entryScript.matchAll(/\bimport\s+(["'])(\.\/[^"'?]+\.js)\1/g)]
      .map((match) => match[2])
    const importedModulePaths = [
      ...new Set(
        [...fromImportPaths, ...sideEffectImportPaths]
          .map((modulePath) => modulePath?.slice(2))
          .filter((modulePath): modulePath is string => Boolean(modulePath)),
      ),
    ]

    assert.ok(importedModulePaths.length > 0, "app.js must expose at least one relative JavaScript import")

    for (const modulePath of importedModulePaths) {
      const pathname = `/admin/${modulePath}`
      const moduleResponse = await fetch(`${baseUrl}${pathname}`, { headers })

      assert.equal(moduleResponse.status, 200, pathname)
      assert.match(moduleResponse.headers.get("content-type") ?? "", /(?:java|ecma)script/i, pathname)
      assert.doesNotMatch(await moduleResponse.text(), /^\s*<!doctype html>/i, pathname)
    }
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin shell separates platform administration from organization workspaces", async () => {
  const app = createApp({ admin: createAdminServiceStub() })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin`, { headers: { cookie: ADMIN_COOKIE } })
    assert.equal(response.status, 200)
    const html = await response.text()

    assert.match(html, /data-nav-group="platform"/)
    assert.match(html, /href="\/admin"[^>]*data-platform-route="overview"/)
    assert.match(html, /href="\/admin\/organizations"[^>]*data-platform-route="organizations"/)
    assert.match(html, /href="\/admin\/ai-infrastructure"[^>]*data-platform-route="ai-infrastructure"/)
    assert.match(html, /href="\/admin\/ai-infrastructure\/usage"[^>]*data-platform-route="ai-usage"/)
    assert.match(html, /href="\/admin\/ai-infrastructure\/alerts"[^>]*data-platform-route="ai-alerts"/)
    assert.match(html, /href="\/admin\/platform-users"[^>]*data-platform-route="platform-users"/)
    assert.match(html, /href="\/admin\/audit"[^>]*data-platform-route="audit"/)
    assert.match(html, /id="organization-context-header"[^>]*data-organization-context/)
    assert.match(html, /id="operating-organization-label"[^>]*>Operating organization:/)
    for (const page of ["overview", "members", "domains-invites", "billing", "ai-access", "audit"]) {
      assert.match(html, new RegExp(`data-organization-route="${page}"`))
    }
    assert.match(html, /id="organization-billing-content"/)
    assert.match(html, /id="organization-audit-content"/)
    assert.match(html, /id="model-policy-panel"[^>]*data-platform-admin-control/)
    assert.doesNotMatch(html, /href="\/admin\/(organization|credentials|users|usage|alerts)"/)

    const routeModule = await fetch(`http://127.0.0.1:${port}/admin/admin-route-state.js`)
    assert.equal(routeModule.status, 200)
    assert.match(await routeModule.text(), /export function parseAdminRoute/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js uses typed route descriptors and clears organization context on platform navigation", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/app.js`)
    assert.equal(response.status, 200)
    const script = await response.text()

    assert.match(script, /from "\.\/admin-route-state\.js"/)
    assert.match(script, /route:\s*parseAdminRoute\(location\.pathname\)/)
    assert.match(script, /history\.pushState\(null, "", pathname\)/)
    assert.match(script, /window\.addEventListener\("popstate"/)
    assert.match(script, /applyAdminPopState\(state\.navigation, location\.pathname\)/)
    assert.match(script, /planAdminHistoryUpdate\(state\.route, location, historyMode\)/)
    assert.match(script, /setAdminRoute\(route, \{ historyMode: "replace" \}\)/)
    assert.doesNotMatch(script, /location\.pathname !== pathname/)
    assert.match(script, /switchOrganizationRoute\(state\.route,/)
    assert.match(script, /item\.href = formatAdminRoute\(\{/)
    assert.match(script, /state\.route\?\.area === "organization"/)
    assert.match(script, /organizationIdForRoute\(state\.route\)/)
    assert.match(script, /Operating organization:/)
    assert.doesNotMatch(script, /\bDEFAULT_PAGES\b/)
    assert.doesNotMatch(script, /\bcurrentOrganizationId\b/)
    assert.doesNotMatch(script, /\bselectedOrganizationId\b/)
    assert.match(script, /async function loadRouteData\(route, activeLoad = null\)/)
    assert.match(script, /route\.area === "platform"[\s\S]*loadPlatformRouteResult\(route, signal\)/)
    assert.match(script, /loadOrganizationWorkspace\(route, signal\)/)
    assert.match(script, /beginRouteDataLoad\(route\)/)
    assert.match(script, /routeLoadAbortController\?\.abort\(\)/)
    assert.match(script, /finishRouteDataLoad\(request, result,/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin user editor scopes visibility, payloads, and actions to the canonical route", async () => {
  const app = createApp({ admin: createAdminServiceStub() })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const shellResponse = await fetch(`http://127.0.0.1:${port}/admin`, { headers: { cookie: ADMIN_COOKIE } })
    assert.equal(shellResponse.status, 200)
    const html = await shellResponse.text()
    assert.match(html, /data-user-global-control[^>]*>[\s\S]*id="user-name"/)
    assert.match(html, /data-user-membership-control[^>]*>[\s\S]*id="user-org"/)
    assert.match(html, /data-user-ai-access-control/)
    assert.match(html, /id="user-disable-button"[^>]*data-user-global-action/)
    assert.match(html, /id="user-delete-button"[^>]*data-user-global-action/)

    const scriptResponse = await fetch(`http://127.0.0.1:${port}/admin/app.js`)
    assert.equal(scriptResponse.status, 200)
    const script = await scriptResponse.text()
    assert.match(script, /adminUserRoutePermissions\(state\.route, routeAccessSnapshot\(\)\)/)
    assert.match(script, /buildAdminUserUpdatePayload\(state\.route, routeAccessSnapshot\(\), payload\)/)
    assert.match(script, /canPerformAdminRouteAction\(state\.route, routeAccessSnapshot\(\), "create-user"\)/)
    assert.match(script, /canPerformAdminRouteAction\(state\.route, routeAccessSnapshot\(\), "disable-user"\)/)
    assert.match(script, /canPerformAdminRouteAction\(state\.route, routeAccessSnapshot\(\), "delete-user"\)/)
    assert.doesNotMatch(script, /state\.page !== "users" \|\| state\.session\?\.platformAdmin !== true/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin app guards organization mutation completions and marks active navigation accessibly", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/app.js`)
    assert.equal(response.status, 200)
    const script = await response.text()
    assert.match(script, /beginCurrentRouteMutation\(/)
    assert.match(script, /isCurrentRouteMutation\(mutation\)/)
    assert.match(script, /item\.setAttribute\("aria-current", "page"\)/)
    assert.match(script, /item\.removeAttribute\("aria-current"\)/)
    for (const functionName of [
      "saveOrganization",
      "saveOrganizationDomainModal",
      "deleteOrganizationDomain",
      "createOrganizationInvite",
      "resendOrganizationInvite",
      "revokeOrganizationInvite",
      "saveUser",
    ]) {
      assert.match(
        script,
        new RegExp(`async function ${functionName}\\([^)]*\\) \\{[\\s\\S]*beginCurrentRouteMutation[\\s\\S]*isCurrentRouteMutation`),
        functionName,
      )
    }
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("organization billing and audit routes render real scoped loaders and actions", async () => {
  const app = createApp({ admin: createAdminServiceStub() })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const { port } = server.address() as AddressInfo
    const shell = await fetch(`http://127.0.0.1:${port}/admin`, { headers: { cookie: ADMIN_COOKIE } })
    const html = await shell.text()
    assert.match(html, /id="organization-billing-content"/)
    assert.match(html, /id="organization-billing-checkout"/)
    assert.match(html, /id="organization-billing-portal"/)
    assert.match(html, /id="organization-billing-plan-save"/)
    assert.match(html, /id="organization-billing-cancel"/)
    assert.match(html, /id="organization-billing-platform-controls"[^>]*data-platform-admin-control/)
    assert.match(html, /id="organization-billing-manual-enabled"/)
    assert.match(html, /id="organization-billing-manual-expires"/)
    assert.match(html, /id="organization-audit-list"/)
    assert.match(html, /id="organization-audit-status"[^>]*aria-live="polite"/)
    assert.doesNotMatch(html, /organization-billing-placeholder|organization-audit-placeholder|data-honest-placeholder/)

    const script = await (await fetch(`http://127.0.0.1:${port}/admin/app.js`)).text()
    assert.match(script, /fetchJson\(`\/organizations\/\$\{encodeURIComponent\(organizationId\)\}\/billing`\)/)
    assert.match(script, /fetchJson\(`\/organizations\/\$\{encodeURIComponent\(organizationId\)\}\/audit`\)/)
    assert.match(script, /beginCurrentRouteMutation\("organization-billing-load", route\)/)
    assert.match(script, /beginCurrentRouteMutation\("organization-audit-load", route\)/)
    assert.match(script, /entry\.source === "den" \? "DEN" : "AI Gateway"/)
    assert.match(script, /entry\.actor \|\| "unknown actor"/)
    assert.match(script, /async function signOut\(\) \{\s*const token = state\.token;[\s\S]*routeLoadAbortController\?\.abort\(\);[\s\S]*clearRouteOwnedState\(\)[\s\S]*await clearServerAdminSession\(token\)/)
    assert.match(script, /catch \(error\) \{\s*if \(error\?\.name !== "AbortError"\) \{\s*setBackendConnectionStatus/)
    assert.match(script, /canPerformAdminRouteAction\(state\.route, routeAccessSnapshot\(\), "manage-platform-billing"\)/)
    assert.doesNotMatch(script, /will be connected in Task 7/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.css keeps the organization context responsive and keyboard visible", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/app.css`)
    assert.equal(response.status, 200)
    const css = await response.text()
    assert.match(css, /\.organization-context\s*\{[\s\S]*grid-template-columns:/)
    assert.match(css, /\.organization-subnav a:focus-visible/)
    assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.organization-context\s*\{[\s\S]*grid-template-columns: 1fr/)
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin serves the canonical organization overview workspace", async () => {
  const app = createApp({ admin: createAdminServiceStub() })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/organizations/org_admin/overview`, {
      headers: {
        cookie: ADMIN_COOKIE,
      },
    })

    assert.equal(response.status, 200)
    const html = await response.text()
    assert.match(html, /data-organization-route="overview"/)
    assert.match(html, /data-page="organization-workspace"/)
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

test("organization admins are restricted to canonical routes for their authorized organizations", async () => {
  const app = createApp({
    admin: createAdminServiceStub({
      async getSession() {
        return orgAdminSession() as AdminSessionSnapshot
      },
    }),
  })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const headers = { cookie: ADMIN_COOKIE }
    const authorized = await fetch(`http://127.0.0.1:${port}/admin/organizations/org_1/members`, {
      headers,
      redirect: "manual",
    })
    assert.equal(authorized.status, 200)

    for (const pathname of ["/admin", "/admin/audit", "/admin/organizations/org_2/overview", "/admin/organization"]) {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers, redirect: "manual" })
      assert.equal(response.status, 302, pathname)
      assert.equal(response.headers.get("location"), "/admin/organizations/org_1/overview", pathname)
    }
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("platform admins recover from rejected legacy flat routes at the canonical overview", async () => {
  const app = createApp({ admin: createAdminServiceStub() })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    for (const pathname of ["/admin/organization", "/admin/credentials", "/admin/users", "/admin/usage", "/admin/alerts"]) {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        headers: { cookie: ADMIN_COOKIE },
        redirect: "manual",
      })
      assert.equal(response.status, 302, pathname)
      assert.equal(response.headers.get("location"), "/admin", pathname)
    }
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin shell uses modal detail editors instead of split list-detail panels", async () => {
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
    assert.match(html, /<dialog id="credential-detail-modal" class="modal-shell"/)
    assert.match(html, /<dialog id="alert-detail-modal" class="modal-shell"/)
    assert.match(html, /<dialog id="user-editor-modal" class="modal-shell"/)
    assert.match(html, /<dialog id="audit-detail-modal" class="modal-shell"/)
    assert.match(html, /id="user-modal-close"/)
    assert.match(html, /id="credential-detail-modal-close"/)
    assert.match(html, /id="alert-detail-modal-close"/)
    assert.match(html, /id="audit-detail-modal-close"/)
    assert.doesNotMatch(html, /<aside class="detail-card user-editor"/)
    assert.doesNotMatch(html, /<aside class="detail-rail"/)
    assert.doesNotMatch(html, /<aside id="alert-detail"/)
    assert.doesNotMatch(html, /<aside id="audit-detail"/)
    assert.doesNotMatch(html, /Export CSV/)
    assert.doesNotMatch(html, /Trace request/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin shell exposes Overview navigation and organization command modals", async () => {
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
    assert.match(html, /href="\/admin" data-platform-route="overview" class="nav-item">Overview<\/a>/)
    assert.match(html, /<dialog id="organization-domain-modal" class="modal-shell"/)
    assert.match(html, /<dialog id="organization-invite-modal" class="modal-shell"/)
    assert.match(html, /id="organization-selector-control"/)
    assert.match(html, /id="organization-selector-input"/)
    assert.match(html, /id="organization-selector-options"/)
    assert.match(html, /data-platform-admin-control/)
    assert.match(html, /id="organization-domain-modal-save"/)
    assert.match(html, /id="organization-invite-modal-send"/)
    assert.doesNotMatch(html, /id="organization-domain-input"/)
    assert.doesNotMatch(html, /id="organization-invite-email"/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js supports platform-admin searchable organization selection", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/app.js`)

    assert.equal(response.status, 200)
    const script = await response.text()
    assert.match(script, /organizationSelectorControl:\s*document\.getElementById\("organization-selector-control"\)/)
    assert.match(script, /organizationSelectorInput:\s*document\.getElementById\("organization-selector-input"\)/)
    assert.match(script, /organizationSelectorOptions:\s*document\.getElementById\("organization-selector-options"\)/)
    assert.match(script, /function organizationSelectorLabel\(organization\)/)
    assert.match(script, /function renderOrganizationSelector\(\)/)
    assert.match(script, /function hasOrganizationPendingChanges\(\)/)
    assert.match(script, /async function selectOrganizationFromSelector\(\)/)
    assert.match(script, /switchOrganizationRoute\(state\.route, selected\.id\)/)
    assert.match(script, /state\.organizationDomains = \[\]/)
    assert.match(script, /state\.organizationInvites = \[\]/)
    assert.match(script, /await setAdminRoute\(switchOrganizationRoute\(state\.route, selected\.id\)\)/)
    assert.match(script, /organizationSelectorInput\.addEventListener\("change", \(\) => void selectOrganizationFromSelector\(\)\)/)
    assert.match(script, /organizationSelectorInput\.addEventListener\("keydown"/)
    assert.match(script, /window\.confirm\("Discard unsaved organization changes before switching organization\?"\)/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js uses unique organization labels and rejects ambiguous names", async () => {
  const script = await readFile(new URL("../public-admin/app.js", import.meta.url), "utf8")
  const refreshDirectory = topLevelFunctionSource(script, "refreshOrganizationChromeDirectory")
  const findFromSelector = topLevelFunctionSource(script, "findOrganizationFromSelectorValue")
  const renderSelector = topLevelFunctionSource(script, "renderOrganizationSelector")
  const renderDirectory = topLevelFunctionSource(script, "renderOrganizationsDirectory")
  const selectFromSelector = topLevelFunctionSource(script, "selectOrganizationFromSelector")

  assert.match(
    refreshDirectory,
    /<option[^>]*>\$\{escapeHtml\(organizationSelectorLabel\(entry\)\)\}<\/option>/,
    "user membership organization options must distinguish duplicate and nameless organizations",
  )
  assert.match(
    renderSelector,
    /label="\$\{escapeHtml\(organizationSelectorLabel\(organization\)\)\}"/,
    "organization datalist labels must expose the same unique name-and-ID label as their values",
  )
  assert.match(
    renderDirectory,
    /aria-label="Open \$\{escapeHtml\(organizationSelectorLabel\(organization\)\)\} organization workspace"/,
    "organization directory actions must have unique accessible labels",
  )
  assert.match(findFromSelector, /exactMatch/)
  assert.match(findFromSelector, /nameMatches/)
  assert.match(findFromSelector, /nameMatches\.length === 1/)
  assert.match(
    selectFromSelector,
    /organizationContextStatus\.textContent\s*=\s*"[^"]*(?:name and ID|ambiguous)[^"]*"/i,
    "an ambiguous organization name must be rejected with accessible guidance",
  )
})

test("organization slug remains a backend compatibility field and is absent from the admin UI contract", async () => {
  const [html, script, adminSource] = await Promise.all([
    readFile(new URL("../public-admin/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public-admin/app.js", import.meta.url), "utf8"),
    readFile(new URL("../src/http/admin.ts", import.meta.url), "utf8"),
  ])

  assert.doesNotMatch(html, /id="organization-slug"/)
  assert.doesNotMatch(html, /<span>\s*Slug\s*<\/span>/i)
  assert.doesNotMatch(
    script,
    /organizationSlug:\s*document\.getElementById\("organization-slug"\)/,
  )

  for (const functionName of [
    "organizationSelectorLabel",
    "findOrganizationFromSelectorValue",
    "renderOrganizationsDirectory",
    "renderOrganizationSelector",
    "hasOrganizationPendingChanges",
    "renderOrganization",
    "renderRoute",
    "saveOrganization",
    "organizationMemberToRouteSubject",
  ]) {
    assert.doesNotMatch(
      topLevelFunctionSource(script, functionName),
      /\bslug\b|organizationSlug/i,
      `${functionName} must not render, read, compare, or submit organization slug`,
    )
  }

  assert.match(
    topLevelFunctionSource(script, "renderOrganizationSelector"),
    /Search by organization name (?:or|and) id\./i,
    "organization selector help must advertise only name and ID lookup",
  )

  assert.match(
    topLevelFunctionSource(adminSource, "readOrganizationUpdateInput"),
    /hasOwn\(body,\s*"slug"\)/,
    "the backend must continue accepting slug for compatibility with existing API clients",
  )
})

test("organization pending changes only consult the Overview form on the Overview route", async () => {
  const script = await readFile(new URL("../public-admin/app.js", import.meta.url), "utf8")
  const functionSource = script.match(/^function hasOrganizationPendingChanges\(\) \{[\s\S]*?^\}/m)?.[0]
  assert.ok(functionSource, "hasOrganizationPendingChanges should remain directly testable")

  let overviewFormReads = 0
  const clearedOverviewControl = {
    get value() {
      overviewFormReads += 1
      return ""
    },
  }
  const state = {
    route: { area: "organization", page: "members", organizationId: "org_a" },
    session: { platformAdmin: true },
  }
  const els = {
    organizationName: clearedOverviewControl,
    organizationSeatLimit: clearedOverviewControl,
  }
  const currentOrganization = () => ({
    id: "org_a",
    name: "Organization A",
    slug: "organization-a",
    seatLimit: 25,
  })
  const hasPendingChanges = new Function(
    "state",
    "els",
    "currentOrganization",
    `${functionSource}; return hasOrganizationPendingChanges;`,
  )(state, els, currentOrganization)

  for (const page of ["members", "domains-invites", "billing", "ai-access", "audit"]) {
    state.route.page = page
    overviewFormReads = 0
    assert.equal(hasPendingChanges(), false, page)
    assert.equal(overviewFormReads, 0, `${page} must not consult cleared Overview controls`)
  }

  state.route.page = "overview"
  overviewFormReads = 0
  assert.equal(hasPendingChanges(), true, "clearing an Overview value is a real edit")
  assert.ok(overviewFormReads > 0, "Overview must compare the current form to the saved organization")
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

test("fallback admin shell exposes only canonical routes for the current admin scope", () => {
  const platformHtml = adminFallbackShellHtml(adminSession())
  for (const pathname of [
    "/admin",
    "/admin/organizations",
    "/admin/ai-infrastructure",
    "/admin/ai-infrastructure/usage",
    "/admin/ai-infrastructure/alerts",
    "/admin/platform-users",
    "/admin/audit",
  ]) {
    assert.match(platformHtml, new RegExp(`href="${pathname.replaceAll("/", "\\/")}"`), pathname)
  }
  for (const page of ["overview", "members", "domains-invites", "billing", "ai-access", "audit"]) {
    assert.match(platformHtml, new RegExp(`href="\\/admin\\/organizations\\/org_admin\\/${page}"`), page)
  }
  assert.doesNotMatch(platformHtml, /href="\/admin\/(organization|credentials|usage|alerts|users)"/)

  const organizationHtml = adminFallbackShellHtml(orgAdminSession() as AdminSessionSnapshot)
  assert.doesNotMatch(organizationHtml, /data-nav-group="platform"/)
  assert.match(organizationHtml, /href="\/admin\/organizations\/org_1\/overview"/)
  assert.doesNotMatch(organizationHtml, /href="\/admin\/audit"/)

  const slugMarker = "PRIVATE-ORGANIZATION-SLUG-MUST-NOT-RENDER"
  const namelessSession = adminSession()
  namelessSession.organizations = [{
    id: "org_nameless",
    name: "",
    slug: slugMarker,
    ownerUserId: "user_admin",
    role: "organization_admin",
  }]
  const namelessOrganizationHtml = adminFallbackShellHtml(namelessSession)
  assert.doesNotMatch(namelessOrganizationHtml, new RegExp(slugMarker))
  assert.match(namelessOrganizationHtml, />org_nameless</)
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
    assert.match(script, /function routeAccessSnapshot\(\)/)
    assert.match(script, /function hasCapability\(capability\)/)
    assert.match(script, /function applyAdminCapabilities\(\)/)
    assert.match(script, /canAccessAdminRoute\(requestedRoute, routeAccessSnapshot\(\)\)/)
    assert.match(script, /els\.platformNavigation\.classList\.toggle\("hidden", !canManagePlatform\)/)
    assert.match(script, /route\.area === "platform"[\s\S]*loadPlatformRouteResult\(route, signal\)/)
    assert.match(script, /loadOrganizationWorkspace\(route, signal\)/)
    assert.doesNotMatch(script, /\bloadSessions\(\)/)
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
    assert.match(script, /canPerformAdminRouteAction\(state\.route, routeAccessSnapshot\(\), "edit-ai-access"\)/)
    assert.match(script, /const authorizedRoute = requestedRoute && canAccessAdminRoute/)
    assert.match(script, /firstAuthorizedRoute\(\)/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js validates and loads canonical direct routes after session bootstrap", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/app.js`)

    assert.equal(response.status, 200)
    const script = await response.text()
    assert.match(script, /const requestedRoute = parseAdminRoute\(location\.pathname\)/)
    assert.match(script, /await setAdminRoute\(authorizedRoute, \{ historyMode: "replace", load: false \}\)/)
    assert.match(script, /showApp\(\);\s*void loadReadiness\(\);\s*await loadRouteData\(state\.route, activeLoad\)/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js opens modal editors from selected rows and keeps user changes behind Save", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/app.js`)

    assert.equal(response.status, 200)
    const script = await response.text()
    assert.match(script, /credentialDetailModal:\s*document\.getElementById\("credential-detail-modal"\)/)
    assert.match(script, /userEditorModal:\s*document\.getElementById\("user-editor-modal"\)/)
    assert.match(script, /alertDetailModal:\s*document\.getElementById\("alert-detail-modal"\)/)
    assert.match(script, /auditDetailModal:\s*document\.getElementById\("audit-detail-modal"\)/)
    assert.match(script, /function openModal\(modal\)/)
    assert.match(script, /function closeModal\(modal\)/)
    assert.match(script, /function openCredentialDetail\(credentialId\)/)
    assert.match(script, /function openAlertDetail\(alertId\)/)
    assert.match(script, /function openUserEditor\(userId\)/)
    assert.match(script, /function openAuditDetail\(auditId\)/)
    assert.match(script, /function openOrganizationDomainModal\(/)
    assert.match(script, /function openOrganizationInviteModal\(/)
    assert.match(script, /els\.credentialDetailModal\.showModal\(\)/)
    assert.match(script, /els\.userEditorModal\.showModal\(\)/)
    assert.match(script, /els\.alertDetailModal\.showModal\(\)/)
    assert.match(script, /els\.auditDetailModal\.showModal\(\)/)
    assert.match(script, /els\.organizationDomainModal\.showModal\(\)/)
    assert.match(script, /els\.organizationInviteModal\.showModal\(\)/)
    assert.match(script, /event\.target\.closest\("\[data-user-id\]"\)/)
    assert.match(script, /event\.target\.closest\("\[data-credential-id\]"\)/)
    assert.match(script, /event\.target\.closest\("\[data-alert-id\]"\)/)
    assert.match(script, /event\.target\.closest\("\[data-audit-id\]"\)/)
    assert.match(script, /closeModal\(els\.userEditorModal\)/)
    assert.doesNotMatch(script, /userRole\.addEventListener\("change"[\s\S]*fetchJson/)
    assert.doesNotMatch(script, /userPlatformAdmin\.addEventListener\("change"[\s\S]*fetchJson/)
    assert.doesNotMatch(script, /userOrg\.addEventListener\("change"[\s\S]*fetchJson/)
    assert.doesNotMatch(script, /Trace request/)
    assert.doesNotMatch(script, /Open entity/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js closes stale modals before route actions and terminal alert resolve", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/app.js`)

    assert.equal(response.status, 200)
    const script = await response.text()
    assert.match(script, /function closeAllModals\(\)/)
    assert.match(script, /if \(routeAlerts\) \{[\s\S]*closeAllModals\(\);[\s\S]*openAlertsForSelectedCredential\(\)/)
    assert.match(script, /function openAlertsForSelectedCredential\(\) \{[\s\S]*setAdminRoute\(toPlatformRoute\("ai-alerts"\)\)/)
    assert.match(script, /if \(routeAudit\) \{[\s\S]*closeAllModals\(\);[\s\S]*setAdminRoute\(toPlatformRoute\("audit"\)\)/)
    assert.match(script, /if \(action === "resolve"\) \{[\s\S]*closeModal\(els\.alertDetailModal\)/)
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
    assert.match(script, /function buildUserRoleFilterOptions\(\)/)
    assert.match(script, /const permissions = adminUserRoutePermissions\(state\.route, routeAccessSnapshot\(\)\)/)
    assert.match(script, /els\.userName\.disabled = state\.routeActionsLocked \|\| !permissions\.editProfile/)
    assert.match(script, /els\.userEmail\.disabled = state\.routeActionsLocked \|\| !isCreate \|\| !permissions\.createUser/)
    assert.match(script, /data-invite-resend/)
    assert.match(script, /async function resendOrganizationInvite\(card\)/)
    assert.match(script, /\/invites\/\$\{encodeURIComponent\(inviteId\)\}\/resend/)
    assert.match(script, /event\.target\.closest\("\[data-invite-resend\]"\)/)
    assert.match(
      script,
      /return buildAdminUserUpdatePayload\(state\.route, routeAccessSnapshot\(\), payload\)/,
    )
    assert.match(
      script,
      /`\/organizations\/\$\{encodeURIComponent\(organizationId\)\}\/members\/\$\{encodeURIComponent\(targetUser\.membershipId\)\}`[\s\S]*body: JSON\.stringify\(\{ role: membershipRole \}\)/,
    )
    assert.match(script, /<option value="organization_admin">Organization admin<\/option>/)
    assert.match(script, /createUserButtonInline[\s\S]*data-platform-only/)
    assert.match(script, /Organization membership changes are applied through Save\./)
    assert.doesNotMatch(script, /userRole\.addEventListener\("change"[\s\S]*fetchJson/)
    assert.doesNotMatch(script, /userPlatformAdmin\.addEventListener\("change"[\s\S]*fetchJson/)
    assert.doesNotMatch(script, /userOrg\.addEventListener\("change"[\s\S]*fetchJson/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/ai-infrastructure/usage includes a credential usage section", async () => {
  const app = createApp({ admin: createAdminServiceStub() })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/ai-infrastructure/usage`, {
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

test("GET /admin shell prioritizes Codex capacity before usage drilldown", async () => {
  const app = createApp({ admin: createAdminServiceStub() })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/ai-infrastructure/usage`, {
      headers: {
        cookie: ADMIN_COOKIE,
      },
    })

    assert.equal(response.status, 200)
    const html = await response.text()
    const capacityIndex = html.indexOf("Capacity overview")
    const totalUsageIndex = html.indexOf("Token volume trend")
    assert.notEqual(capacityIndex, -1)
    assert.notEqual(totalUsageIndex, -1)
    assert.ok(capacityIndex < totalUsageIndex)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js wires client-side credential and alert filters", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/app.js`)

    assert.equal(response.status, 200)
    const script = await response.text()
    assert.match(script, /credentialFilters:\s*\{/)
    assert.match(script, /function filteredCredentials\(\)/)
    assert.match(script, /els\.credentialSearch\.addEventListener\("input",/)
    assert.match(script, /els\.credentialProviderFilter\.addEventListener\("change",/)
    assert.match(script, /els\.credentialStateFilter\.addEventListener\("change",/)
    assert.match(script, /function filteredAlerts\(\)/)
    assert.match(script, /alertStatusFilter:\s*"active"/)
    assert.match(script, /data-alert-status-filter/)
    assert.match(script, /state\.alertStatusFilter = button\.dataset\.alertStatusFilter/)
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
    ["GET", "/admin/api/ai-infrastructure/model-policy"],
    ["PUT", "/admin/api/ai-infrastructure/model-policy"],
    ["POST", "/admin/api/credentials"],
    ["DELETE", "/admin/api/credentials/cred_1"],
    ["POST", "/admin/api/credentials/cred_1/revoke"],
    ["POST", "/admin/api/credentials/cred_1/drain"],
    ["POST", "/admin/api/credentials/cred_1/rotate"],
    ["POST", "/admin/api/credentials/cred_1/reconnect"],
    ["GET", "/admin/api/sessions"],
    ["GET", "/admin/api/usage"],
    ["GET", "/admin/api/alerts"],
    ["POST", "/admin/api/alerts/alert_1/acknowledge"],
    ["POST", "/admin/api/alerts/alert_1/resolve"],
    ["GET", "/admin/api/audit"],
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

test("organization admins cannot update organization seat limit through the gateway API", async () => {
  let capturedUpdate: unknown = null
  const app = createApp({
    admin: {
      ...createAdminServiceStub({
        async getSession() {
          return orgAdminSession() as unknown as AdminSessionSnapshot
        },
      }),
      async updateOrganization(_token: string, _orgId: string, input: unknown) {
        capturedUpdate = input
        return {
          organization: {
            id: "org_1",
            name: "Acme",
            slug: "acme",
            ownerUserId: "user_org_admin",
            seatLimit: 10,
          },
        }
      },
    } as any,
  })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const allowedResponse = await fetch(`http://127.0.0.1:${port}/admin/api/organizations/org_1`, {
      method: "PATCH",
      headers: {
        cookie: ADMIN_COOKIE,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Acme Renamed", slug: "acme" }),
    })
    assert.equal(allowedResponse.status, 200)
    assert.deepEqual(capturedUpdate, { name: "Acme Renamed", slug: "acme" })

    const blockedResponse = await fetch(`http://127.0.0.1:${port}/admin/api/organizations/org_1`, {
      method: "PATCH",
      headers: {
        cookie: ADMIN_COOKIE,
        "content-type": "application/json",
      },
      body: JSON.stringify({ seatLimit: 99 }),
    })
    assert.equal(blockedResponse.status, 403)
    assert.deepEqual(await blockedResponse.json(), { error: "forbidden_seat_limit" })
    assert.deepEqual(capturedUpdate, { name: "Acme Renamed", slug: "acme" })
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

test("organization domain verification conflicts pass through the gateway unchanged", async () => {
  const denRequests: Array<{ method: string; path: string; authorization: string | undefined }> = []
  const den = express()
  den.use(express.json())
  den.get("/v1/admin/session", (req, res) => {
    denRequests.push({
      method: req.method,
      path: req.path,
      authorization: req.header("authorization"),
    })
    res.json(adminSession())
  })
  const rejectDomainVerification = (req: express.Request, res: express.Response) => {
    denRequests.push({
      method: req.method,
      path: req.path,
      authorization: req.header("authorization"),
    })
    res.status(409).json({ error: "domain_verified_member_required" })
  }
  den.post("/v1/admin/organizations/:orgId/domains", rejectDomainVerification)
  den.patch("/v1/admin/organizations/:orgId/domains/:domainId", rejectDomainVerification)
  const denServer = den.listen(0, "127.0.0.1")
  await once(denServer, "listening")

  const denPort = (denServer.address() as AddressInfo).port
  const app = createApp({
    admin: createDefaultAdminService(`http://127.0.0.1:${denPort}`),
  })
  const gatewayServer = app.listen(0, "127.0.0.1")
  await once(gatewayServer, "listening")

  try {
    const { port } = gatewayServer.address() as AddressInfo
    const requests = [
      fetch(`http://127.0.0.1:${port}/admin/api/organizations/org_1/domains`, {
        method: "POST",
        headers: {
          cookie: ADMIN_COOKIE,
          "content-type": "application/json",
        },
        body: JSON.stringify({ domain: "team.example.com" }),
      }),
      fetch(`http://127.0.0.1:${port}/admin/api/organizations/org_1/domains/domain_1`, {
        method: "PATCH",
        headers: {
          cookie: ADMIN_COOKIE,
          "content-type": "application/json",
        },
        body: JSON.stringify({ domain: "team.example.com" }),
      }),
    ]

    for (const response of await Promise.all(requests)) {
      assert.equal(response.status, 409)
      assert.deepEqual(await response.json(), { error: "domain_verified_member_required" })
    }
    assert.deepEqual(
      denRequests
        .filter((entry) => entry.path.includes("/domains"))
        .sort((left, right) => left.method.localeCompare(right.method)),
      [
        {
          method: "PATCH",
          path: "/v1/admin/organizations/org_1/domains/domain_1",
          authorization: "Bearer admin-token",
        },
        {
          method: "POST",
          path: "/v1/admin/organizations/org_1/domains",
          authorization: "Bearer admin-token",
        },
      ],
    )
  } finally {
    gatewayServer.close()
    await once(gatewayServer, "close")
    denServer.close()
    await once(denServer, "close")
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

test("GET /admin/app.js saves user ai access without per-user model authority", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/app.js`)

    assert.equal(response.status, 200)
    const script = await response.text()
    const captureSelection = topLevelFunctionSource(script, "captureAiAccessMemberSelection")
    const selectionCurrent = topLevelFunctionSource(script, "isAiAccessMemberSelectionCurrent")
    const loadAccess = topLevelFunctionSource(script, "loadUserAiAccess")
    const saveAccess = topLevelFunctionSource(script, "saveUserAiAccess")
    const memberAdapter = topLevelFunctionSource(script, "organizationMemberToRouteSubject")
    const userStatusSource = topLevelFunctionSource(script, "userStatus")
    const saveUserSource = topLevelFunctionSource(script, "saveUser")

    assert.match(captureSelection, /state\.route\?\.area !== "organization"/)
    assert.match(captureSelection, /state\.route\.page !== "ai-access"/)
    assert.match(captureSelection, /organizationIdForRoute\(state\.route\)/)
    assert.match(captureSelection, /state\.pageLoad\.status !== "ready" && state\.pageLoad\.status !== "empty"/)
    assert.match(captureSelection, /state\.routeActionsLocked/)
    assert.match(captureSelection, /state\.organizationMembers\.find/)
    assert.match(captureSelection, /member\.userId === resolvedUserId/)
    assert.match(selectionCurrent, /selection\.pageGeneration === state\.pageLoad\.generation/)
    assert.match(selectionCurrent, /selection\.pageKey === state\.pageLoad\.key/)
    assert.match(selectionCurrent, /state\.selectedUserId === selection\.userId/)
    assert.match(selectionCurrent, /member\.membershipId === selection\.membershipId/)
    assert.match(loadAccess, /aiAccessMemberPath\(selection\)/)
    assert.match(saveAccess, /aiAccessMemberPath\(selection\)/)
    assert.doesNotMatch(script, /\/users\/\$\{encodeURIComponent\([^)]+\)\}\/ai-access/)
    assert.match(saveAccess, /body:\s*JSON\.stringify\(aiAccessInput\)/)
    assert.doesNotMatch(saveAccess, /body:\s*JSON\.stringify\(\{[\s\S]*organizationId/)
    assert.match(script, /user-ai-access-provider/)
    assert.match(script, /user-ai-access-credential/)
    assert.doesNotMatch(script, /user-ai-access-default-model/)
    assert.doesNotMatch(script, /userAiAccessModelOptions/)
    assert.doesNotMatch(script, /user-ai-access-allowed-models/)
    assert.doesNotMatch(script, /userAiAccessModelsByCredentialId/)
    assert.doesNotMatch(script, /refreshSelectedAiAccessModels/)
    assert.doesNotMatch(script, /defaultModel:/)
    assert.doesNotMatch(script, /allowedModels:/)
    assert.match(script, /availableCredentials/)
    assert.match(script, /Select assigned credential/)
    assert.match(script, /No eligible Codex credential/)
    assert.match(script, /No healthy Codex credentials with OK upstream status are available for assignment\./)
    assert.match(script, /credentialId:\s*typeof payload\.credentialId === "string" \? payload\.credentialId : null/)
    assert.match(script, /credentialId:\s*readAiAccessCredentialValue\(\)/)
    assert.match(
      script,
      /async function saveUserAiAccess\([\s\S]*input = null,[\s\S]*mutation = beginCurrentRouteMutation[\s\S]*enabled: input\.enabled === true,[\s\S]*provider:[\s\S]*credentialId:[\s\S]*fetchJson\(aiAccessMemberPath\(selection\)/,
    )
    assert.match(
      script,
      /async function saveUser\(\) \{[\s\S]*const canEditAiAccess = permissions\.editAiAccess && !wasCreating;[\s\S]*await saveUserAiAccess\(targetUser\.id, aiAccessInput, mutation\)/,
    )
    assert.match(
      script,
      /if \(canEditAiAccess\) \{[\s\S]*await saveUserAiAccess\(targetUser\.id, aiAccessInput, mutation\)/,
    )
    assert.doesNotMatch(memberAdapter, /emailVerified/)
    assert.match(userStatusSource, /state\.route\?\.area === "organization"[\s\S]*user\.status/)
    assert.match(userStatusSource, /user\.emailVerified \? "Active" : "Invited"/)
    assert.match(saveUserSource, /savedMember\.membershipId !== targetUser\.membershipId[\s\S]*savedMember\.userId !== targetUser\.userId/)
    assert.match(saveUserSource, /Unable to save membership:[\s\S]*await loadRouteData\(state\.route\)[\s\S]*return/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js manages one global model policy with discovery-backed explicit save", async () => {
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
      /from "\.\/model-policy-editor-state\.js"/,
    )
    assert.match(script, /modelPolicy:\s*createModelPolicyState\(\)/)
    assert.match(script, /modelDiscovery:\s*createModelDiscoveryState\(\)/)
    assert.match(script, /fetchJson\("\/ai-infrastructure\/model-policy", \{ signal \}\)/)
    assert.match(script, /fetchJson\("\/ai-infrastructure\/model-policy", \{\s*method: "PUT"/)
    assert.match(script, /modelPolicySaveButton\.addEventListener\("click", \(\) => void saveModelPolicy\(\)\)/)
    assert.match(script, /const submission = beginModelPolicySave\(state\.modelPolicy\)/)
    assert.match(script, /completeModelPolicySave\(state\.modelPolicy, submission, saved\?\.policy\)/)
    assert.match(script, /failModelPolicySave\(\s*state\.modelPolicy,\s*submission,/)
    assert.match(script, /async function loadModelPolicy\(signal\)/)
    assert.match(script, /const stagedModelPolicy = createModelPolicyState\(\)/)
    assert.match(script, /const request = beginModelPolicyLoad\(stagedModelPolicy\)/)
    assert.match(script, /completeModelPolicyLoad\(stagedModelPolicy, request, payload\?\.policy\)/)
    assert.match(script, /return stagedModelPolicy/)
    assert.doesNotMatch(script, /modelPolicyLoadAbortController/)
    assert.match(script, /function invalidatePendingModelPolicyLoad\(\)/)
    assert.match(script, /invalidateModelPolicyLoad\(state\.modelPolicy\)/)
    assert.match(script, /state\.route\?\.area === "platform"[\s\S]*state\.route\.page === "ai-infrastructure"/)
    assert.match(script, /No platform model policy configured/)
    assert.match(script, /Unsaved model policy changes/)
    assert.match(script, /if \(state\.session\?\.platformAdmin !== true\) \{\s*return;/)
    assert.match(script, /credential\.state === "healthy"/)
    assert.match(script, /credential\.provider === "codex_oauth" \|\| credential\.provider === "openai_compatible"/)
    assert.match(script, /fetchJson\(`\/credentials\/\$\{encodeURIComponent\(credential\.id\)\}\/models`, \{/)
    assert.match(script, /const request = beginModelDiscovery\(state\.modelDiscovery\)/)
    assert.match(script, /completeModelDiscovery\(state\.modelDiscovery, request, payload\?\.models\)/)
    assert.match(script, /selectModelDiscoveryCredential\(state\.modelDiscovery,/)
    assert.match(script, /new AbortController\(\)/)
    assert.match(script, /signal: modelDiscoveryAbortController\.signal/)
    assert.match(script, /function removeDraftModel\(provider, model\)/)
    assert.match(script, /modelRefsEqual\(state\.modelPolicy\.draftActiveModel, target\)/)
    assert.match(script, /Select a replacement active model before removing this model\./)
    assert.match(script, /replaceModelPolicyDraft\(state\.modelPolicy,/)
    assert.doesNotMatch(script, /state\.modelPolicy\.dirty = true/)
    assert.match(script, /if \(state\.modelPolicy\.saving\) \{\s*return;/)
    assert.match(script, /modelPolicyPanel\.setAttribute\("aria-busy", String\(busy\)\)/)
    assert.match(script, /modelPolicyCredential\.disabled = busy/)
    assert.match(script, /modelPolicyList\.setAttribute\("aria-disabled", String\(state\.modelPolicy\.saving\)\)/)
    assert.doesNotMatch(script, /modelPolicy[^\n]*addEventListener\("change",[^\n]*saveModelPolicy/)
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
      /async function createCredential\(\) \{[\s\S]*await fetchJson\("\/credentials", \{\s*method: "POST"[\s\S]*await refreshSelectedUserAiAccessOptions\(mutation\)/,
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
    assert.match(script, /await refreshSelectedUserAiAccessOptions\(mutation\)/)
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
