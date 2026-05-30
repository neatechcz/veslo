import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { readFileSync } from "node:fs"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"
import { MySqlDialect, getTableConfig } from "drizzle-orm/mysql-core"

import { errorMiddleware } from "../src/http/errors.js"
import { InMemorySkillRegistryStore } from "../src/skills/store.js"
import { createDbSkillRegistryStore } from "../src/skills/db-store.js"
import { buildSkillRegistryPackageArchive } from "../src/skills/packages.js"

type TestSession = {
  userId: string
  orgId?: string | null
  orgRole?: "member" | "owner" | null
  isPlatformAdmin?: boolean
}

async function startServer(store = new InMemorySkillRegistryStore()) {
  setupEnv()
  const { createSkillRegistryRouter } = await import("../src/skills/routes.js")
  const app = express()
  app.use(express.json({ limit: "2mb" }))
  app.use(
    "/v1",
    createSkillRegistryRouter({
      store,
      resolveContext: async (req, res) => {
        const userId = req.header("x-test-user-id")
        if (!userId) {
          res.status(401).json({ error: "unauthorized" })
          return null
        }

        const context: TestSession = {
          userId,
          orgId: req.header("x-test-org-id") ?? null,
          orgRole: req.header("x-test-org-role") === "owner" ? "owner" : "member",
          isPlatformAdmin: req.header("x-test-platform-admin") === "1",
        }
        return context
      },
    }),
  )
  app.use(errorMiddleware)

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address() as AddressInfo

  return {
    store,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => {
      server.close()
      await once(server, "close")
    },
  }
}

const testSqlDialect = new MySqlDialect({ casing: "snake_case" })

class TestDbSkillRegistryDatabase {
  private readonly rows = new Map<string, Record<string, unknown>[]>()

  select(projection?: Record<string, { name: string }>) {
    return new TestSelectQuery(this.rows, projection)
  }

  insert(table: unknown) {
    return {
      values: (value: Record<string, unknown> | Record<string, unknown>[]) => {
        const tableRows = this.rowsFor(table)
        const inserted = Array.isArray(value) ? value : [value]
        for (const row of inserted) {
          tableRows.push({ ...row })
        }
        return new TestMutationQuery()
      },
    }
  }

  update(table: unknown) {
    return {
      set: (changes: Record<string, unknown>) => ({
        where: (where: unknown) => {
          const tableRows = this.rowsFor(table)
          for (const row of tableRows) {
            if (matchesWhere(row, where)) Object.assign(row, changes)
          }
          return new TestMutationQuery()
        },
      }),
    }
  }

  private rowsFor(table: unknown) {
    const name = tableName(table)
    const rows = this.rows.get(name) ?? []
    this.rows.set(name, rows)
    return rows
  }
}

class TestSelectQuery {
  private sourceRows: Record<string, unknown>[] = []
  private whereClause: unknown
  private limitCount: number | null = null
  private orderByColumns: Array<{ name: string }> = []

  constructor(
    private readonly rows: Map<string, Record<string, unknown>[]>,
    private readonly projection?: Record<string, { name: string }>,
  ) {}

  from(table: unknown) {
    this.sourceRows = this.rows.get(tableName(table)) ?? []
    return this
  }

  where(where: unknown) {
    this.whereClause = where
    return this
  }

  orderBy(...columns: Array<{ name: string }>) {
    this.orderByColumns = columns
    return this
  }

  limit(count: number) {
    this.limitCount = count
    return this
  }

