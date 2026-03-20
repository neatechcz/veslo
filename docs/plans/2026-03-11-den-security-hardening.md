# DEN Security Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate the highest-risk DEN control-plane security issues found in audit while preserving existing product flows.

**Architecture:** Harden the DEN server (`services/den`) at trust boundaries: startup/bootstrap, token issuance and storage, desktop auth handoff, and billing identity linking. Keep changes incremental and mostly server-local to avoid broad product regressions.

**Tech Stack:** TypeScript, Express, Drizzle ORM (MySQL), Better Auth, Node test runner (`tsx --test`)

---

### Task 1: Startup Safety Hardening

**Files:**
- Modify: `services/den/src/index.ts`

**Step 1: Remove destructive auth-table recreation path**
- Delete the runtime branch that drops and recreates Better Auth tables.
- Replace with a non-destructive compatibility check that fails with an explicit migration error.

**Step 2: Fail closed on bootstrap errors**
- Ensure table/bootstrap errors do not allow server startup.
- Return process exit on bootstrap failure.

**Step 3: Verify**
- Run: `pnpm --dir services/den test`
- Expected: Existing tests pass.

### Task 2: Worker Token Hardening

**Files:**
- Create: `services/den/src/security/token-crypto.ts`
- Modify: `services/den/src/env.ts`
- Modify: `services/den/src/http/workers.ts`

**Step 1: Add token encryption utility**
- Implement reversible encryption/decryption for worker tokens with a versioned format and backward compatibility for legacy plaintext records.

**Step 2: Wire encryption into worker token lifecycle**
- Encrypt host/client tokens before persistence.
- Decrypt tokens on authorized read paths.

**Step 3: Reduce host-token exposure**
- Restrict host-token visibility to worker creator, org owner, or platform admin.
- Keep client token availability for org members.
- Add audit event for token reveal action.

**Step 4: Verify**
- Run: `pnpm --dir services/den test`
- Expected: Existing tests pass with new behavior coverage.

### Task 3: Desktop Handoff Atomic Exchange

**Files:**
- Modify: `services/den/src/http/desktop-auth.ts`

**Step 1: Make exchange single-use at DB layer**
- Move exchange logic into transaction with conditional consume update.
- Prevent replay under concurrent requests.

**Step 2: Add handoff cleanup**
- Purge stale/expired handoff codes during auth flow to reduce replay surface and table growth.

**Step 3: Verify**
- Run: `pnpm --dir services/den test`
- Expected: Existing handoff tests pass; behavior remains backward compatible.

### Task 4: Billing Entitlement Link Hardening

**Files:**
- Modify: `services/den/src/http/session.ts`
- Modify: `services/den/src/http/workers.ts`
- Modify: `services/den/src/billing/polar.ts`

**Step 1: Carry email verification state through session context**
- Include `emailVerified` in session context.

**Step 2: Gate email-based Polar fallback**
- Keep `external_customer_id` lookup first.
- Only allow fallback linking by email when DEN session email is verified.

**Step 3: Verify**
- Run: `pnpm --dir services/den test`
- Expected: tests pass and type checks remain green.

### Task 5: Security Regression Tests + Deployment Validation

**Files:**
- Create/Modify: `services/den/test/*.test.ts`

**Step 1: Add tests for new access invariants**
- Cover host token visibility policy and token crypto behavior.

**Step 2: Full DEN verification**
- Run: `pnpm --dir services/den test`
- Run (if needed): `pnpm --dir services/den build`

**Step 3: Development deployment attempt**
- Try local dev deployment path and document exact command + result.
- If remote dev deployment is unavailable due credentials/infra, report blocker and provide exact reproduction commands.

**Step 4: Final security pass**
- Re-scan changed surfaces for residual high-risk issues and list remaining gaps.
