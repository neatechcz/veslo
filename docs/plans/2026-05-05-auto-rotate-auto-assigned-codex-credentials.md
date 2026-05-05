# Auto-Rotate Auto-Assigned Codex Credentials Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automatically move users who received Veslo-managed Codex access during sign-up to another healthy Codex credential when their assigned credential becomes missing, unhealthy, revoked, or exhausted.

**Architecture:** Store assignment provenance on `user_ai_access_policy` so Veslo can distinguish automatic sign-up assignments from explicit admin assignments. Sign-up writes `auto_assigned`; admin writes `admin_assigned`; runtime Codex proxy flow lazily repairs only `auto_assigned` Codex policies before resolving the required binding. The repair service reuses the same healthy/eligible Codex credential criteria as sign-up and audits successful rotations.

**Tech Stack:** TypeScript, Express, node:test, Drizzle MySQL schema/migrations, DEN managed-AI service, AI Gateway mirror.

---

### Task 1: Add Assignment Provenance To AI Access Records

**Files:**
- Modify: `services/den/src/managed-ai/access/repository.ts`
- Modify: `services/den/src/managed-ai/access/mysql-repository.ts`
- Modify: `services/den/src/managed-ai/schema.ts`
- Create: `services/den/drizzle/0011_user_ai_access_assignment_origin.sql`
- Modify: `services/ai-gateway/src/access/repository.ts`
- Modify: `services/ai-gateway/src/access/mysql-repository.ts`
- Modify: `services/ai-gateway/src/db/schema.ts`
- Modify: `services/ai-gateway/src/db/schema-reconcile.ts`
- Create: `services/ai-gateway/drizzle/0002_user_ai_access_assignment_origin.sql`

**Step 1: Write failing repository tests**

Add or extend focused tests so a stored policy round-trips this field:

```ts
assert.equal(policy.assignmentOrigin, "auto_assigned")
```

Also verify legacy/null values map to `"admin_assigned"` so existing rows are preserved.

**Step 2: Run tests and confirm failure**

Run:

```bash
pnpm --filter @neatech/den test -- test/admin-managed-ai-user-access.test.ts
pnpm --filter @neatech/ai-gateway test -- test/admin-user-access.test.ts
```

Expected: TypeScript or assertion failure because `assignmentOrigin` does not exist.

**Step 3: Implement minimal schema and repository support**

Add:

```ts
export const AI_ACCESS_ASSIGNMENT_ORIGINS = ["auto_assigned", "admin_assigned"] as const
export type AiAccessAssignmentOrigin = (typeof AI_ACCESS_ASSIGNMENT_ORIGINS)[number]
```

Add `assignmentOrigin: AiAccessAssignmentOrigin` to `UserAiAccessPolicyRecord` and `UpsertUserAiAccessPolicyInput`.

Map database field `assignment_origin` to camel-case `assignmentOrigin`. Unknown, empty, or missing values must become `"admin_assigned"`.

Migration:

```sql
ALTER TABLE user_ai_access_policy
  ADD COLUMN assignment_origin varchar(32) NOT NULL DEFAULT 'admin_assigned';
```

AI Gateway reconcile must include the column in table creation and call:

```ts
await ensureColumn(db, "user_ai_access_policy", "assignment_origin", "varchar(32) NOT NULL DEFAULT 'admin_assigned'")
```

**Step 4: Run tests**

Run the same focused commands. Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/src/managed-ai/access services/den/src/managed-ai/schema.ts services/den/drizzle/0011_user_ai_access_assignment_origin.sql services/ai-gateway/src/access services/ai-gateway/src/db services/ai-gateway/drizzle/0002_user_ai_access_assignment_origin.sql
git commit -m "feat: track ai access assignment origin"
```

### Task 2: Mark Sign-Up Assignments As Automatic And Admin Assignments As Manual

**Files:**
- Modify: `services/den/src/managed-ai/signup-assignment.ts`
- Modify: `services/den/src/managed-ai/http/admin.ts`
- Modify: `services/den/test/managed-ai-signup-assignment.test.ts`
- Modify: `services/den/test/admin-managed-ai-user-access.test.ts`
- Modify: `services/ai-gateway/src/http/admin.ts`
- Modify: `services/ai-gateway/test/admin-user-access.test.ts`

**Step 1: Write failing tests**

In sign-up assignment tests, assert the upsert includes:

```ts
assignmentOrigin: "auto_assigned"
```

In admin access tests, assert admin writes include:

```ts
assignmentOrigin: "admin_assigned"
```

**Step 2: Run tests and confirm failure**

Run:

```bash
pnpm --filter @neatech/den test -- test/managed-ai-signup-assignment.test.ts test/admin-managed-ai-user-access.test.ts
pnpm --filter @neatech/ai-gateway test -- test/admin-user-access.test.ts
```

Expected: assertions fail because callers do not set provenance.

**Step 3: Implement caller changes**

Add `assignmentOrigin: "auto_assigned"` to `maybeAssignDefaultCodexAccessForNewUser`.

Add `assignmentOrigin: "admin_assigned"` to all admin user AI access upserts in DEN and AI Gateway.

**Step 4: Run tests**

Run the same focused commands. Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/src/managed-ai/signup-assignment.ts services/den/src/managed-ai/http/admin.ts services/den/test/managed-ai-signup-assignment.test.ts services/den/test/admin-managed-ai-user-access.test.ts services/ai-gateway/src/http/admin.ts services/ai-gateway/test/admin-user-access.test.ts
git commit -m "feat: mark ai access assignment source"
```

