# DEN Auth Startup Precedence Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Tauri startup prefer the desktop auth snapshot over stale browser auth when the signed-in identity conflicts, and honor snapshot-driven signed-out state.

**Architecture:** Keep the current browser-storage auth model, but harden `hydrateDenAuthFromDesktopSnapshot()` so it compares the active browser identity with the snapshot identity before deciding to skip import. Matching identities keep existing browser state; conflicting identities or explicit signed-out snapshots repair browser state from the desktop snapshot before the rest of app bootstrap continues.

**Tech Stack:** SolidJS app shell, TypeScript, Node test runner, Tauri desktop snapshot bridge.

---

### Task 1: Add failing auth hydration regression tests

**Files:**
- Modify: `packages/app/src/app/lib/den-auth.test.ts`

**Step 1: Write the failing tests**

Add focused tests for:
- stale browser auth vs different snapshot user -> snapshot wins
- same user in browser auth and snapshot -> browser auth stays
- snapshot `keepSignedIn: false` clears existing browser auth

**Step 2: Run test to verify it fails**

Run: `pnpm --dir packages/app exec node --test --import=tsx/esm src/app/lib/den-auth.test.ts`

Expected: the new startup precedence tests fail against current behavior.

### Task 2: Implement startup precedence hardening

**Files:**
- Modify: `packages/app/src/app/lib/den-auth.ts`

**Step 1: Add identity comparison helpers**

Compare signed-in identities using stable Den user data:
- prefer user id when both sides have it
- fall back to normalized email when both sides have it
- treat partial identity data as unknown, not mismatch

**Step 2: Harden snapshot hydration**

Update `hydrateDenAuthFromDesktopSnapshot()` so that:
- snapshot `keepSignedIn: false` clears stale browser auth even if local/session storage already contains auth
- conflicting snapshot identity replaces stale browser auth
- matching or unknown identities keep current browser auth and sync the desktop snapshot from current state

**Step 3: Keep side effects scoped**

Preserve current language/onboarding restore behavior and current auth-change notifications.

### Task 3: Verify and document the behavior

**Files:**
- Modify: `docs/dev/state-and-config-reference.md`

**Step 1: Run focused tests**

Run: `pnpm --dir packages/app exec node --test --import=tsx/esm src/app/lib/den-auth.test.ts`

Expected: all `den-auth` tests pass.

**Step 2: Run adjacent auth/bootstrap checks**

Run: `pnpm --dir packages/app exec node --test --import=tsx/esm src/app/app-managed-ai-bootstrap-gate.test.ts src/app/lib/ai-access.test.ts`

Expected: managed AI bootstrap checks still pass.

**Step 3: Update docs**

Document that on Tauri startup the desktop snapshot overrides stale browser auth when identities conflict or when the snapshot explicitly represents a signed-out state.
