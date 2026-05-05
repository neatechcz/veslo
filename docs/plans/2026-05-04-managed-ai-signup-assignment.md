# Managed AI Sign-Up Assignment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Guarantee that future user sign-ups receive a healthy Codex credential when one is available.

**Architecture:** Move the auto-assignment decision into DEN’s auth `user.create.after` hook so the normal auth/sign-up path and the admin-created-user path both inherit the same behavior. Keep the assignment logic idempotent and non-fatal: it should skip users who already have AI access, skip when managed AI is not configured, and log but not block sign-up when assignment fails.

**Tech Stack:** TypeScript, Better Auth, Drizzle/MySQL repositories, node:test

---

### Task 1: Add a managed-AI signup assignment helper

**Files:**
- Create: `services/den/src/managed-ai/signup-assignment.ts`
- Test: `services/den/test/managed-ai-signup-assignment.test.ts`

**Step 1: Write the failing test**

Cover these cases:
- a new user gets `codex_oauth` AI access when one healthy eligible Codex credential exists
- an existing AI access policy prevents overwriting
- no assignment happens when no eligible Codex credential exists
- assignment failures are logged but do not throw

**Step 2: Run test to verify it fails**

Run: `pnpm --filter den test services/den/test/managed-ai-signup-assignment.test.ts`
Expected: fail because the helper does not exist yet.

**Step 3: Write minimal implementation**

Implement a small helper that:
- reads managed AI repositories from the DEN database
- checks for existing AI access first
- selects the least-loaded healthy eligible Codex credential
- writes `enabled: true`, `provider: "codex_oauth"`, `defaultModel: "gpt-5.5"`, `allowedModels: ["gpt-5.5"]`
- catches and logs unexpected failures

**Step 4: Run test to verify it passes**

Run: `pnpm --filter den test services/den/test/managed-ai-signup-assignment.test.ts`
Expected: PASS

### Task 2: Wire the helper into auth sign-up

**Files:**
- Modify: `services/den/src/auth.ts`
- Test: `services/den/test/auth-email-source.test.ts`

**Step 1: Write the failing test**

Add a source assertion that the auth user-create hook calls the new managed-AI helper.

**Step 2: Run test to verify it fails**

Run: `pnpm --filter den test services/den/test/auth-email-source.test.ts`
Expected: fail until the helper call is present.

**Step 3: Write minimal implementation**

Import the helper and call it from `databaseHooks.user.create.after` after the default org is ensured, with local error handling so sign-up still succeeds.

**Step 4: Run test to verify it passes**

Run: `pnpm --filter den test services/den/test/auth-email-source.test.ts`
Expected: PASS

### Task 3: Remove duplicate gateway auto-assignment

**Files:**
- Modify: `services/ai-gateway/src/http/admin.ts`
- Test: `services/ai-gateway/test/admin-actions.test.ts`

**Step 1: Write the failing test**

Add or adjust a test so gateway user creation no longer performs its own auto-assignment path.

**Step 2: Run test to verify it fails**

Run: `pnpm --filter ai-gateway test services/ai-gateway/test/admin-actions.test.ts`
Expected: fail until the duplicate assignment code is removed.

**Step 3: Write minimal implementation**

Delete the create-user-time Codex auto-assignment block from the gateway admin service.

**Step 4: Run test to verify it passes**

Run: `pnpm --filter ai-gateway test services/ai-gateway/test/admin-actions.test.ts`
Expected: PASS