### Task 3: Add Auto-Assigned Codex Rotation Service

**Files:**
- Create: `services/den/src/managed-ai/access/auto-assignment-rotation.ts`
- Create: `services/den/test/managed-ai-auto-assignment-rotation.test.ts`
- Create: `services/ai-gateway/src/access/auto-assignment-rotation.ts`
- Create: `services/ai-gateway/test/auto-assignment-rotation.test.ts`

**Step 1: Write failing service tests**

Cover these cases:

- `auto_assigned` Codex policy with exhausted assigned credential and a healthy replacement updates the same user policy.
- `auto_assigned` Codex policy with missing assigned credential updates to a healthy replacement.
- `admin_assigned` policy never rotates.
- OpenAI-compatible policy never rotates.
- No replacement keeps the existing policy unchanged.
- Successful rotation writes an audit event named `user.ai_access.auto_rotate`.

**Step 2: Run tests and confirm failure**

Run:

```bash
pnpm --filter @neatech/den test -- test/managed-ai-auto-assignment-rotation.test.ts
pnpm --filter @neatech/ai-gateway test -- test/auto-assignment-rotation.test.ts
```

Expected: module import fails.

**Step 3: Implement DEN service**

Expose:

```ts
export type AutoAssignedCodexCredentialRotationService = {
  repairCodexAccess(input: {
    aiAccess: UserAiAccessPolicyRecord
    reason?: string
  }): Promise<UserAiAccessPolicyRecord>
}
```

Rules:

- Return original policy unless it is enabled, `provider === "codex_oauth"`, `assignmentOrigin === "auto_assigned"`, and has a `credentialId`.
- Treat missing current credential, non-Codex current credential, non-healthy current credential, and ineligible Codex status as repair triggers.
- Do not rotate on transient status-provider throw; keep current policy so the existing proxy error path handles it.
- Replacement candidates must be `codex_oauth`, `healthy`, pass `evaluateCodexCredentialEligibility(status, now()).eligible`, and not be the current credential.
- Sort replacements by active leases, then name, then credential id.
- Upsert the same user policy preserving `enabled`, provider, model fields, and `assignmentOrigin: "auto_assigned"`.
- Audit successful rotations with previous credential id, new credential id, user id, reason, and provider.

**Step 4: Port the same service to AI Gateway**

Keep logic equivalent to DEN. Do not share cross-package runtime code in this change.

**Step 5: Run tests**

Run the same focused commands. Expected: PASS.

**Step 6: Commit**

```bash
git add services/den/src/managed-ai/access/auto-assignment-rotation.ts services/den/test/managed-ai-auto-assignment-rotation.test.ts services/ai-gateway/src/access/auto-assignment-rotation.ts services/ai-gateway/test/auto-assignment-rotation.test.ts
git commit -m "feat: rotate auto assigned codex credentials"
```

### Task 4: Wire Rotation Into Codex Proxy Runtime

**Files:**
- Modify: `services/den/src/managed-ai/runtime/default-runtime.ts`
- Modify: `services/den/src/managed-ai/http/proxy.ts`
- Modify: `services/den/src/managed-ai/http/providers/codex-oauth.ts`
- Modify: `services/den/test/managed-ai-codex-oauth-proxy.test.ts`
- Modify: `services/ai-gateway/src/runtime/default-runtime.ts`
- Modify: `services/ai-gateway/src/http/proxy.ts`
- Modify: `services/ai-gateway/src/http/providers/codex-oauth.ts`
- Modify: `services/ai-gateway/test/codex-oauth-proxy.test.ts`