  then<TResult1 = Record<string, unknown>[], TResult2 = never>(
    onfulfilled?: ((value: Record<string, unknown>[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected)
  }

  private run() {
    let result = this.sourceRows.filter((row) => matchesWhere(row, this.whereClause))
    for (const column of [...this.orderByColumns].reverse()) {
      result = result.slice().sort((left, right) => compareDescending(left[column.name], right[column.name]))
    }
    if (this.limitCount !== null) result = result.slice(0, this.limitCount)
    return result.map((row) => projectRow(row, this.projection))
  }
}

class TestMutationQuery {
  onDuplicateKeyUpdate() {
    return this
  }

  then<TResult1 = void, TResult2 = never>(
    onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    return Promise.resolve().then(onfulfilled, onrejected)
  }
}

function dbBackedSkillRegistryStore() {
  return createDbSkillRegistryStore(new TestDbSkillRegistryDatabase() as never)
}

function tableName(table: unknown) {
  return getTableConfig(table as never).name
}

function projectRow(row: Record<string, unknown>, projection?: Record<string, { name: string }>) {
  if (!projection) return { ...row }
  return Object.fromEntries(Object.entries(projection).map(([key, column]) => [key, row[column.name]]))
}

function matchesWhere(row: Record<string, unknown>, where: unknown) {
  if (!where) return true
  const { sql, params } = testSqlDialect.sqlToQuery(where as never)
  const comparisons = sql.replace(/^\(|\)$/g, "").split(/\s+and\s+/i)
  let paramIndex = 0
  for (const comparison of comparisons) {
    const equals = comparison.match(/`[^`]+`\.`([^`]+)` = \?/)
    if (equals) {
      if (row[equals[1]] !== params[paramIndex++]) return false
      continue
    }
    const isNull = comparison.match(/`[^`]+`\.`([^`]+)` is null/)
    if (isNull) {
      if (row[isNull[1]] !== null) return false
      continue
    }
    throw new Error(`unsupported test DB where clause: ${comparison}`)
  }
  return true
}

function compareDescending(left: unknown, right: unknown) {
  const leftValue = left instanceof Date ? left.getTime() : left
  const rightValue = right instanceof Date ? right.getTime() : right
  if (leftValue === rightValue) return 0
  return leftValue < rightValue ? 1 : -1
}

function setupEnv() {
  process.env.DATABASE_URL ??= "mysql://root:root@localhost:3306/veslo_test"
  process.env.BETTER_AUTH_SECRET ??= "0123456789abcdef0123456789abcdef"
  process.env.BETTER_AUTH_URL ??= "http://localhost:8788"
}

async function jsonRequest(baseUrl: string, path: string, init: RequestInit & { session?: TestSession } = {}) {
  const headers = new Headers(init.headers)
  headers.set("content-type", "application/json")
  headers.set("x-test-user-id", init.session?.userId ?? "user_1")
  if (init.session?.orgId) headers.set("x-test-org-id", init.session.orgId)
  if (init.session?.orgRole) headers.set("x-test-org-role", init.session.orgRole)
  if (init.session?.isPlatformAdmin) headers.set("x-test-platform-admin", "1")

  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
  })
  const body = await response.json().catch(() => null)
  return { response, body }
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex")
}

async function packageArchive(name: string, body: string, extraFiles: Record<string, string> = {}) {
  const files = [
    {
      path: "SKILL.md",
      bytes: Buffer.from(body, "utf8"),
      mediaType: "text/markdown",
      executable: false,
    },
    ...Object.entries(extraFiles).map(([path, content]) => ({
      path,
      bytes: Buffer.from(content, "utf8"),
      mediaType: path.endsWith(".js") ? "text/javascript" : "text/plain",
      executable: path.endsWith(".sh"),
    })),
  ]
  return buildSkillRegistryPackageArchive({
    metadata: {
      name,
      description: `${name} description`,
      tags: ["automation", "local-first"],
      language: "en",
    },
    files,
  })
}

async function createApprovedOrgSkillVersion(
  server: Awaited<ReturnType<typeof startServer>>,
  owner: TestSession,
  name: string,
) {
  const { body: createdSkill } = await jsonRequest(server.baseUrl, "/skills", {
    method: "POST",
    body: JSON.stringify({ scope: "org", orgId: owner.orgId, name }),
    session: owner,
  })
  const archive = await packageArchive(name, `# ${name}\n`)
  const { body: version } = await jsonRequest(server.baseUrl, `/skills/${createdSkill.skill.id}/versions`, {
    method: "POST",
    body: JSON.stringify({ package: archive }),
    session: owner,
  })
  const { body: review } = await jsonRequest(server.baseUrl, `/skills/${createdSkill.skill.id}/review-requests`, {
    method: "POST",
    body: JSON.stringify({ scope: "org", orgId: owner.orgId, versionId: version.version.id }),
    session: owner,
  })
  await jsonRequest(server.baseUrl, `/skill-review-requests/${review.requestId}/approve`, {
    method: "POST",
    body: JSON.stringify({}),
    session: owner,
  })
  return { skill: createdSkill.skill, version: version.version }
}

async function createPersonalSkillVersion(
  server: Awaited<ReturnType<typeof startServer>>,
  owner: TestSession,
  name: string,
) {
  const { body: createdSkill } = await jsonRequest(server.baseUrl, "/skills", {
    method: "POST",
    body: JSON.stringify({ scope: "user", name }),
    session: owner,
  })
  const archive = await packageArchive(name, `# ${name}\n`)
  const { body: version } = await jsonRequest(server.baseUrl, `/skills/${createdSkill.skill.id}/versions`, {
    method: "POST",
    body: JSON.stringify({ package: archive }),
    session: owner,
  })
  return { skill: createdSkill.skill, version: version.version }
}

async function createApprovedSystemSkillVersion(
  server: Awaited<ReturnType<typeof startServer>>,
  platformAdmin: TestSession,
  name: string,
) {
  const { body: createdSkill } = await jsonRequest(server.baseUrl, "/skills", {
    method: "POST",
    body: JSON.stringify({ scope: "system", name }),
    session: platformAdmin,
  })
  const archive = await packageArchive(name, `# ${name}\n`)
  const { body: version } = await jsonRequest(server.baseUrl, `/skills/${createdSkill.skill.id}/versions`, {
    method: "POST",
    body: JSON.stringify({ package: archive }),
    session: platformAdmin,
  })
  const { body: review } = await jsonRequest(server.baseUrl, `/skills/${createdSkill.skill.id}/review-requests`, {
    method: "POST",
    body: JSON.stringify({ scope: "system", versionId: version.version.id }),
    session: platformAdmin,
  })
  await jsonRequest(server.baseUrl, `/skill-review-requests/${review.requestId}/approve`, {
    method: "POST",
    body: JSON.stringify({}),
    session: platformAdmin,
  })
  return { skill: createdSkill.skill, version: version.version }
}

test("rollout policy installs org skill as user-global for one user", async () => {
  const server = await startServer()
  try {
    const owner = { userId: "owner_1", orgId: "org_1", orgRole: "owner" as const }
    const { skill, version } = await createApprovedOrgSkillVersion(server, owner, "meeting-minutes")

    const { response, body } = await jsonRequest(server.baseUrl, "/skill-rollout-policies", {
      method: "POST",
      body: JSON.stringify({
        skillId: skill.id,
        versionId: version.id,
        target: "user-global",
        audience: "user",
        userId: "user_1",
        catalogScope: "organization",
        orgId: "org_1",
      }),
      session: owner,
    })

    assert.equal(response.status, 201)
    assert.equal(body.policy.target, "user-global")
    assert.equal(body.policy.audience, "user")
    assert.equal(body.policy.versionId, version.id)
    assert.equal(body.policy.removalPolicy, "user_removable")

    const { response: listResponse, body: listed } = await jsonRequest(
      server.baseUrl,
      "/skill-rollout-policies?target=user-global",
      { session: owner },
    )
    assert.equal(listResponse.status, 200)
    assert.equal(listed.policies.length, 1)
    assert.equal(listed.nextCursor, null)
    assert.ok(server.store.snapshot().events.some((event) => event.action === "skill.rollout_policy.changed"))
  } finally {
    await server.close()
  }
})

test("rollout policies require catalog-owner approvals", async () => {
  const server = await startServer()
  try {
    const owner = { userId: "owner_1", orgId: "org_1", orgRole: "owner" as const }
    const platformAdmin = { userId: "platform_owner", isPlatformAdmin: true }
    const { skill: missingSkill, version: missingVersion } = await createPersonalSkillVersion(
      server,
      owner,
      "missing-org-approval-tool",
    )

    const missingApproval = await jsonRequest(server.baseUrl, "/skill-rollout-policies", {
      method: "POST",
      body: JSON.stringify({
        skillId: missingSkill.id,
        versionId: missingVersion.id,
        target: "user-global",
        audience: "user",
        userId: "user_1",
        catalogScope: "organization",
        orgId: "org_1",
      }),
      session: owner,
    })
    assert.equal(missingApproval.response.status, 409)
    assert.equal(missingApproval.body.error, "approval_missing")

    const { skill: systemApprovedSkill, version: systemApprovedVersion } = await createPersonalSkillVersion(
      server,
      owner,
      "wrong-scope-approval-tool",
    )
    const { body: systemReview } = await jsonRequest(
      server.baseUrl,
      `/skills/${systemApprovedSkill.id}/review-requests`,
      {
        method: "POST",
        body: JSON.stringify({ scope: "system", versionId: systemApprovedVersion.id }),
        session: owner,
      },
    )
    await jsonRequest(server.baseUrl, `/skill-review-requests/${systemReview.requestId}/approve`, {
      method: "POST",
      body: JSON.stringify({}),
      session: platformAdmin,
    })

    const wrongScope = await jsonRequest(server.baseUrl, "/skill-rollout-policies", {
      method: "POST",
      body: JSON.stringify({
        skillId: systemApprovedSkill.id,
        versionId: systemApprovedVersion.id,
        target: "user-global",
        audience: "user",
        userId: "user_1",
        catalogScope: "organization",
        orgId: "org_1",
      }),
      session: owner,
    })
    assert.equal(wrongScope.response.status, 409)
    assert.equal(wrongScope.body.error, "approval_scope_mismatch")
  } finally {
    await server.close()
  }
})

test("rollout policies reject mismatched audience selectors", async () => {
  const server = await startServer()
  try {
    const owner = { userId: "owner_1", orgId: "org_1", orgRole: "owner" as const }
    const platformAdmin = { userId: "platform_owner", isPlatformAdmin: true }
    const { skill, version } = await createApprovedOrgSkillVersion(server, owner, "audience-shape-tool")

    const selectedWorkspaceWithUser = await jsonRequest(server.baseUrl, "/skill-rollout-policies", {
      method: "POST",
      body: JSON.stringify({
        skillId: skill.id,
        versionId: version.id,
        target: "workspace",
        audience: "selected-workspaces",
        userId: "user_1",
        workspaceId: "workspace_1",
        catalogScope: "organization",
        orgId: "org_1",
      }),
      session: owner,
    })
    assert.equal(selectedWorkspaceWithUser.response.status, 400)
    assert.equal(selectedWorkspaceWithUser.body.error, "user_id_forbidden")

    const allOrgUsersWithUser = await jsonRequest(server.baseUrl, "/skill-rollout-policies", {
      method: "POST",
      body: JSON.stringify({
        skillId: skill.id,
        versionId: version.id,
        target: "user-global",
        audience: "all-org-users",
        userId: "user_1",
        catalogScope: "organization",
        orgId: "org_1",
      }),
      session: owner,
    })
    assert.equal(allOrgUsersWithUser.response.status, 400)
    assert.equal(allOrgUsersWithUser.body.error, "user_id_forbidden")

    const { skill: systemSkill, version: systemVersion } = await createApprovedSystemSkillVersion(
      server,
      platformAdmin,
      "platform-audience-shape-tool",
    )
    const platformWithUser = await jsonRequest(server.baseUrl, "/skill-rollout-policies", {
      method: "POST",
      body: JSON.stringify({
        skillId: systemSkill.id,
        versionId: systemVersion.id,
        target: "user-global",
        audience: "all-platform-users",
        userId: "user_1",
        catalogScope: "platform",
      }),
      session: platformAdmin,
    })
    assert.equal(platformWithUser.response.status, 400)
    assert.equal(platformWithUser.body.error, "user_id_forbidden")

    const platformWithOrg = await jsonRequest(server.baseUrl, "/skill-rollout-policies", {
      method: "POST",
      body: JSON.stringify({
        skillId: systemSkill.id,
        versionId: systemVersion.id,
        target: "user-global",
        audience: "all-platform-users",
        catalogScope: "platform",
        orgId: "org_1",
      }),
      session: platformAdmin,
    })
    assert.equal(platformWithOrg.response.status, 400)
    assert.equal(platformWithOrg.body.error, "org_id_forbidden")
  } finally {
    await server.close()
  }
})

test("DB-backed rollout policy routes require catalog-owner approvals for create and update", async () => {
  const server = await startServer(dbBackedSkillRegistryStore())
  try {
    const owner = { userId: "owner_1", orgId: "org_1", orgRole: "owner" as const }
    const platformAdmin = { userId: "platform_owner", isPlatformAdmin: true }
    const { skill: missingSkill, version: missingVersion } = await createPersonalSkillVersion(
      server,
      owner,
      "db-missing-org-approval-tool",
    )

    const missingApprovalCreate = await jsonRequest(server.baseUrl, "/skill-rollout-policies", {
      method: "POST",
      body: JSON.stringify({
        skillId: missingSkill.id,
        versionId: missingVersion.id,
        target: "user-global",
        audience: "user",
        userId: "user_1",
        catalogScope: "organization",
        orgId: "org_1",
      }),
      session: owner,
    })
    assert.equal(missingApprovalCreate.response.status, 409)
    assert.equal(missingApprovalCreate.body.error, "approval_missing")

    const { body: createdMissingPolicy } = await jsonRequest(server.baseUrl, "/skill-rollout-policies", {
      method: "POST",
      body: JSON.stringify({
        skillId: missingSkill.id,
        target: "user-global",
        audience: "user",
        userId: "user_1",
        catalogScope: "organization",
        orgId: "org_1",
      }),
      session: owner,
    })
    const missingApprovalUpdate = await jsonRequest(
      server.baseUrl,
      `/skill-rollout-policies/${createdMissingPolicy.policy.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ versionId: missingVersion.id }),
        session: owner,
      },
    )
    assert.equal(missingApprovalUpdate.response.status, 409)
    assert.equal(missingApprovalUpdate.body.error, "approval_missing")

    const { skill: systemApprovedSkill, version: systemApprovedVersion } = await createPersonalSkillVersion(
      server,
      owner,
      "db-wrong-scope-approval-tool",
    )
    const { body: systemReview } = await jsonRequest(
      server.baseUrl,
      `/skills/${systemApprovedSkill.id}/review-requests`,
      {
        method: "POST",
        body: JSON.stringify({ scope: "system", versionId: systemApprovedVersion.id }),
        session: owner,
      },
    )
    await jsonRequest(server.baseUrl, `/skill-review-requests/${systemReview.requestId}/approve`, {
      method: "POST",
      body: JSON.stringify({}),
      session: platformAdmin,
    })

    const wrongScopeCreate = await jsonRequest(server.baseUrl, "/skill-rollout-policies", {
      method: "POST",
      body: JSON.stringify({
        skillId: systemApprovedSkill.id,
        versionId: systemApprovedVersion.id,
        target: "user-global",
        audience: "user",
        userId: "user_2",
        catalogScope: "organization",
        orgId: "org_1",
      }),
      session: owner,
    })
    assert.equal(wrongScopeCreate.response.status, 409)
    assert.equal(wrongScopeCreate.body.error, "approval_scope_mismatch")

    const { body: createdWrongScopePolicy } = await jsonRequest(server.baseUrl, "/skill-rollout-policies", {
      method: "POST",
      body: JSON.stringify({
        skillId: systemApprovedSkill.id,
        target: "user-global",
        audience: "user",
        userId: "user_2",
        catalogScope: "organization",
        orgId: "org_1",
      }),
      session: owner,
    })
    const wrongScopeUpdate = await jsonRequest(
      server.baseUrl,
      `/skill-rollout-policies/${createdWrongScopePolicy.policy.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ versionId: systemApprovedVersion.id }),
        session: owner,
      },
    )
    assert.equal(wrongScopeUpdate.response.status, 409)
    assert.equal(wrongScopeUpdate.body.error, "approval_scope_mismatch")
  } finally {
    await server.close()
  }
})

