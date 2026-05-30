# Skill Rollout Policies Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build registry rollout policies so organization and platform skills can be distributed as either user-global or workspace-targeted managed skills, with target exclusivity and non-removable policy support.

**Architecture:** Den owns rollout policy persistence, authorization, target exclusivity, and audit events. The local Veslo server validates and proxies rollout policy APIs, then includes matching policies when computing materialization plans. The desktop app consumes the local server surface and presents target changes as moves instead of parallel installs.

**Tech Stack:** TypeScript, Drizzle MySQL schema/migrations, Node test runner for Den, Bun tests for `packages/server`, Solid app client helpers, Tauri desktop E2E for final runtime verification.

---

## References

- Design: `docs/plans/2026-05-30-skill-rollout-policies-design.md`
- Current registry doc: `docs/features/skill-registry-and-distribution.md`
- Current Den schema: `services/den/src/skills/schema.ts`
- Current Den route/store implementation: `services/den/src/skills/routes.ts`, `services/den/src/skills/store.ts`, `services/den/src/skills/db-store.ts`
- Current local server registry client: `packages/server/src/skill-registry-client.ts`, `packages/server/src/skill-registry-types.ts`
- Current resolver: `packages/server/src/workspace-skill-set.ts`
- Runtime verification guide: `docs/dev/testing-playbook.md`

Use @test-driven-development for each implementation slice, @systematic-debugging for unexpected failures, and @verification-before-completion before claiming completion.

## Task 1: Add Den Rollout Policy Schema

**Files:**
- Modify: `services/den/src/skills/schema.ts`
- Modify: `services/den/src/db/schema.ts`
- Create: `services/den/drizzle/0014_skill_rollout_policies.sql`
- Modify: `services/den/drizzle/meta/_journal.json`
- Modify: `services/den/test/skill-registry-schema.test.ts`

**Step 1: Write the failing schema test**

Add `skill_rollout_policies` to `requiredTables` in `services/den/test/skill-registry-schema.test.ts`.

Add this test:

```ts
test("skill rollout policies encode target, audience, and removal policy", () => {
  const migration = readMigration()
  const rolloutBlock = tableBlock(migration, "skill_rollout_policies")

  assert.match(rolloutBlock, /`target` enum\('user-global','workspace'\) NOT NULL/)
  assert.match(
    rolloutBlock,
    /`audience` enum\('user','selected-workspaces','all-org-users','all-platform-users'\) NOT NULL/,
  )
  assert.match(
    rolloutBlock,
    /`removal_policy` enum\('user_removable','admin_removable','locked'\) NOT NULL DEFAULT 'user_removable'/,
  )
  assert.match(rolloutBlock, /`enabled` boolean NOT NULL DEFAULT true/)
  assert.match(rolloutBlock, /CONSTRAINT `skill_rollout_user_target_shape` CHECK/)
  assert.match(rolloutBlock, /CONSTRAINT `skill_rollout_workspace_target_shape` CHECK/)
  assert.match(migration, /skill_rollout_active_target_guard/)
  assert.match(migration, /skill_rollout_org_audience/)
  assert.match(migration, /skill_rollout_workspace_lookup/)
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/skill-registry-schema.test.ts
```

Expected: FAIL because `skill_rollout_policies` does not exist.

**Step 3: Add schema enums and table**

In `services/den/src/skills/schema.ts`, add:

```ts
export const SkillRolloutTarget = ["user-global", "workspace"] as const
export const SkillRolloutAudience = ["user", "selected-workspaces", "all-org-users", "all-platform-users"] as const
export const SkillRolloutRemovalPolicy = ["user_removable", "admin_removable", "locked"] as const

export type SkillRolloutTarget = (typeof SkillRolloutTarget)[number]
export type SkillRolloutAudience = (typeof SkillRolloutAudience)[number]
export type SkillRolloutRemovalPolicy = (typeof SkillRolloutRemovalPolicy)[number]
```

Add `skill_rollout_policies: "skill_rollout_policies"` to `SkillRegistryTables`.

Add the table:

