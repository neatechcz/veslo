# Codex Read-Path Rotation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Repair stale `codex_oauth` admin assignments when AI-access policy read endpoints load them, so the admin Users page shows the healthy replacement credential immediately.

**Architecture:** Reuse the existing Codex credential rotation service on policy reads. Keep the service as the only place that chooses replacements and writes repaired policy rows.

**Tech Stack:** TypeScript, Express, node:test, pnpm workspace scripts.

---

### Task 1: Add AI Gateway admin read regression

**Files:**
- Modify: `services/ai-gateway/test/admin-user-access.test.ts`

**Steps:**
1. Add a test for `GET /admin/api/users/:userId/ai-access` with an admin-assigned `codex_oauth` row pointing at `cred_old`.
2. Provide `credentialReadRepository`, `aiAccessRepository`, `codexStatusProvider`, and `auditRepository` dependencies.
3. Expect the endpoint to return `credentialId: "cred_new"` and preserve `assignmentOrigin: "admin_assigned"` in the upsert call.
4. Run `pnpm --filter @neatech/ai-gateway test -- test/admin-user-access.test.ts` and verify the new test fails before implementation.

### Task 2: Add DEN admin read regression

**Files:**
- Modify: `services/den/test/admin-managed-ai-user-access.test.ts`

**Steps:**
1. Add a matching test for DEN managed-AI admin `GET /admin/api/users/:userId/ai-access`.
2. Use the managed-AI route deps with an admin session, in-memory policy dependency, eligible replacement credential, and Codex status provider.
3. Expect `cred_new` in the response and `admin_assigned` preserved in the upsert call.
4. Run `pnpm --filter @neatech/den test -- test/admin-managed-ai-user-access.test.ts` and verify the test fails before implementation.

### Task 3: Implement read-path repair

**Files:**
- Modify: `services/ai-gateway/src/http/admin.ts`
- Modify: `services/ai-gateway/src/http/user-credentials.ts`
- Modify: `services/ai-gateway/src/runtime/default-runtime.ts`
- Modify: `services/den/src/managed-ai/http/admin.ts`
- Modify: `services/den/src/managed-ai/http/user-credentials.ts`
- Modify: `services/den/src/managed-ai/runtime/default-runtime.ts`

**Steps:**
1. Add a small helper that calls `repairCodexAccess` for a loaded policy and returns the original policy if repair throws.
2. Use it in admin read endpoints before serialization.
3. Add optional repair service support to user self-read routes and wire runtime defaults.
4. Run the focused tests until green.

### Task 4: Verify and deploy

**Steps:**
1. Run AI Gateway tests and build.
2. Run DEN tests and build.
3. Commit the read-path fix.
4. Push `main`.
5. Redeploy AI Gateway dev and DEN workflows from the new commit.
6. Verify live health endpoints.