test("DB-backed rollout policy routes reject invalid audience selector shapes", async () => {
  const server = await startServer(dbBackedSkillRegistryStore())
  try {
    const owner = { userId: "owner_1", orgId: "org_1", orgRole: "owner" as const }
    const platformAdmin = { userId: "platform_owner", isPlatformAdmin: true }
    const { skill, version } = await createApprovedOrgSkillVersion(server, owner, "db-audience-shape-tool")

    const selectedWorkspaceWithUser = await jsonRequest(server.baseUrl, "/skill-rollout-policies", {
      method: "POST",
      body: JSON.stringify({
        skillId: skill.id,
        versionId: version.id,
        target: "workspace",
        audience: "selected-workspaces",
        userId: "user_1",
        workspaceId: "workspace_1",
        catalogScope: "organization",
        orgId: "org_1",
      }),
      session: owner,
    })
    assert.equal(selectedWorkspaceWithUser.response.status, 400)
    assert.equal(selectedWorkspaceWithUser.body.error, "user_id_forbidden")

    const { body: createdPolicy } = await jsonRequest(server.baseUrl, "/skill-rollout-policies", {
      method: "POST",
      body: JSON.stringify({
        skillId: skill.id,
        versionId: version.id,
        target: "user-global",
        audience: "user",
        userId: "user_1",
        catalogScope: "organization",
        orgId: "org_1",
      }),
      session: owner,
    })
    const allOrgUsersWithUser = await jsonRequest(
      server.baseUrl,
      `/skill-rollout-policies/${createdPolicy.policy.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          audience: "all-org-users",
          userId: "user_1",
        }),
        session: owner,
      },
    )
    assert.equal(allOrgUsersWithUser.response.status, 400)
    assert.equal(allOrgUsersWithUser.body.error, "user_id_forbidden")

    const { skill: systemSkill, version: systemVersion } = await createApprovedSystemSkillVersion(
      server,
      platformAdmin,
      "db-platform-audience-shape-tool",
    )
    const platformWithOrg = await jsonRequest(server.baseUrl, "/skill-rollout-policies", {
      method: "POST",
      body: JSON.stringify({
        skillId: systemSkill.id,
        versionId: systemVersion.id,
        target: "user-global",
        audience: "all-platform-users",
        catalogScope: "platform",
        orgId: "org_1",
      }),
      session: platformAdmin,
    })
    assert.equal(platformWithOrg.response.status, 400)
    assert.equal(platformWithOrg.body.error, "org_id_forbidden")
  } finally {
    await server.close()
  }
})

test("rollout policies reject user-global and workspace targets for same skill and audience", async () => {
  const server = await startServer()
  try {
    const owner = { userId: "owner_1", orgId: "org_1", orgRole: "owner" as const }
    const { skill, version } = await createApprovedOrgSkillVersion(server, owner, "office-writer")

    await jsonRequest(server.baseUrl, "/skill-rollout-policies", {
      method: "POST",
      body: JSON.stringify({
        skillId: skill.id,
        versionId: version.id,
        target: "user-global",
        audience: "user",
        userId: "user_1",
        catalogScope: "organization",
        orgId: "org_1",
      }),
      session: owner,
    })
    const { response, body } = await jsonRequest(server.baseUrl, "/skill-rollout-policies", {
      method: "POST",
      body: JSON.stringify({
        skillId: skill.id,
        versionId: version.id,
        target: "workspace",
        audience: "selected-workspaces",
        workspaceId: "workspace_1",
        catalogScope: "organization",
        orgId: "org_1",
      }),
      session: owner,
    })

    assert.equal(response.status, 409)
    assert.equal(body.error, "target_conflict")
  } finally {
    await server.close()
  }
})

test("rollout policy mutations require org admin and locked policies block user deletion", async () => {
  const server = await startServer()
  try {
    const owner = { userId: "owner_1", orgId: "org_1", orgRole: "owner" as const }
    const member = { userId: "member_1", orgId: "org_1", orgRole: "member" as const }
    const { skill, version } = await createApprovedOrgSkillVersion(server, owner, "locked-org-tool")

    const nonOwnerCreate = await jsonRequest(server.baseUrl, "/skill-rollout-policies", {
      method: "POST",
      body: JSON.stringify({
        skillId: skill.id,
        versionId: version.id,
        target: "user-global",
        audience: "user",
        userId: "member_1",
        catalogScope: "organization",
        orgId: "org_1",
      }),
      session: member,
    })
    assert.equal(nonOwnerCreate.response.status, 403)

    const { body: created } = await jsonRequest(server.baseUrl, "/skill-rollout-policies", {
      method: "POST",
      body: JSON.stringify({
        skillId: skill.id,
        versionId: version.id,
        target: "user-global",
        audience: "user",
        userId: "member_1",
        catalogScope: "organization",
        orgId: "org_1",
        removalPolicy: "locked",
      }),
      session: owner,
    })

    const lockedDelete = await jsonRequest(server.baseUrl, `/skill-rollout-policies/${created.policy.id}`, {
      method: "DELETE",
      session: member,
    })

    assert.equal(lockedDelete.response.status, 409)
    assert.equal(lockedDelete.body.error, "removal_not_allowed")
  } finally {
    await server.close()
  }
})

test("package upload creates an immutable content-addressed version", async () => {
  const server = await startServer()
  try {
    const { body: createdSkill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({
        scope: "user",
        name: "deploy-helper",
        description: "Deploy helper",
      }),
    })

    const archive = await packageArchive("deploy-helper", "# Deploy\n", {
      "scripts/run.js": "console.log('deploy')\n",
    })
    const { response: uploadResponse, body: uploaded } = await jsonRequest(
      server.baseUrl,
      `/skills/${createdSkill.skill.id}/versions`,
      {
        method: "POST",
        body: JSON.stringify({ package: archive }),
      },
    )

    assert.equal(uploadResponse.status, 201)
    assert.equal(uploaded.version.version, "1")
    assert.equal(uploaded.version.packageSha256, archive.packageSha256)

    const { body: downloaded } = await jsonRequest(
      server.baseUrl,
      `/skill-versions/${uploaded.version.id}/package`,
    )
    assert.equal(downloaded.versionId, uploaded.version.id)
    assert.deepEqual(downloaded.package, archive)

    const firstBlobCount = server.store.snapshot().blobs.length
    const { body: secondVersion } = await jsonRequest(
      server.baseUrl,
      `/skills/${createdSkill.skill.id}/versions`,
      {
        method: "POST",
        body: JSON.stringify({ package: archive }),
      },
    )
    assert.equal(secondVersion.version.version, "2")
    assert.equal(server.store.snapshot().blobs.length, firstBlobCount)

    assert.deepEqual(
      server.store.snapshot().events.map((event) => event.action),
      ["skill.version.created", "skill.version.created"],
    )
  } finally {
    await server.close()
  }
})

test("editing a skill creates a new version instead of mutating the previous package", async () => {
  const server = await startServer()
  try {
    const { body: createdSkill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "user", name: "editor", description: "Editor" }),
    })
    const originalArchive = await packageArchive("editor", "# Original\n")
    const updatedArchive = await packageArchive("editor", "# Updated\n")

    const { body: original } = await jsonRequest(server.baseUrl, `/skills/${createdSkill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: originalArchive }),
    })
    const { body: updated } = await jsonRequest(server.baseUrl, `/skills/${createdSkill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: updatedArchive }),
    })

    assert.notEqual(updated.version.id, original.version.id)
    assert.equal(updated.version.version, "2")

    const { body: downloadedOriginal } = await jsonRequest(
      server.baseUrl,
      `/skill-versions/${original.version.id}/package`,
    )
    assert.equal(downloadedOriginal.package.packageSha256, originalArchive.packageSha256)
    assert.equal(downloadedOriginal.package.files[0].text, "# Original\n")
  } finally {
    await server.close()
  }
})

test("invalid package uploads return a typed client error", async () => {
  const server = await startServer()
  try {
    const { body: createdSkill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "user", name: "broken-package" }),
    })

    const { response, body } = await jsonRequest(server.baseUrl, `/skills/${createdSkill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: { schemaVersion: 1, entrypoint: "SKILL.md", files: [] } }),
    })

    assert.equal(response.status, 400)
    assert.equal(body.error, "invalid_skill_package")
  } finally {
    await server.close()
  }
})