```ts
export const SkillRolloutPolicyTable = mysqlTable(
  SkillRegistryTables.skill_rollout_policies,
  {
    id: idColumn().primaryKey(),
    org_id: orgIdColumn(),
    skill_id: skillIdColumn().notNull(),
    desired_version_id: versionIdColumn("desired_version_id"),
    release_channel: varchar("release_channel", { length: 128 }),
    update_policy: mysqlEnum("update_policy", SkillInstallationUpdatePolicy).notNull().default("pinned"),
    catalog_scope: mysqlEnum("catalog_scope", ["organization", "platform"]).notNull(),
    owner_org_id: orgIdColumn(),
    target: mysqlEnum("target", SkillRolloutTarget).notNull(),
    audience: mysqlEnum("audience", SkillRolloutAudience).notNull(),
    user_id: userIdColumn("user_id"),
    workspace_id: varchar("workspace_id", { length: 64 }),
    enabled: boolean("enabled").notNull().default(true),
    removal_policy: mysqlEnum("removal_policy", SkillRolloutRemovalPolicy).notNull().default("user_removable"),
    created_by_user_id: userIdColumn("created_by_user_id").notNull(),
    ...softDeleteColumns,
    ...timestamps,
  },
  (table) => [
    index("skill_rollout_org_audience").on(table.org_id, table.audience, table.enabled),
    index("skill_rollout_workspace_lookup").on(table.org_id, table.workspace_id, table.enabled),
    index("skill_rollout_user_lookup").on(table.user_id, table.enabled),
    index("skill_rollout_skill").on(table.skill_id, table.enabled),
    uniqueIndex("skill_rollout_active_target_guard").on(
      table.skill_id,
      table.catalog_scope,
      table.owner_org_id,
      table.target,
      table.audience,
      table.user_id,
      table.workspace_id,
    ),
    check(
      "skill_rollout_user_target_shape",
      sql`${table.target} <> 'user-global' OR ${table.workspace_id} IS NULL`,
    ),
    check(
      "skill_rollout_workspace_target_shape",
      sql`${table.target} <> 'workspace' OR ${table.audience} = 'selected-workspaces'`,
    ),
  ],
)
```

If Drizzle rejects inline enum arrays for `catalog_scope`, define a `SkillRolloutCatalogScope = ["organization", "platform"] as const` constant first and reuse it.

**Step 4: Add SQL migration**

Create `services/den/drizzle/0014_skill_rollout_policies.sql` with the SQL equivalent of the table above. Follow existing migration formatting and include `--> statement-breakpoint` separators. The migration must include the indexes and checks asserted by the test.

Update `services/den/drizzle/meta/_journal.json` with the next migration entry matching the local Drizzle journal format.