**Step 1: Write failing proxy tests**

Add request-path tests:

- Auto-assigned Codex policy pointing at an exhausted credential rotates to a healthy replacement and the proxy uses replacement auth.
- Admin-assigned Codex policy pointing at the same exhausted credential does not rotate and returns the existing no-eligible response.
- Auto-assigned policy with no replacement does not overwrite the stored assignment.

**Step 2: Run tests and confirm failure**

Run:

```bash
pnpm --filter @neatech/den test -- test/managed-ai-codex-oauth-proxy.test.ts
pnpm --filter @neatech/ai-gateway test -- test/codex-oauth-proxy.test.ts
```

Expected: assertions fail because proxy does not call the rotation service.

**Step 3: Add proxy dependency**

Add an optional or required proxy dependency:

```ts
autoAssignedCodexCredentialRotation?: AutoAssignedCodexCredentialRotationService
```

Instantiate it in each default runtime with `aiAccess`, `credentials`, `codexStatusProvider`, and `audit`.

**Step 4: Repair before Codex policy enforcement**

In the Codex OAuth proxy route, before `applyAiAccessPolicy`, call:

```ts
const initialAiAccess = res.locals.gatewayAiAccess as UserAiAccessPolicyRecord | undefined
const gatewayAiAccess = initialAiAccess && deps.autoAssignedCodexCredentialRotation
  ? await deps.autoAssignedCodexCredentialRotation.repairCodexAccess({ aiAccess: initialAiAccess, reason: "codex_proxy_request" })
  : initialAiAccess
res.locals.gatewayAiAccess = gatewayAiAccess
```

Then use `gatewayAiAccess` for policy enforcement and assigned binding resolution.

**Step 5: Run proxy tests**

Run the same focused commands. Expected: PASS.

**Step 6: Commit**

```bash
git add services/den/src/managed-ai/runtime/default-runtime.ts services/den/src/managed-ai/http/proxy.ts services/den/src/managed-ai/http/providers/codex-oauth.ts services/den/test/managed-ai-codex-oauth-proxy.test.ts services/ai-gateway/src/runtime/default-runtime.ts services/ai-gateway/src/http/proxy.ts services/ai-gateway/src/http/providers/codex-oauth.ts services/ai-gateway/test/codex-oauth-proxy.test.ts
git commit -m "feat: repair auto assigned codex access at runtime"
```

### Task 5: Update Durable Behavior Docs

**Files:**
- Modify: `docs/admin-managed-ai-access.md`
- Modify: `docs/features/session-runtime.md`
- Modify: `docs/dev/state-and-config-reference.md`

**Step 1: Document behavior**

Add concise notes:

- Future sign-ups receive `auto_assigned` Codex access when eligible credentials exist.
- Admin user access edits are `admin_assigned` and are not auto-overwritten by health repair.
- Auto-assigned Codex access is lazily repaired on the next Codex request when the assigned credential is no longer eligible.
- If no healthy replacement exists, the request fails explicitly and Veslo keeps the existing assignment.

**Step 2: Commit**

```bash
git add docs/admin-managed-ai-access.md docs/features/session-runtime.md docs/dev/state-and-config-reference.md
git commit -m "docs: document codex credential auto rotation"
```

### Task 6: Final Verification

**Files:**
- Verify all touched DEN and AI Gateway behavior.

**Step 1: Run focused suites**

```bash
pnpm --filter @neatech/den test -- test/managed-ai-signup-assignment.test.ts test/admin-managed-ai-user-access.test.ts test/managed-ai-auto-assignment-rotation.test.ts test/managed-ai-codex-oauth-proxy.test.ts
pnpm --filter @neatech/ai-gateway test -- test/admin-user-access.test.ts test/auto-assignment-rotation.test.ts test/codex-oauth-proxy.test.ts
```

Expected: PASS.

**Step 2: Run package builds**

```bash
pnpm --filter @neatech/den build
pnpm --filter @neatech/ai-gateway build
```

Expected: PASS.

**Step 3: Check git status**

```bash
git status --short
```

Expected: empty or only intentional uncommitted files.

**Step 4: Summarize deployment requirement**

DEN and AI Gateway both need redeploy after merge because the database schema and proxy behavior change. Apply migrations before relying on the new rotation behavior in production/dev cloud environments.