test("delete soft-deletes an installation and restore can target original or new location", async () => {
  const server = await startServer()
  try {
    const { body: createdSkill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "user", name: "workspace-tool" }),
      session: { userId: "owner_1", orgId: "org_1", orgRole: "owner" },
    })
    const archive = await packageArchive("workspace-tool", "# Tool\n")
    const { body: createdVersion } = await jsonRequest(server.baseUrl, `/skills/${createdSkill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: archive }),
      session: { userId: "owner_1", orgId: "org_1", orgRole: "owner" },
    })
    const { body: installed } = await jsonRequest(server.baseUrl, "/skill-installations", {
      method: "POST",
      body: JSON.stringify({
        scope: "workspace",
        orgId: "org_1",
        workspaceId: "workspace_a",
        skillId: createdSkill.skill.id,
        versionId: createdVersion.version.id,
        updatePolicy: "pinned",
      }),
      session: { userId: "owner_1", orgId: "org_1", orgRole: "owner" },
    })

    const { response: deleteResponse, body: deleted } = await jsonRequest(
      server.baseUrl,
      `/skill-installations/${installed.installation.installationId}`,
      {
        method: "DELETE",
        session: { userId: "owner_1", orgId: "org_1", orgRole: "owner" },
      },
    )
    assert.equal(deleteResponse.status, 200)
    assert.equal(deleted.installation.enabled, false)
    assert.equal(server.store.snapshot().installations[0].status, "deleted")

    const { body: restoredOriginal } = await jsonRequest(
      server.baseUrl,
      `/skill-installations/${installed.installation.installationId}/restore`,
      {
        method: "POST",
        body: JSON.stringify({}),
        session: { userId: "owner_1", orgId: "org_1", orgRole: "owner" },
      },
    )
    assert.equal(restoredOriginal.installation.installationId, installed.installation.installationId)
    assert.equal(restoredOriginal.installation.enabled, true)

    await jsonRequest(server.baseUrl, `/skill-installations/${installed.installation.installationId}`, {
      method: "DELETE",
      session: { userId: "owner_1", orgId: "org_1", orgRole: "owner" },
    })
    const { body: restoredMoved } = await jsonRequest(
      server.baseUrl,
      `/skill-installations/${installed.installation.installationId}/restore`,
      {
        method: "POST",
        body: JSON.stringify({ workspaceId: "workspace_b" }),
        session: { userId: "owner_1", orgId: "org_1", orgRole: "owner" },
      },
    )
    assert.equal(restoredMoved.installation.installationId, installed.installation.installationId)
    assert.equal(server.store.snapshot().installations[0].workspaceId, "workspace_b")

    assert.deepEqual(
      server.store.snapshot().events
        .map((event) => event.action)
        .filter((action) => action === "skill.deleted" || action === "skill.restored"),
      ["skill.deleted", "skill.restored", "skill.deleted", "skill.restored"],
    )
  } finally {
    await server.close()
  }
})

test("workspace skill-set reads require organization context", async () => {
  const server = await startServer()
  try {
    const owner = { userId: "owner_1", orgId: "org_1", orgRole: "owner" as const }
    const { body: createdSkill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "user", name: "private-workspace-tool" }),
      session: owner,
    })
    const archive = await packageArchive("private-workspace-tool", "# Tool\n")
    const { body: createdVersion } = await jsonRequest(server.baseUrl, `/skills/${createdSkill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: archive }),
      session: owner,
    })
    const { body: installed } = await jsonRequest(server.baseUrl, "/skill-installations", {
      method: "POST",
      body: JSON.stringify({
        scope: "workspace",
        orgId: "org_1",
        workspaceId: "workspace_private",
        skillId: createdSkill.skill.id,
        versionId: createdVersion.version.id,
      }),
      session: owner,
    })
    await jsonRequest(server.baseUrl, "/workspaces/workspace_private/skill-set", {
      method: "PATCH",
      body: JSON.stringify({ skills: [{ installationId: installed.installation.installationId }] }),
      session: owner,
    })

    const { response } = await jsonRequest(server.baseUrl, "/workspaces/workspace_private/skill-set", {
      session: { userId: "stranger_1" },
    })
    assert.equal(response.status, 403)
  } finally {
    await server.close()
  }
})

test("deleted installations cannot be patched active or cleared to a null version", async () => {
  const server = await startServer()
  try {
    const owner = { userId: "owner_1", orgId: "org_1", orgRole: "owner" as const }
    const { body: createdSkill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "user", name: "patch-guard-tool" }),
      session: owner,
    })
    const archive = await packageArchive("patch-guard-tool", "# Tool\n")
    const { body: createdVersion } = await jsonRequest(server.baseUrl, `/skills/${createdSkill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: archive }),
      session: owner,
    })
    const { body: installed } = await jsonRequest(server.baseUrl, "/skill-installations", {
      method: "POST",
      body: JSON.stringify({
        scope: "workspace",
        orgId: "org_1",
        workspaceId: "workspace_patch_guard",
        skillId: createdSkill.skill.id,
        versionId: createdVersion.version.id,
      }),
      session: owner,
    })

    const { response: clearVersion } = await jsonRequest(
      server.baseUrl,
      `/skill-installations/${installed.installation.installationId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ versionId: null }),
        session: owner,
      },
    )
    assert.equal(clearVersion.status, 400)

    await jsonRequest(server.baseUrl, `/skill-installations/${installed.installation.installationId}`, {
      method: "DELETE",
      session: owner,
    })
    const { response: reactivate } = await jsonRequest(
      server.baseUrl,
      `/skill-installations/${installed.installation.installationId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ enabled: true }),
        session: owner,
      },
    )
    assert.equal(reactivate.status, 409)
    assert.equal(server.store.snapshot().installations[0].status, "deleted")
  } finally {
    await server.close()
  }
})

test("org and workspace installation mutations require an owner or platform admin", async () => {
  const server = await startServer()
  try {
    const owner = { userId: "owner_1", orgId: "org_1", orgRole: "owner" as const }
    const member = { userId: "member_1", orgId: "org_1", orgRole: "member" as const }
    const { body: createdSkill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "user", name: "restricted-tool" }),
      session: owner,
    })
    const archive = await packageArchive("restricted-tool", "# Tool\n")
    const { body: createdVersion } = await jsonRequest(server.baseUrl, `/skills/${createdSkill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: archive }),
      session: owner,
    })
    const { body: installed } = await jsonRequest(server.baseUrl, "/skill-installations", {
      method: "POST",
      body: JSON.stringify({
        scope: "workspace",
        orgId: "org_1",
        workspaceId: "workspace_a",
        skillId: createdSkill.skill.id,
        versionId: createdVersion.version.id,
      }),
      session: owner,
    })

    const { response: memberPatch } = await jsonRequest(
      server.baseUrl,
      `/skill-installations/${installed.installation.installationId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
        session: member,
      },
    )
    assert.equal(memberPatch.status, 403)

    const { response: memberDelete } = await jsonRequest(
      server.baseUrl,
      `/skill-installations/${installed.installation.installationId}`,
      {
        method: "DELETE",
        session: member,
      },
    )
    assert.equal(memberDelete.status, 403)

    await jsonRequest(server.baseUrl, `/skill-installations/${installed.installation.installationId}`, {
      method: "DELETE",
      session: owner,
    })
    const { response: memberRestore } = await jsonRequest(
      server.baseUrl,
      `/skill-installations/${installed.installation.installationId}/restore`,
      {
        method: "POST",
        body: JSON.stringify({}),
        session: member,
      },
    )
    assert.equal(memberRestore.status, 403)
  } finally {
    await server.close()
  }
})

test("personal installation cannot target another user", async () => {
  const server = await startServer()
  try {
    const { body: createdSkill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "user", name: "personal-target-tool" }),
      session: { userId: "user_1" },
    })
    const archive = await packageArchive("personal-target-tool", "# Tool\n")
    const { body: createdVersion } = await jsonRequest(server.baseUrl, `/skills/${createdSkill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: archive }),
      session: { userId: "user_1" },
    })

    const { response } = await jsonRequest(server.baseUrl, "/skill-installations", {
      method: "POST",
      body: JSON.stringify({
        scope: "user",
        ownerUserId: "user_2",
        skillId: createdSkill.skill.id,
        versionId: createdVersion.version.id,
      }),
      session: { userId: "user_1" },
    })
    assert.equal(response.status, 403)
  } finally {
    await server.close()
  }
})