**Step 5: Run schema tests**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/skill-registry-schema.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add services/den/src/skills/schema.ts services/den/src/db/schema.ts services/den/drizzle/0014_skill_rollout_policies.sql services/den/drizzle/meta/_journal.json services/den/test/skill-registry-schema.test.ts
git commit -m "feat: add skill rollout policy schema"
```

## Task 2: Add Den Store Contract And In-Memory Rollout Policies

**Files:**
- Modify: `services/den/src/skills/store.ts`
- Modify: `services/den/src/skills/policy.ts`
- Test: `services/den/test/skill-registry-routes.test.ts`

**Step 1: Write failing in-memory behavior tests**

Add route-level tests that use `InMemorySkillRegistryStore`:

```ts
test("rollout policy installs org skill as user-global for one user", async () => {
  const server = await startServer()
  try {
    const owner = { userId: "owner_1", orgId: "org_1", orgRole: "owner" as const }
    const { body: createdSkill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "org", orgId: "org_1", name: "meeting-minutes" }),
      session: owner,
    })
    const archive = await packageArchive("meeting-minutes", "# Meeting minutes\n")
    const { body: version } = await jsonRequest(server.baseUrl, `/skills/${createdSkill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: archive }),
      session: owner,
    })
    const { body: review } = await jsonRequest(server.baseUrl, `/skills/${createdSkill.skill.id}/review-requests`, {
      method: "POST",
      body: JSON.stringify({ scope: "org", orgId: "org_1", versionId: version.version.id }),
      session: owner,
    })
    await jsonRequest(server.baseUrl, `/skill-review-requests/${review.requestId}/approve`, {
      method: "POST",
      body: JSON.stringify({}),
      session: owner,
    })

    const { response, body } = await jsonRequest(server.baseUrl, "/skill-rollout-policies", {
      method: "POST",
      body: JSON.stringify({
        skillId: createdSkill.skill.id,
        versionId: version.version.id,
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
    assert.equal(body.policy.removalPolicy, "user_removable")
  } finally {
    await server.close()
  }
})
```

Add a conflict test:

```ts
test("rollout policies reject user-global and workspace targets for same skill and audience", async () => {
  const server = await startServer()
  try {
    const owner = { userId: "owner_1", orgId: "org_1", orgRole: "owner" as const }
    const { body: createdSkill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({ scope: "org", orgId: "org_1", name: "office-writer" }),
      session: owner,
    })
    const archive = await packageArchive("office-writer", "# Office writer\n")
    const { body: version } = await jsonRequest(server.baseUrl, `/skills/${createdSkill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: archive }),
      session: owner,
    })

    await jsonRequest(server.baseUrl, "/skill-rollout-policies", {
      method: "POST",
      body: JSON.stringify({
        skillId: createdSkill.skill.id,
        versionId: version.version.id,
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
        skillId: createdSkill.skill.id,
        versionId: version.version.id,
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
```

**Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/skill-registry-routes.test.ts
```

Expected: FAIL with 404 or missing store methods for `/skill-rollout-policies`.

**Step 3: Add policy helpers**

In `services/den/src/skills/policy.ts`, add:

```ts
export type SkillRolloutTargetConflictRef = {
  skillId: string
  catalogScope: "organization" | "platform"
  ownerOrgId?: string | null
  target: "user-global" | "workspace"
  audience: string
  userId?: string | null
  workspaceId?: string | null
  enabled?: boolean
  deletedAt?: Date | string | null
}

export function rolloutPolicyOwnerKey(input: {
  catalogScope: "organization" | "platform"
  ownerOrgId?: string | null
}): string {
  if (input.catalogScope === "platform") return "platform:__platform__"
  if (!input.ownerOrgId) throw new Error("org_id_required")
  return `org:${encodeKeyPart(input.ownerOrgId)}`
}

export function hasRolloutTargetConflict(
  candidate: SkillRolloutTargetConflictRef,
  existing: readonly SkillRolloutTargetConflictRef[],
): boolean {
  return existing.some((policy) => {
    if (policy.deletedAt != null || policy.enabled === false) return false
    if (policy.skillId !== candidate.skillId) return false
    if (policy.catalogScope !== candidate.catalogScope) return false
    if ((policy.ownerOrgId ?? null) !== (candidate.ownerOrgId ?? null)) return false
    if (policy.target === candidate.target) return false
    if (candidate.audience === "user" || policy.audience === "user") {
      return (policy.userId ?? null) === (candidate.userId ?? null)
    }
    if (candidate.catalogScope === "organization") return true
    return candidate.audience === "all-platform-users" || policy.audience === "all-platform-users"
  })
}
```

**Step 4: Extend store types**

In `services/den/src/skills/store.ts`, add exported response/input types:

```ts
export type RegistrySkillRolloutTarget = "user-global" | "workspace"
export type RegistrySkillRolloutAudience = "user" | "selected-workspaces" | "all-org-users" | "all-platform-users"
export type RegistrySkillRolloutRemovalPolicy = "user_removable" | "admin_removable" | "locked"

export type RegistrySkillRolloutPolicy = {
  id: string
  skillId: string
  versionId: string | null
  target: RegistrySkillRolloutTarget
  audience: RegistrySkillRolloutAudience
  catalogScope: "organization" | "platform"
  orgId?: string | null
  userId?: string | null
  workspaceId?: string | null
  enabled: boolean
  updatePolicy: SkillInstallationUpdatePolicy
  releaseChannel?: string | null
  removalPolicy: RegistrySkillRolloutRemovalPolicy
  createdAt: string
  updatedAt?: string
}

export type RegistrySkillRolloutPolicyResponse = {
  policy: RegistrySkillRolloutPolicy
}

export type RegistrySkillRolloutPoliciesResponse = {
  policies: RegistrySkillRolloutPolicy[]
  nextCursor?: string | null
}
```

Add methods to `SkillRegistryStore`:

```ts
listRolloutPolicies(context: SkillRegistryRouteContext, filters?: Record<string, unknown>): Promise<RegistrySkillRolloutPoliciesResponse>
createRolloutPolicy(context: SkillRegistryRouteContext, input: CreateRolloutPolicyInput): Promise<RegistrySkillRolloutPolicy>
updateRolloutPolicy(context: SkillRegistryRouteContext, policyId: string, input: UpdateRolloutPolicyInput): Promise<RegistrySkillRolloutPolicy | null>
deleteRolloutPolicy(context: SkillRegistryRouteContext, policyId: string): Promise<RegistrySkillRolloutPolicy | null>
```

**Step 5: Implement in-memory methods**

Add a `rolloutPolicies` map and implement the methods with:

- approved org/platform version requirement
- owner/admin authorization delegated from routes
- `target_conflict` detection through `hasRolloutTargetConflict`
- `removal_not_allowed` when deleting `locked` or `admin_removable` without admin context
- `skill.rollout_policy.changed` audit events

**Step 6: Run tests**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/skill-registry-routes.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add services/den/src/skills/store.ts services/den/src/skills/policy.ts services/den/test/skill-registry-routes.test.ts
git commit -m "feat: add rollout policies to registry store"
```

## Task 3: Add Den Rollout Policy Routes And DB Store

**Files:**
- Modify: `services/den/src/skills/routes.ts`
- Modify: `services/den/src/skills/db-store.ts`
- Test: `services/den/test/skill-registry-routes.test.ts`
- Test: `services/den/test/skill-registry-schema.test.ts`

**Step 1: Add route tests for authorization and locked removal**

Add tests covering:

```ts
assert.equal(nonOwnerCreate.response.status, 403)
assert.equal(lockedDelete.response.status, 409)
assert.equal(lockedDelete.body.error, "removal_not_allowed")
```

Use an org owner session to create a `locked` policy, then a member session to delete it.

**Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/skill-registry-routes.test.ts
```

Expected: FAIL until routes and DB methods are wired.

**Step 3: Add routes**

In `services/den/src/skills/routes.ts`, add:

```ts
router.get("/skill-rollout-policies", asyncRoute(async (req, res) => {
  const context = await resolveContext(req, res)
  if (!context) return
  res.json(await store.listRolloutPolicies(context, req.query))
}))

router.post("/skill-rollout-policies", asyncRoute(async (req, res) => {
  const context = await resolveContext(req, res)
  if (!context) return
  const catalogScope = requireRolloutCatalogScope(req.body?.catalogScope)
  const orgId = optionalString(req.body?.orgId) ?? context.orgId ?? null
  if (catalogScope === "platform") requirePlatformSkillAdmin(context)
  if (catalogScope === "organization") requireOrgSkillAdmin(context, orgId)
  const policy = await store.createRolloutPolicy(context, {
    skillId: requireString(req.body?.skillId, "skillId"),
    versionId: optionalNullableString(req.body?.versionId),
    target: requireRolloutTarget(req.body?.target),
    audience: requireRolloutAudience(req.body?.audience),
    catalogScope,
    orgId,
    userId: optionalString(req.body?.userId),
    workspaceId: optionalString(req.body?.workspaceId),
    updatePolicy: optionalUpdatePolicy(req.body?.updatePolicy),
    releaseChannel: optionalNullableString(req.body?.releaseChannel),
    removalPolicy: optionalRemovalPolicy(req.body?.removalPolicy),
  })
  res.status(201).json({ policy })
}))
```

Add `PATCH` and `DELETE` routes with the same auth pattern. Keep parser helpers near existing `requireScope`.

**Step 4: Implement DB store methods**

In `services/den/src/skills/db-store.ts`, mirror the in-memory behavior using `SkillRolloutPolicyTable`.

Implementation shape:

```ts
async createRolloutPolicy(context: SkillRegistryRouteContext, input: CreateRolloutPolicyInput) {
  const skill = await this.requireVisibleSkill(context, input.skillId)
  const version = input.versionId ? await this.requireVersion(input.versionId) : null
  if (version && version.skill_id !== skill.id) throw new SkillRegistryStoreError(400, "version_skill_mismatch")
  if ((input.catalogScope === "organization" || input.catalogScope === "platform") && version?.status !== "approved") {
    throw new SkillRegistryStoreError(409, "version_not_approved")
  }
  await this.enforceNoRolloutTargetConflict(input)
  const now = new Date()
  const id = newId("rollout")
  await this.database.insert(SkillRolloutPolicyTable).values({
    id,
    org_id: input.catalogScope === "organization" ? input.orgId ?? context.orgId ?? null : null,
    skill_id: skill.id,
    desired_version_id: version?.id ?? null,
    release_channel: input.releaseChannel?.trim() || null,
    update_policy: input.updatePolicy ?? "pinned",
    catalog_scope: input.catalogScope,
    owner_org_id: input.catalogScope === "organization" ? input.orgId ?? context.orgId ?? null : null,
    target: input.target,
    audience: input.audience,
    user_id: input.userId ?? null,
    workspace_id: input.workspaceId ?? null,
    enabled: true,
    removal_policy: input.removalPolicy ?? "user_removable",
    created_by_user_id: context.userId,
    deleted_at: null,
    deleted_by_user_id: null,
    purge_after: null,
    restored_at: null,
    restored_by_user_id: null,
    created_at: now,
    updated_at: now,
  })
  await this.recordEvent(context, "skill.rollout_policy.changed", {
    orgId: input.catalogScope === "organization" ? input.orgId ?? context.orgId ?? null : null,
    skillId: skill.id,
    versionId: version?.id ?? null,
    workspaceId: input.workspaceId ?? null,
    payload: { policyId: id, target: input.target, audience: input.audience },
  })
  return this.toRolloutPolicyResponse(await this.requireRolloutPolicy(id))
}
```

**Step 5: Run Den route/schema tests**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/skill-registry-routes.test.ts test/skill-registry-schema.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add services/den/src/skills/routes.ts services/den/src/skills/db-store.ts services/den/test/skill-registry-routes.test.ts services/den/test/skill-registry-schema.test.ts
git commit -m "feat: expose skill rollout policy routes"
```

## Task 4: Add Local Server Registry Types And Client Wrappers

**Files:**
- Modify: `packages/server/src/skill-registry-types.ts`
- Modify: `packages/server/src/skill-registry-types.test.ts`
- Modify: `packages/server/src/skill-registry-client.ts`
- Modify: `packages/server/src/skill-registry-client.test.ts`

**Step 1: Write validator/client tests**

In `packages/server/src/skill-registry-types.test.ts`, add:

```ts
test("validateRegistrySkillRolloutPolicyResponse accepts rollout policy payloads", () => {
  const response = validateRegistrySkillRolloutPolicyResponse({
    policy: {
      id: "rollout_1",
      skillId: "skill_1",
      versionId: "version_1",
      target: "user-global",
      audience: "user",
      catalogScope: "organization",
      orgId: "org_1",
      userId: "user_1",
      enabled: true,
      updatePolicy: "pinned",
      removalPolicy: "locked",
      createdAt: "2026-05-30T10:00:00.000Z",
      updatedAt: "2026-05-30T10:01:00.000Z",
    },
  })
  expect(response.policy.removalPolicy).toBe("locked")
})
```

In `packages/server/src/skill-registry-client.test.ts`, add a test that expects:

```text
GET https://registry.example/v1/skill-rollout-policies?target=user-global
POST https://registry.example/v1/skill-rollout-policies
PATCH https://registry.example/v1/skill-rollout-policies/rollout_1
DELETE https://registry.example/v1/skill-rollout-policies/rollout_1
```

**Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter veslo-server test -- skill-registry-types skill-registry-client
```

Expected: FAIL due to missing validators/client functions.

**Step 3: Add local server types**

In `packages/server/src/skill-registry-types.ts`, add:

```ts
export type RegistrySkillRolloutPolicy = {
  id: string;
  skillId: string;
  versionId: string | null;
  target: "user-global" | "workspace";
  audience: "user" | "selected-workspaces" | "all-org-users" | "all-platform-users";
  catalogScope: "organization" | "platform";
  orgId?: string | null;
  userId?: string | null;
  workspaceId?: string | null;
  enabled: boolean;
  updatePolicy: "pinned" | "latest_user" | "latest_approved" | "release_channel";
  releaseChannel?: string | null;
  removalPolicy: "user_removable" | "admin_removable" | "locked";
  createdAt: string;
  updatedAt?: string;
};

export type RegistrySkillRolloutPolicyResponse = { policy: RegistrySkillRolloutPolicy };
export type RegistrySkillRolloutPoliciesResponse = {
  policies: RegistrySkillRolloutPolicy[];
  nextCursor?: string | null;
};
```

Add `validateRolloutPolicy`, `validateRegistrySkillRolloutPolicyResponse`, and `validateRegistrySkillRolloutPoliciesResponse`.

**Step 4: Add registry client wrappers**

In `packages/server/src/skill-registry-client.ts`, add:

```ts
export async function listRegistrySkillRolloutPolicies(input: ListRolloutPoliciesInput): Promise<RegistrySkillRolloutPoliciesResponse> {
  const url = buildUrl(input.baseUrl, "/v1/skill-rollout-policies", {
    cursor: input.cursor,
    limit: input.limit,
    target: input.target,
    audience: input.audience,
    workspaceId: input.workspaceId,
  });
  const payload = await fetchRegistryJson(input, url);
  return validatePayload(validateRegistrySkillRolloutPoliciesResponse, payload, url);
}
```

Add `createRegistrySkillRolloutPolicy`, `updateRegistrySkillRolloutPolicy`, and `deleteRegistrySkillRolloutPolicy` in the same style as installation methods.

**Step 5: Run tests**

Run:

```bash
pnpm --filter veslo-server test -- skill-registry-types skill-registry-client
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/server/src/skill-registry-types.ts packages/server/src/skill-registry-types.test.ts packages/server/src/skill-registry-client.ts packages/server/src/skill-registry-client.test.ts
git commit -m "feat: add rollout policy registry client"
```

## Task 5: Proxy Rollout Policy Routes Through Local Veslo Server

**Files:**
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/server.skill-registry-search.test.ts`

**Step 1: Write proxy tests**

Add a test similar to the existing registry mutation proxy tests:

```ts
test("host registry mutations proxy rollout policy CRUD", async () => {
  const calls: Array<{ method: string; url: string; body?: unknown }> = []
  const registry = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      calls.push({
        method: request.method,
        url: `${url.pathname}${url.search}`,
        body: request.method === "GET" ? undefined : await request.json(),
      })
      return Response.json({
        policy: {
          id: "rollout_1",
          skillId: "skill_1",
          versionId: "version_1",
          target: "user-global",
          audience: "user",
          catalogScope: "organization",
          orgId: "org_1",
          userId: "user_1",
          enabled: true,
          updatePolicy: "pinned",
          removalPolicy: "user_removable",
          createdAt: "2026-05-30T10:00:00.000Z",
        },
      })
    },
  })
  runningServers.push(registry as { stop?: (closeActiveConnections?: boolean) => void })
  const server = await startFixture(`http://127.0.0.1:${registry.port}`)

  const create = await fetch(`http://127.0.0.1:${server.port}/v1/skill-rollout-policies`, {
    method: "POST",
    headers: { Authorization: "Bearer host-token", "content-type": "application/json", "x-veslo-den-org-id": "org_1" },
    body: JSON.stringify({ skillId: "skill_1", versionId: "version_1", target: "user-global", audience: "user", userId: "user_1", catalogScope: "organization", orgId: "org_1" }),
  })
  expect(create.status).toBe(200)
  expect(calls[0]).toMatchObject({ method: "POST", url: "/v1/skill-rollout-policies" })
})
```

Add unauthenticated/client-token write rejection coverage if not already covered by shared route auth helpers.

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter veslo-server test -- server.skill-registry-search
```

Expected: FAIL with 404 for `/v1/skill-rollout-policies`.

**Step 3: Add local proxy routes**

In `packages/server/src/server.ts`, import the new client wrappers and add host/owner routes:

```ts
addRoute(routes, "GET", "/v1/skill-rollout-policies", "client", async (ctx) => {
  const params = new URL(ctx.req.url).searchParams;
  return listRegistrySkillRolloutPolicies({
    ...skillRegistryRequestInput(ctx),
    cursor: trimmedSearchParam(params, "cursor"),
    limit: optionalNumberParam(params, "limit"),
    target: trimmedSearchParam(params, "target"),
    audience: trimmedSearchParam(params, "audience"),
    workspaceId: trimmedSearchParam(params, "workspaceId"),
  });
});
```

Add `POST`, `PATCH`, and `DELETE` with `"host"` auth and the same `buildDenContextHeaders` behavior used by app client calls.

**Step 4: Run proxy tests**

Run:

```bash
pnpm --filter veslo-server test -- server.skill-registry-search
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/server/src/server.ts packages/server/src/server.skill-registry-search.test.ts
git commit -m "feat: proxy skill rollout policies"
```

## Task 6: Update Resolver And Materialization To Consume Policies

**Files:**
- Modify: `packages/server/src/types.ts`
- Modify: `packages/server/src/workspace-skill-set.ts`
- Modify: `packages/server/src/workspace-skill-set.test.ts`
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/server.skill-materialization.test.ts`

**Step 1: Write resolver tests**

Add tests:

```ts
test("all-org-users rollout applies as personal-global only for organization members", () => {
  const result = resolveWorkspaceSkillSet({
    workspace: { id: "ws_1", scope: "organization", orgId: "org_1" },
    user: { id: "user_1", orgId: "org_1" },
    registryInstallations: [],
    rolloutPolicies: [
      {
        id: "rollout_1",
        skillId: "skill_1",
        name: "office-writer",
        versionId: "version_1",
        packageSha256: "a".repeat(64),
        enabled: true,
        source: "organization",
        target: "personal-global",
        audience: "all-org-users",
        orgId: "org_1",
        removalPolicy: "locked",
      },
    ],
    localUnmanagedSkills: [],
  })
  expect(result.requiredMaterializations[0]?.target).toBe("personal-global")
})
```

Add selected workspace and target conflict tests:

```ts
expect(result.conflicts[0]?.code).toBe("target-conflict")
expect(result.requiredMaterializations).toHaveLength(1)
```

**Step 2: Run resolver tests to verify they fail**

Run:

```bash
pnpm --filter veslo-server test -- workspace-skill-set
```

Expected: FAIL because `rolloutPolicies` does not exist and conflict code is unsupported.

**Step 3: Extend types**

In `packages/server/src/types.ts`, add:

```ts
export type WorkspaceSkillRolloutPolicy = {
  id: string;
  skillId: string;
  name: string;
  versionId: string;
  packageSha256: string;
  enabled: boolean;
  source: Exclude<ManagedSkillSource, "personal" | "workspace">;
  target: "personal-global" | "workspace";
  audience: "user" | "selected-workspaces" | "all-org-users" | "all-platform-users";
  orgId?: string | null;
  userId?: string | null;
  workspaceId?: string | null;
  removalPolicy: "user_removable" | "admin_removable" | "locked";
};
```

Add `"target-conflict"` and `"locked-shadowed"` to `WorkspaceSkillConflict["code"]`. Add `"target-conflict"` to blocked reasons if useful.

**Step 4: Update resolver**

In `packages/server/src/workspace-skill-set.ts`, add `rolloutPolicies?: WorkspaceSkillRolloutPolicy[]` to input.

Normalize matching policies into managed skills before existing installation resolution:

```ts
const policyApplies = (policy: WorkspaceSkillRolloutPolicy) => {
  if (!policy.enabled) return false;
  if (policy.target === "workspace") return policy.workspaceId === input.workspace.id;
  if (policy.audience === "user") return policy.userId === input.user.id;
  if (policy.audience === "all-org-users") return Boolean(input.user.orgId && policy.orgId === input.user.orgId);
  if (policy.audience === "all-platform-users") return true;
  return false;
};
```

Detect target conflicts by `skillId` across applied policies/installations before materialization. If both target types exist for the same `skillId`, keep one deterministic winner:

1. `locked`
2. `admin_removable`
3. workspace target
4. user-global target

Return a `target-conflict` entry whenever a loser is suppressed.

**Step 5: Update server materialization fetch**

In `packages/server/src/server.ts`, fetch policies when registry is configured:

- global sync: `listRegistrySkillRolloutPolicies({ target: "user-global" })`
- workspace sync: `listRegistrySkillRolloutPolicies({ workspaceId: workspace.id })`

Download each policy version package just like installation packages, convert to `WorkspaceSkillRolloutPolicy`, and pass `rolloutPolicies` into `resolveWorkspaceSkillSet`.

Use stable synthetic materialization ids for policies:

```ts
installationId: `rollout:${policy.id}`
```

This avoids changing the materializer contract in the first implementation.

**Step 6: Run server tests**

Run:

```bash
pnpm --filter veslo-server test -- workspace-skill-set server.skill-materialization
```

Expected: PASS.

**Step 7: Commit**

```bash
git add packages/server/src/types.ts packages/server/src/workspace-skill-set.ts packages/server/src/workspace-skill-set.test.ts packages/server/src/server.ts packages/server/src/server.skill-materialization.test.ts
git commit -m "feat: resolve rollout policy materializations"
```

## Task 7: Add App Client Wrappers And Action Constraints

**Files:**
- Modify: `packages/app/src/app/lib/veslo-server.ts`
- Modify: `packages/app/src/app/lib/veslo-server.test.ts`
- Modify: `packages/app/src/app/lib/skill-location-actions.ts`
- Modify: `packages/app/src/app/lib/skill-location-actions.test.ts`

**Step 1: Write app client tests**

In `veslo-server.test.ts`, add tests for:

```ts
await client.createRegistrySkillRolloutPolicy({
  skillId: "skill_1",
  versionId: "version_1",
  target: "user-global",
  audience: "user",
  userId: "user_1",
  catalogScope: "organization",
  orgId: "org_1",
})
```

Expected request:

```text
POST https://veslo.example/v1/skill-rollout-policies
```

Add list/update/delete wrapper coverage.

**Step 2: Write action constraint tests**

In `skill-location-actions.test.ts`, add a test that a same skill with user-global rollout and workspace rollout produces a move/retarget action rather than install action:

```ts
expect(actions.map((action) => action.id)).toContain("retarget-installation")
expect(actions.map((action) => action.id)).not.toContain("create-installation")
```

**Step 3: Run tests to verify they fail**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- veslo-server skill-location-actions
```

Expected: FAIL due to missing wrappers/action IDs.

**Step 4: Add app client types and methods**

In `packages/app/src/app/lib/veslo-server.ts`, add rollout policy input/response types mirroring local server validator types. Add methods:

- `listRegistrySkillRolloutPolicies`
- `createRegistrySkillRolloutPolicy`
- `updateRegistrySkillRolloutPolicy`
- `deleteRegistrySkillRolloutPolicy`

Use host token for write methods and `buildDenContextHeaders`.

**Step 5: Update action constraints**

In `skill-location-actions.ts`, add an action model that treats target changes as retarget operations. Do not expose a second install action when the same skill already has an active policy/install for another target.

**Step 6: Run app tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- veslo-server skill-location-actions
```

Expected: PASS.

**Step 7: Commit**

```bash
git add packages/app/src/app/lib/veslo-server.ts packages/app/src/app/lib/veslo-server.test.ts packages/app/src/app/lib/skill-location-actions.ts packages/app/src/app/lib/skill-location-actions.test.ts
git commit -m "feat: add app rollout policy client"
```

## Task 8: Update Docs

**Files:**
- Modify: `docs/features/skill-registry-and-distribution.md`
- Modify: `docs/dev/veslo-server-app-contract.md`
- Modify: `docs/dev/state-and-config-reference.md`

**Step 1: Update feature docs**

Document:

- catalog source and install target are separate
- rollout policies are the source of truth for automatic distribution
- user-global and workspace targets are mutually exclusive for the same skill/audience
- locked/admin-removable policies
- marketplace is deferred

**Step 2: Update server contract docs**

Add local proxy routes:

```text
GET    /v1/skill-rollout-policies
POST   /v1/skill-rollout-policies
PATCH  /v1/skill-rollout-policies/:id
DELETE /v1/skill-rollout-policies/:id
```

Clarify that materialization sync resolves rollout policies before writing managed files.

**Step 3: Update state/config docs**

Describe rollout policy events and pending materialization behavior.

**Step 4: Run docs sanity checks**

Run:

```bash
rg -n "rollout policy|skill-rollout-policies|user-global|locked" docs/features/skill-registry-and-distribution.md docs/dev/veslo-server-app-contract.md docs/dev/state-and-config-reference.md
```

Expected: all three docs mention the new rollout model.

**Step 5: Commit**

```bash
git add docs/features/skill-registry-and-distribution.md docs/dev/veslo-server-app-contract.md docs/dev/state-and-config-reference.md
git commit -m "docs: describe skill rollout policies"
```

## Task 9: Full Verification

**Files:**
- No source edits expected.

**Step 1: Run Den verification**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/skill-registry-routes.test.ts test/skill-registry-search.test.ts test/skill-registry-schema.test.ts
pnpm --filter @neatech/den build
```

Expected: PASS.

**Step 2: Run server verification**

Run:

```bash
pnpm --filter veslo-server test -- skill-registry-types skill-registry-client server.skill-registry-search workspace-skill-set server.skill-materialization
pnpm --filter veslo-server typecheck
pnpm --filter veslo-server build:bin
```

Expected: PASS.

**Step 3: Run app verification**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- veslo-server skill-location-actions
pnpm typecheck
```

Expected: PASS.

**Step 4: Run desktop E2E preflight**

Before starting any desktop runtime or E2E test, follow `docs/dev/testing-playbook.md` and terminate any Veslo dev/test processes started by this repo.

Run:

```bash
pgrep -af "(veslo|tauri|webdriver|chromedriver|geckodriver|safaridriver)" || true
```

Expected: no relevant leftover process from this repo.

**Step 5: Build and run focused desktop E2E**

Run from `packages/desktop`:

```bash
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json -- --features e2e
```

Run from `packages/e2e`:

```bash
pnpm test --spec ./specs/skill-registry-materialization.e2e.ts
pnpm test --spec ./specs/shared-workspace-skill-lock.e2e.ts
```

If new rollout-specific E2E specs are added during implementation, run those too.

Expected: PASS.

**Step 6: Final cleanup check**

Run:

```bash
git diff --check
pgrep -af "(veslo|tauri|webdriver|chromedriver|geckodriver|safaridriver)" || true
git status --short
```

Expected: no whitespace errors, no relevant leftover runtime process, and only intentional changes remain.

**Step 7: Commit verification-only fixes if needed**

If verification required small fixes:

```bash
git add <fixed-files>
git commit -m "test: verify skill rollout policies"
```

Do not commit unrelated dirty files.
