# Codex Admin Assignment Rotation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rotate all assigned Codex OAuth user policies away from unavailable credentials, including admin-assigned policies.

**Architecture:** The existing Codex proxy already invokes a rotation service before policy enforcement. Broaden that service from `auto_assigned` only to all enabled `codex_oauth` policies and preserve assignment origin on update. Add the missing AI Gateway runtime credential listing method so the standalone gateway can discover healthy replacement credentials.

**Tech Stack:** TypeScript, Express, Drizzle MySQL schema models, `node:test`, pnpm workspace scripts.

---

### Task 1: Prove Admin-Assigned Codex Policies Rotate

**Files:**
- Modify: `services/ai-gateway/test/auto-assignment-rotation.test.ts`
- Modify: `services/den/test/managed-ai-auto-assignment-rotation.test.ts`

**Step 1: Write failing tests**

Add a test in each service proving an `admin_assigned` `codex_oauth` policy pointing at an exhausted credential rotates to the healthy replacement and the saved policy keeps `assignmentOrigin: "admin_assigned"`.

Add a separate negative test proving an `admin_assigned` non-Codex policy is not read, probed, or written by the Codex rotation service.

**Step 2: Run tests to verify failure**

Run:

```bash
pnpm --filter @neatech/ai-gateway test -- test/auto-assignment-rotation.test.ts
pnpm --filter @neatech/den test -- test/managed-ai-auto-assignment-rotation.test.ts
```

Expected: the admin-assigned Codex rotation tests fail because the service still exits early for `admin_assigned`.

**Step 3: Implement minimal service change**

Update both rotation services to remove the `assignmentOrigin !== "auto_assigned"` early return. Preserve `aiAccess.assignmentOrigin` in the upsert input.

**Step 4: Run tests to verify pass**

Run the same focused test commands. Expected: PASS.

### Task 2: Prove Standalone AI Gateway Runtime Can Discover Replacements

**Files:**
- Modify: `services/ai-gateway/test/runtime-persistence.test.ts`
- Modify: `services/ai-gateway/src/credentials/mysql-repository.ts`

**Step 1: Write failing runtime test**

Add a default-runtime test that creates two platform Codex OAuth credentials through `runtime.credentials`, then calls `runtime.credentials.listAdminCredentials?.()` and asserts both credentials are returned with names, states, active lease counts, and token totals.

**Step 2: Run test to verify failure**

Run:

```bash
pnpm --filter @neatech/ai-gateway test -- test/runtime-persistence.test.ts
```

Expected: FAIL because `listAdminCredentials` is undefined on `MySqlCredentialRepository`.

**Step 3: Implement minimal repository method**

Port the DEN `listAdminCredentials` method into `services/ai-gateway/src/credentials/mysql-repository.ts`, using the existing AI Gateway repository types and `formatProviderLabel` helper if needed.

**Step 4: Run test to verify pass**

Run the same focused runtime test command. Expected: PASS.

### Task 3: Verify Integration Surface

**Files:**
- Existing test files only unless regressions reveal missing coverage.

**Step 1: Run focused proxy and rotation tests**

Run:

```bash
pnpm --filter @neatech/ai-gateway test -- test/auto-assignment-rotation.test.ts test/proxy.test.ts test/runtime-persistence.test.ts
pnpm --filter @neatech/den test -- test/managed-ai-auto-assignment-rotation.test.ts test/managed-ai-codex-oauth-proxy.test.ts
```

Expected: PASS.

**Step 2: Run build checks**

Run:

```bash
pnpm --filter @neatech/ai-gateway build
pnpm --filter @neatech/den build
```

Expected: PASS.