test("org and system publish require scoped approval before managed installation", async () => {
  const server = await startServer()
  try {
    const orgAdmin = { userId: "org_owner", orgId: "org_1", orgRole: "owner" as const }
    const platformAdmin = { userId: "platform_owner", isPlatformAdmin: true }

    const { body: orgSkill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "org", orgId: "org_1", name: "org-tool" }),
      session: orgAdmin,
    })
    const orgArchive = await packageArchive("org-tool", "# Org\n")
    const { body: orgVersion } = await jsonRequest(server.baseUrl, `/skills/${orgSkill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: orgArchive }),
      session: orgAdmin,
    })
    const { response: rejectedInstall } = await jsonRequest(server.baseUrl, "/skill-installations", {
      method: "POST",
      body: JSON.stringify({
        scope: "org",
        orgId: "org_1",
        skillId: orgSkill.skill.id,
        versionId: orgVersion.version.id,
        updatePolicy: "latest_approved",
      }),
      session: orgAdmin,
    })
    assert.equal(rejectedInstall.status, 409)

    const { body: reviewRequest } = await jsonRequest(
      server.baseUrl,
      `/skills/${orgSkill.skill.id}/review-requests`,
      {
        method: "POST",
        body: JSON.stringify({ scope: "org", versionId: orgVersion.version.id, releaseChannel: "stable" }),
        session: orgAdmin,
      },
    )
    assert.equal(reviewRequest.status, "pending_review")
    const { body: approvedReview } = await jsonRequest(
      server.baseUrl,
      `/skill-review-requests/${reviewRequest.requestId}/approve`,
      {
        method: "POST",
        body: JSON.stringify({ releaseChannel: "stable" }),
        session: orgAdmin,
      },
    )
    assert.equal(approvedReview.status, "approved")

    const { response: approvedInstall } = await jsonRequest(server.baseUrl, "/skill-installations", {
      method: "POST",
      body: JSON.stringify({
        scope: "org",
        orgId: "org_1",
        skillId: orgSkill.skill.id,
        versionId: orgVersion.version.id,
        updatePolicy: "latest_approved",
      }),
      session: orgAdmin,
    })
    assert.equal(approvedInstall.status, 201)

    const { body: systemSkill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "system", name: "platform-tool" }),
      session: platformAdmin,
    })
    const systemArchive = await packageArchive("platform-tool", "# Platform\n")
    const { body: systemVersion } = await jsonRequest(
      server.baseUrl,
      `/skills/${systemSkill.skill.id}/versions`,
      {
        method: "POST",
        body: JSON.stringify({ package: systemArchive }),
        session: platformAdmin,
      },
    )
    const { body: systemReview } = await jsonRequest(
      server.baseUrl,
      `/skills/${systemSkill.skill.id}/review-requests`,
      {
        method: "POST",
        body: JSON.stringify({ scope: "system", versionId: systemVersion.version.id }),
        session: platformAdmin,
      },
    )
    const { response: forbiddenSystemApprove } = await jsonRequest(
      server.baseUrl,
      `/skill-review-requests/${systemReview.requestId}/approve`,
      {
        method: "POST",
        body: JSON.stringify({}),
        session: orgAdmin,
      },
    )
    assert.equal(forbiddenSystemApprove.status, 403)

    const { response: approvedSystem } = await jsonRequest(
      server.baseUrl,
      `/skill-review-requests/${systemReview.requestId}/approve`,
      {
        method: "POST",
        body: JSON.stringify({}),
        session: platformAdmin,
      },
    )
    assert.equal(approvedSystem.status, 200)
  } finally {
    await server.close()
  }
})

test("review requests cannot downgrade managed approvals or mismatch governance scope", async () => {
  const server = await startServer()
  try {
    const orgAdmin = { userId: "org_owner", orgId: "org_1", orgRole: "owner" as const }
    const orgMember = { userId: "org_member", orgId: "org_1", orgRole: "member" as const }
    const platformAdmin = { userId: "platform_owner", isPlatformAdmin: true }
    const { body: orgSkill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "org", orgId: "org_1", name: "approved-org-tool" }),
      session: orgAdmin,
    })
    const orgArchive = await packageArchive("approved-org-tool", "# Org\n")
    const { body: orgVersion } = await jsonRequest(server.baseUrl, `/skills/${orgSkill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: orgArchive }),
      session: orgAdmin,
    })
    const { body: orgReview } = await jsonRequest(server.baseUrl, `/skills/${orgSkill.skill.id}/review-requests`, {
      method: "POST",
      body: JSON.stringify({ scope: "org", orgId: "org_1", versionId: orgVersion.version.id }),
      session: orgAdmin,
    })
    await jsonRequest(server.baseUrl, `/skill-review-requests/${orgReview.requestId}/approve`, {
      method: "POST",
      body: JSON.stringify({}),
      session: orgAdmin,
    })

    const { response: orgDowngrade } = await jsonRequest(server.baseUrl, `/skills/${orgSkill.skill.id}/review-requests`, {
      method: "POST",
      body: JSON.stringify({ scope: "org", orgId: "org_1", versionId: orgVersion.version.id }),
      session: orgMember,
    })
    assert.equal(orgDowngrade.status, 409)

    const { body: systemSkill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "system", name: "system-review-tool" }),
      session: platformAdmin,
    })
    const systemArchive = await packageArchive("system-review-tool", "# System\n")
    const { body: systemVersion } = await jsonRequest(server.baseUrl, `/skills/${systemSkill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: systemArchive }),
      session: platformAdmin,
    })
    const { response: scopeMismatch } = await jsonRequest(
      server.baseUrl,
      `/skills/${systemSkill.skill.id}/review-requests`,
      {
        method: "POST",
        body: JSON.stringify({ scope: "org", orgId: "org_1", versionId: systemVersion.version.id }),
        session: orgAdmin,
      },
    )
    assert.equal(scopeMismatch.status, 400)

    const { body: systemReview } = await jsonRequest(server.baseUrl, `/skills/${systemSkill.skill.id}/review-requests`, {
      method: "POST",
      body: JSON.stringify({ scope: "system", versionId: systemVersion.version.id }),
      session: platformAdmin,
    })
    await jsonRequest(server.baseUrl, `/skill-review-requests/${systemReview.requestId}/approve`, {
      method: "POST",
      body: JSON.stringify({}),
      session: platformAdmin,
    })
    const { response: systemDowngrade } = await jsonRequest(
      server.baseUrl,
      `/skills/${systemSkill.skill.id}/review-requests`,
      {
        method: "POST",
        body: JSON.stringify({ scope: "system", versionId: systemVersion.version.id }),
        session: { userId: "user_1" },
      },
    )
    assert.equal(systemDowngrade.status, 409)
  } finally {
    await server.close()
  }
})

test("org members can request review without approval privileges", async () => {
  const server = await startServer()
  try {
    const owner = { userId: "org_owner", orgId: "org_1", orgRole: "owner" as const }
    const member = { userId: "org_member", orgId: "org_1", orgRole: "member" as const }
    const { body: skill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "org", orgId: "org_1", name: "member-review-tool" }),
      session: owner,
    })
    const archive = await packageArchive("member-review-tool", "# Review\n")
    const { body: version } = await jsonRequest(server.baseUrl, `/skills/${skill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: archive }),
      session: owner,
    })

    const { response, body } = await jsonRequest(server.baseUrl, `/skills/${skill.skill.id}/review-requests`, {
      method: "POST",
      body: JSON.stringify({ scope: "org", orgId: "org_1", versionId: version.version.id }),
      session: member,
    })

    assert.equal(response.status, 201)
    assert.equal(body.status, "pending_review")

    const { response: forbiddenApprove } = await jsonRequest(
      server.baseUrl,
      `/skill-review-requests/${body.requestId}/approve`,
      {
        method: "POST",
        body: JSON.stringify({}),
        session: member,
      },
    )
    assert.equal(forbiddenApprove.status, 403)
  } finally {
    await server.close()
  }
})

test("approved broader review makes a skill visible in the requested scope", async () => {
  const server = await startServer()
  try {
    const personalOwner = { userId: "user_1", orgId: "org_1", orgRole: "member" as const }
    const orgAdmin = { userId: "org_owner", orgId: "org_1", orgRole: "owner" as const }
    const orgMember = { userId: "user_2", orgId: "org_1", orgRole: "member" as const }
    const outsideUser = { userId: "outside_user" }
    const { body: personalSkill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "user", name: "personal-to-org" }),
      session: personalOwner,
    })
    const personalArchive = await packageArchive("personal-to-org", "# Org\n")
    const { body: personalVersion } = await jsonRequest(server.baseUrl, `/skills/${personalSkill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: personalArchive }),
      session: personalOwner,
    })
    const { body: orgReview } = await jsonRequest(server.baseUrl, `/skills/${personalSkill.skill.id}/review-requests`, {
      method: "POST",
      body: JSON.stringify({ scope: "org", orgId: "org_1", versionId: personalVersion.version.id }),
      session: personalOwner,
    })
    await jsonRequest(server.baseUrl, `/skill-review-requests/${orgReview.requestId}/approve`, {
      method: "POST",
      body: JSON.stringify({}),
      session: orgAdmin,
    })

    const { response: orgRead, body: orgVisibleSkill } = await jsonRequest(
      server.baseUrl,
      `/skills/${personalSkill.skill.id}`,
      { session: orgMember },
    )
    assert.equal(orgRead.status, 200)
    assert.equal(orgVisibleSkill.skill.visibility, "organization")

    const { response: outsideRead } = await jsonRequest(
      server.baseUrl,
      `/skills/${personalSkill.skill.id}`,
      { session: outsideUser },
    )
    assert.equal(outsideRead.status, 404)

    const { body: orgSkill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "org", orgId: "org_1", name: "org-to-platform" }),
      session: orgAdmin,
    })
    const orgArchive = await packageArchive("org-to-platform", "# Platform\n")
    const { body: orgVersion } = await jsonRequest(server.baseUrl, `/skills/${orgSkill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: orgArchive }),
      session: orgAdmin,
    })
    const { body: systemReview } = await jsonRequest(server.baseUrl, `/skills/${orgSkill.skill.id}/review-requests`, {
      method: "POST",
      body: JSON.stringify({ scope: "system", versionId: orgVersion.version.id }),
      session: orgAdmin,
    })
    await jsonRequest(server.baseUrl, `/skill-review-requests/${systemReview.requestId}/approve`, {
      method: "POST",
      body: JSON.stringify({}),
      session: { userId: "platform_owner", isPlatformAdmin: true },
    })

    const { response: publicRead, body: platformVisibleSkill } = await jsonRequest(
      server.baseUrl,
      `/skills/${orgSkill.skill.id}`,
      { session: outsideUser },
    )
    assert.equal(publicRead.status, 200)
    assert.equal(platformVisibleSkill.skill.visibility, "platform")
  } finally {
    await server.close()
  }
})

test("review requests can only be resolved once", async () => {
  const server = await startServer()
  try {
    const orgAdmin = { userId: "org_owner", orgId: "org_1", orgRole: "owner" as const }
    const { body: skill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "org", orgId: "org_1", name: "single-resolution-tool" }),
      session: orgAdmin,
    })
    const archive = await packageArchive("single-resolution-tool", "# Review\n")
    const { body: version } = await jsonRequest(server.baseUrl, `/skills/${skill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: archive }),
      session: orgAdmin,
    })
    const { body: review } = await jsonRequest(server.baseUrl, `/skills/${skill.skill.id}/review-requests`, {
      method: "POST",
      body: JSON.stringify({ scope: "org", orgId: "org_1", versionId: version.version.id }),
      session: orgAdmin,
    })
    const { response: approveResponse } = await jsonRequest(
      server.baseUrl,
      `/skill-review-requests/${review.requestId}/approve`,
      {
        method: "POST",
        body: JSON.stringify({}),
        session: orgAdmin,
      },
    )
    assert.equal(approveResponse.status, 200)

    const { response: rejectAfterApprove } = await jsonRequest(
      server.baseUrl,
      `/skill-review-requests/${review.requestId}/reject`,
      {
        method: "POST",
        body: JSON.stringify({}),
        session: orgAdmin,
      },
    )
    assert.equal(rejectAfterApprove.status, 409)

    const { body: publicSkill } = await jsonRequest(server.baseUrl, `/skills/${skill.skill.id}`, {
      session: { userId: "org_member", orgId: "org_1", orgRole: "member" },
    })
    assert.equal(publicSkill.skill.reviewStatus, "approved")
    assert.equal(publicSkill.skill.latestVersion.id, version.version.id)
  } finally {
    await server.close()
  }
})

test("duplicate review requests cannot later reject an approved version", async () => {
  const server = await startServer()
  try {
    const orgAdmin = { userId: "org_owner", orgId: "org_1", orgRole: "owner" as const }
    const { body: skill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "org", orgId: "org_1", name: "duplicate-review-tool" }),
      session: orgAdmin,
    })
    const archive = await packageArchive("duplicate-review-tool", "# Review\n")
    const { body: version } = await jsonRequest(server.baseUrl, `/skills/${skill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: archive }),
      session: orgAdmin,
    })
    const { body: firstReview } = await jsonRequest(server.baseUrl, `/skills/${skill.skill.id}/review-requests`, {
      method: "POST",
      body: JSON.stringify({ scope: "org", orgId: "org_1", versionId: version.version.id }),
      session: orgAdmin,
    })
    const { response: duplicateReview } = await jsonRequest(server.baseUrl, `/skills/${skill.skill.id}/review-requests`, {
      method: "POST",
      body: JSON.stringify({ scope: "org", orgId: "org_1", versionId: version.version.id }),
      session: orgAdmin,
    })
    assert.equal(duplicateReview.status, 409)

    await jsonRequest(server.baseUrl, `/skill-review-requests/${firstReview.requestId}/approve`, {
      method: "POST",
      body: JSON.stringify({}),
      session: orgAdmin,
    })
    const { body: publicSkill } = await jsonRequest(server.baseUrl, `/skills/${skill.skill.id}`, {
      session: { userId: "org_member", orgId: "org_1", orgRole: "member" },
    })
    assert.equal(publicSkill.skill.reviewStatus, "approved")
  } finally {
    await server.close()
  }
})

test("globally approved system skills can be installed as organization defaults", async () => {
  const server = await startServer()
  try {
    const platformAdmin = { userId: "platform_owner", isPlatformAdmin: true }
    const orgAdmin = { userId: "org_owner", orgId: "org_1", orgRole: "owner" as const }
    const { body: systemSkill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "system", name: "org-default-global" }),
      session: platformAdmin,
    })
    const archive = await packageArchive("org-default-global", "# System\n")
    const { body: version } = await jsonRequest(server.baseUrl, `/skills/${systemSkill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: archive }),
      session: platformAdmin,
    })
    const { body: review } = await jsonRequest(server.baseUrl, `/skills/${systemSkill.skill.id}/review-requests`, {
      method: "POST",
      body: JSON.stringify({ scope: "system", versionId: version.version.id }),
      session: platformAdmin,
    })
    await jsonRequest(server.baseUrl, `/skill-review-requests/${review.requestId}/approve`, {
      method: "POST",
      body: JSON.stringify({}),
      session: platformAdmin,
    })

    const { response, body } = await jsonRequest(server.baseUrl, "/skill-installations", {
      method: "POST",
      body: JSON.stringify({
        scope: "org",
        orgId: "org_1",
        skillId: systemSkill.skill.id,
        versionId: version.version.id,
        updatePolicy: "latest_approved",
      }),
      session: orgAdmin,
    })
    assert.equal(response.status, 201)
    assert.equal(body.installation.versionId, version.version.id)
  } finally {
    await server.close()
  }
})

test("managed installations cannot be moved or restored to unapproved versions", async () => {
  const server = await startServer()
  try {
    const orgAdmin = { userId: "org_owner", orgId: "org_1", orgRole: "owner" as const }
    const { body: skill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "org", orgId: "org_1", name: "approval-guard" }),
      session: orgAdmin,
    })
    const approvedArchive = await packageArchive("approval-guard", "# Approved\n")
    const draftArchive = await packageArchive("approval-guard", "# Draft\n")
    const { body: approvedVersion } = await jsonRequest(server.baseUrl, `/skills/${skill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: approvedArchive }),
      session: orgAdmin,
    })
    const { body: review } = await jsonRequest(server.baseUrl, `/skills/${skill.skill.id}/review-requests`, {
      method: "POST",
      body: JSON.stringify({ scope: "org", versionId: approvedVersion.version.id }),
      session: orgAdmin,
    })
    await jsonRequest(server.baseUrl, `/skill-review-requests/${review.requestId}/approve`, {
      method: "POST",
      body: JSON.stringify({}),
      session: orgAdmin,
    })
    const { body: installation } = await jsonRequest(server.baseUrl, "/skill-installations", {
      method: "POST",
      body: JSON.stringify({
        scope: "org",
        orgId: "org_1",
        skillId: skill.skill.id,
        versionId: approvedVersion.version.id,
        updatePolicy: "latest_approved",
      }),
      session: orgAdmin,
    })
    const { body: draftVersion } = await jsonRequest(server.baseUrl, `/skills/${skill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: draftArchive }),
      session: orgAdmin,
    })

    const { response: patchToDraft } = await jsonRequest(
      server.baseUrl,
      `/skill-installations/${installation.installation.installationId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ versionId: draftVersion.version.id }),
        session: orgAdmin,
      },
    )
    assert.equal(patchToDraft.status, 409)

    await jsonRequest(server.baseUrl, `/skill-installations/${installation.installation.installationId}`, {
      method: "DELETE",
      session: orgAdmin,
    })
    const { response: restoreToDraft } = await jsonRequest(
      server.baseUrl,
      `/skill-installations/${installation.installation.installationId}/restore`,
      {
        method: "POST",
        body: JSON.stringify({ versionId: draftVersion.version.id }),
        session: orgAdmin,
      },
    )
    assert.equal(restoreToDraft.status, 409)
  } finally {
    await server.close()
  }
})

test("workspace skill-set cannot bypass installation version approval or status", async () => {
  const server = await startServer()
  try {
    const orgAdmin = { userId: "org_owner", orgId: "org_1", orgRole: "owner" as const }
    const { body: skill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "org", orgId: "org_1", name: "skill-set-guard" }),
      session: orgAdmin,
    })
    const approvedArchive = await packageArchive("skill-set-guard", "# Approved\n")
    const draftArchive = await packageArchive("skill-set-guard", "# Draft\n")
    const { body: approvedVersion } = await jsonRequest(server.baseUrl, `/skills/${skill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: approvedArchive }),
      session: orgAdmin,
    })
    const { body: review } = await jsonRequest(server.baseUrl, `/skills/${skill.skill.id}/review-requests`, {
      method: "POST",
      body: JSON.stringify({ scope: "org", versionId: approvedVersion.version.id }),
      session: orgAdmin,
    })
    await jsonRequest(server.baseUrl, `/skill-review-requests/${review.requestId}/approve`, {
      method: "POST",
      body: JSON.stringify({}),
      session: orgAdmin,
    })
    const { body: installation } = await jsonRequest(server.baseUrl, "/skill-installations", {
      method: "POST",
      body: JSON.stringify({
        scope: "workspace",
        orgId: "org_1",
        workspaceId: "workspace_1",
        skillId: skill.skill.id,
        versionId: approvedVersion.version.id,
      }),
      session: orgAdmin,
    })
    const { body: draftVersion } = await jsonRequest(server.baseUrl, `/skills/${skill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: draftArchive }),
      session: orgAdmin,
    })

    const { response: draftOverride } = await jsonRequest(server.baseUrl, "/workspaces/workspace_1/skill-set", {
      method: "PATCH",
      body: JSON.stringify({
        skills: [{
          installationId: installation.installation.installationId,
          desiredVersionId: draftVersion.version.id,
        }],
      }),
      session: orgAdmin,
    })
    assert.equal(draftOverride.status, 409)

    const { body: otherSkill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "user", name: "other-skill" }),
      session: orgAdmin,
    })
    const otherArchive = await packageArchive("other-skill", "# Other\n")
    const { body: otherVersion } = await jsonRequest(server.baseUrl, `/skills/${otherSkill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: otherArchive }),
      session: orgAdmin,
    })
    const { response: wrongSkillVersion } = await jsonRequest(server.baseUrl, "/workspaces/workspace_1/skill-set", {
      method: "PATCH",
      body: JSON.stringify({
        skills: [{
          installationId: installation.installation.installationId,
          desiredVersionId: otherVersion.version.id,
        }],
      }),
      session: orgAdmin,
    })
    assert.equal(wrongSkillVersion.status, 400)

    await jsonRequest(server.baseUrl, `/skill-installations/${installation.installation.installationId}`, {
      method: "DELETE",
      session: orgAdmin,
    })
    const { response: deletedInstallation } = await jsonRequest(server.baseUrl, "/workspaces/workspace_1/skill-set", {
      method: "PATCH",
      body: JSON.stringify({ skills: [{ installationId: installation.installation.installationId }] }),
      session: orgAdmin,
    })
    assert.equal(deletedInstallation.status, 400)
  } finally {
    await server.close()
  }
})

test("workspace skill-set rejects duplicate skill ids", async () => {
  const server = await startServer()
  try {
    const orgAdmin = { userId: "org_owner", orgId: "org_1", orgRole: "owner" as const }
    const { body: skill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "user", name: "duplicate-skill-set-tool" }),
      session: orgAdmin,
    })
    const archive = await packageArchive("duplicate-skill-set-tool", "# Tool\n")
    const { body: version } = await jsonRequest(server.baseUrl, `/skills/${skill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: archive }),
      session: orgAdmin,
    })
    const install = async () => (await jsonRequest(server.baseUrl, "/skill-installations", {
      method: "POST",
      body: JSON.stringify({
        scope: "workspace",
        orgId: "org_1",
        workspaceId: "workspace_duplicate",
        skillId: skill.skill.id,
        versionId: version.version.id,
      }),
      session: orgAdmin,
    })).body.installation.installationId as string

    const firstInstallationId = await install()
    const secondInstallationId = await install()
    const { response } = await jsonRequest(server.baseUrl, "/workspaces/workspace_duplicate/skill-set", {
      method: "PATCH",
      body: JSON.stringify({
        skills: [
          { installationId: firstInstallationId },
          { installationId: secondInstallationId },
        ],
      }),
      session: orgAdmin,
    })
    assert.equal(response.status, 400)
  } finally {
    await server.close()
  }
})

test("unapproved system versions are hidden from normal users until approved", async () => {
  const server = await startServer()
  try {
    const platformAdmin = { userId: "platform_owner", isPlatformAdmin: true }
    const normalUser = { userId: "user_1", orgId: "org_1" }
    const { body: skill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "system", name: "hidden-platform-tool" }),
      session: platformAdmin,
    })
    const archive = await packageArchive("hidden-platform-tool", "# Hidden\n")
    const { body: draftVersion } = await jsonRequest(server.baseUrl, `/skills/${skill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: archive }),
      session: platformAdmin,
    })

    const { body: publicSkill } = await jsonRequest(server.baseUrl, `/skills/${skill.skill.id}`, {
      session: normalUser,
    })
    assert.equal(publicSkill.skill.latestVersion, undefined)

    const { body: publicVersions } = await jsonRequest(
      server.baseUrl,
      `/skills/${skill.skill.id}/versions`,
      { session: normalUser },
    )
    assert.deepEqual(publicVersions.versions, [])

    const { response: publicDownload } = await jsonRequest(
      server.baseUrl,
      `/skill-versions/${draftVersion.version.id}/package`,
      { session: normalUser },
    )
    assert.equal(publicDownload.status, 404)

    const { response: adminDownload } = await jsonRequest(
      server.baseUrl,
      `/skill-versions/${draftVersion.version.id}/package`,
      { session: platformAdmin },
    )
    assert.equal(adminDownload.status, 200)
  } finally {
    await server.close()
  }
})

test("list and search honor workspace, scope, and review filters", async () => {
  const server = await startServer()
  try {
    const owner = { userId: "owner_1", orgId: "org_1", orgRole: "owner" as const }

    await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "workspace", orgId: "org_1", workspaceId: "workspace_a", name: "alpha-a" }),
      session: owner,
    })
    await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "workspace", orgId: "org_1", workspaceId: "workspace_b", name: "alpha-b" }),
      session: owner,
    })
    const { body: personalSkill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "user", name: "personal-approved" }),
      session: owner,
    })
    const archive = await packageArchive("personal-approved", "# Approved\n")
    await jsonRequest(server.baseUrl, `/skills/${personalSkill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: archive }),
      session: owner,
    })

    const { body: workspaceA } = await jsonRequest(server.baseUrl, "/skills?workspaceId=workspace_a", { session: owner })
    assert.deepEqual(workspaceA.skills.map((skill: { slug: string }) => skill.slug), ["alpha-a"])

    const { body: approved } = await jsonRequest(server.baseUrl, "/skills?reviewStatus=approved", { session: owner })
    assert.deepEqual(approved.skills.map((skill: { slug: string }) => skill.slug), ["personal-approved"])

    const { body: pendingSkill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "org", orgId: "org_1", name: "pending-review-tool" }),
      session: owner,
    })
    const pendingArchive = await packageArchive("pending-review-tool", "# Pending\n")
    const { body: pendingVersion } = await jsonRequest(server.baseUrl, `/skills/${pendingSkill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: pendingArchive }),
      session: owner,
    })
    await jsonRequest(server.baseUrl, `/skills/${pendingSkill.skill.id}/review-requests`, {
      method: "POST",
      body: JSON.stringify({ scope: "org", orgId: "org_1", versionId: pendingVersion.version.id }),
      session: owner,
    })
    const { body: pending } = await jsonRequest(server.baseUrl, "/skills?reviewStatus=pending_review", { session: owner })
    assert.deepEqual(pending.skills.map((skill: { slug: string }) => skill.slug), ["pending-review-tool"])

    const { body: workspaceSearch } = await jsonRequest(
      server.baseUrl,
      "/skills/search?q=alpha&workspaceId=workspace_a",
      { session: owner },
    )
    assert.deepEqual(workspaceSearch.skills.map((skill: { slug: string }) => skill.slug), ["alpha-a"])

    const { body: userScopeSearch } = await jsonRequest(
      server.baseUrl,
      "/skills/search?q=approved&ownerScope=user",
      { session: owner },
    )
    assert.deepEqual(userScopeSearch.skills.map((skill: { slug: string }) => skill.slug), ["personal-approved"])

    const { body: tagSearch } = await jsonRequest(server.baseUrl, "/skills?tag=automation", { session: owner })
    assert.deepEqual(tagSearch.skills.map((skill: { slug: string }) => skill.slug), ["personal-approved"])

    const { body: missingTagSearch } = await jsonRequest(server.baseUrl, "/skills?tag=missing", { session: owner })
    assert.deepEqual(missingTagSearch.skills, [])
  } finally {
    await server.close()
  }
})

test("registry events can be consumed by polling", async () => {
  const fixedNow = new Date("2026-05-26T12:00:00.000Z")
  const server = await startServer(new InMemorySkillRegistryStore({ now: () => fixedNow }))
  try {
    const { body: createdSkill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "user", name: "event-tool" }),
    })
    const archive = await packageArchive("event-tool", "# Events\n")
    await jsonRequest(server.baseUrl, `/skills/${createdSkill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: archive }),
    })
    await jsonRequest(server.baseUrl, `/skills/${createdSkill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: archive }),
    })

    const { response, body } = await jsonRequest(server.baseUrl, "/skill-registry-events?limit=1")

    assert.equal(response.status, 200)
    assert.equal(body.events.length, 1)
    const nextCursor = encodeURIComponent(body.nextCursor)
    const { body: nextPage } = await jsonRequest(server.baseUrl, `/skill-registry-events?limit=1&cursor=${nextCursor}`)
    assert.equal(nextPage.events.length, 1)
    assert.notEqual(nextPage.events[0].id, body.events[0].id)
  } finally {
    await server.close()
  }
})

test("normal users can poll approved global skill events", async () => {
  const server = await startServer()
  try {
    const platformAdmin = { userId: "platform_owner", isPlatformAdmin: true }
    const normalUser = { userId: "user_1", orgId: "org_1" }
    const { body: skill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "system", name: "global-event-tool" }),
      session: platformAdmin,
    })
    const archive = await packageArchive("global-event-tool", "# Global\n")
    const { body: version } = await jsonRequest(server.baseUrl, `/skills/${skill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: archive }),
      session: platformAdmin,
    })
    const { body: review } = await jsonRequest(server.baseUrl, `/skills/${skill.skill.id}/review-requests`, {
      method: "POST",
      body: JSON.stringify({ scope: "system", versionId: version.version.id }),
      session: platformAdmin,
    })
    await jsonRequest(server.baseUrl, `/skill-review-requests/${review.requestId}/approve`, {
      method: "POST",
      body: JSON.stringify({}),
      session: platformAdmin,
    })

    const { body: events } = await jsonRequest(server.baseUrl, "/skill-registry-events", { session: normalUser })
    assert.ok(events.events.some((event: { action: string }) => event.action === "skill.version.approved"))
  } finally {
    await server.close()
  }
})

test("approved version rollout updates workspace desired state", async () => {
  const server = await startServer()
  try {
    const orgAdmin = { userId: "org_owner", orgId: "org_1", orgRole: "owner" as const }
    const { body: skill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "org", orgId: "org_1", name: "rollout-tool" }),
      session: orgAdmin,
    })
    const firstArchive = await packageArchive("rollout-tool", "# One\n")
    const secondArchive = await packageArchive("rollout-tool", "# Two\n")
    const { body: firstVersion } = await jsonRequest(server.baseUrl, `/skills/${skill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: firstArchive }),
      session: orgAdmin,
    })
    const { body: firstReview } = await jsonRequest(server.baseUrl, `/skills/${skill.skill.id}/review-requests`, {
      method: "POST",
      body: JSON.stringify({ scope: "org", versionId: firstVersion.version.id, releaseChannel: "stable" }),
      session: orgAdmin,
    })
    await jsonRequest(server.baseUrl, `/skill-review-requests/${firstReview.requestId}/approve`, {
      method: "POST",
      body: JSON.stringify({ releaseChannel: "stable" }),
      session: orgAdmin,
    })

    const { body: installation } = await jsonRequest(server.baseUrl, "/skill-installations", {
      method: "POST",
      body: JSON.stringify({
        scope: "workspace",
        orgId: "org_1",
        workspaceId: "workspace_1",
        skillId: skill.skill.id,
        versionId: firstVersion.version.id,
        updatePolicy: "release_channel",
        releaseChannel: "stable",
      }),
      session: orgAdmin,
    })
    await jsonRequest(server.baseUrl, "/workspaces/workspace_1/skill-set", {
      method: "PATCH",
      body: JSON.stringify({ skills: [{ installationId: installation.installation.installationId }] }),
      session: orgAdmin,
    })

    const { body: secondVersion } = await jsonRequest(server.baseUrl, `/skills/${skill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: secondArchive }),
      session: orgAdmin,
    })
    const { body: secondReview } = await jsonRequest(server.baseUrl, `/skills/${skill.skill.id}/review-requests`, {
      method: "POST",
      body: JSON.stringify({ scope: "org", versionId: secondVersion.version.id, releaseChannel: "stable" }),
      session: orgAdmin,
    })
    await jsonRequest(server.baseUrl, `/skill-review-requests/${secondReview.requestId}/approve`, {
      method: "POST",
      body: JSON.stringify({ releaseChannel: "stable" }),
      session: orgAdmin,
    })

    const { body: workspaceSet } = await jsonRequest(
      server.baseUrl,
      "/workspaces/workspace_1/skill-set",
      { session: orgAdmin },
    )
    assert.equal(workspaceSet.workspaceId, "workspace_1")
    assert.equal(workspaceSet.skills[0].versionId, secondVersion.version.id)

    const materialization = server.store.snapshot().materializations.find(
      (entry) => entry.installationId === installation.installation.installationId,
    )
    assert.equal(materialization?.desiredVersionId, secondVersion.version.id)
    assert.ok(server.store.snapshot().events.some((event) => event.action === "workspace.skill_set.changed"))
    assert.ok(server.store.snapshot().events.some((event) => event.action === "skill.version.approved"))
  } finally {
    await server.close()
  }
})

test("workspace skill-set response uses entry desired version overrides", async () => {
  const server = await startServer()
  try {
    const orgAdmin = { userId: "org_owner", orgId: "org_1", orgRole: "owner" as const }
    const { body: skill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "user", name: "entry-version-tool" }),
      session: orgAdmin,
    })
    const firstArchive = await packageArchive("entry-version-tool", "# One\n")
    const secondArchive = await packageArchive("entry-version-tool", "# Two\n")
    const { body: firstVersion } = await jsonRequest(server.baseUrl, `/skills/${skill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: firstArchive }),
      session: orgAdmin,
    })
    const { body: secondVersion } = await jsonRequest(server.baseUrl, `/skills/${skill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: secondArchive }),
      session: orgAdmin,
    })
    const { body: installation } = await jsonRequest(server.baseUrl, "/skill-installations", {
      method: "POST",
      body: JSON.stringify({
        scope: "workspace",
        orgId: "org_1",
        workspaceId: "workspace_entry",
        skillId: skill.skill.id,
        versionId: firstVersion.version.id,
      }),
      session: orgAdmin,
    })

    const { body: patchedSet } = await jsonRequest(server.baseUrl, "/workspaces/workspace_entry/skill-set", {
      method: "PATCH",
      body: JSON.stringify({
        skills: [{
          installationId: installation.installation.installationId,
          desiredVersionId: secondVersion.version.id,
        }],
      }),
      session: orgAdmin,
    })
    assert.equal(patchedSet.skills[0].versionId, secondVersion.version.id)

    const { body: readSet } = await jsonRequest(server.baseUrl, "/workspaces/workspace_entry/skill-set", {
      session: orgAdmin,
    })
    assert.equal(readSet.skills[0].versionId, secondVersion.version.id)
  } finally {
    await server.close()
  }
})

test("den index mounts the DB-backed skill registry router under /v1", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")

  assert.match(source, /const skillRegistryStore = createDbSkillRegistryStore\(db\)/)
  assert.match(source, /app\.use\("\/v1", createSkillRegistryRouter\(\{ store: skillRegistryStore \}\)\)/)
})
