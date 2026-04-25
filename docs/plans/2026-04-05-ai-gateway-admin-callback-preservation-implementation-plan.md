# AI Gateway Admin Callback Preservation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Preserve `/admin` browser-auth callback query params long enough for the hosted admin SPA to exchange the handoff code and surface the correct non-admin error.

**Architecture:** Keep the fix in the hosted admin SPA. Route normalization in `public-admin/app.js` should preserve `location.search` and `location.hash` when it rewrites `/admin/` to `/admin`, so `initializeAuth()` still sees `code` plus `sessionId` or `transactionId`. Keep backend auth behavior unchanged because live verification shows the backend already returns the correct `403 forbidden` for non-admin users.

**Tech Stack:** Vanilla browser JS in `services/ai-gateway/public-admin/app.js`, Node test runner in `services/ai-gateway/test/admin-ui.test.ts`

---

### Task 1: Lock In The Regression

**Files:**
- Modify: `services/ai-gateway/test/admin-ui.test.ts`

**Step 1: Write the failing test**

Update the existing callback-preservation test so it expects route normalization to preserve callback query params instead of replacing history with the bare normalized path.

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/ai-gateway test -- admin-ui.test.ts`

Expected: FAIL because the current script rewrites to `nextPath` and drops `location.search`.

**Step 3: Commit**

Do not commit yet. Continue to the minimal implementation.

### Task 2: Preserve Callback Params In The SPA

**Files:**
- Modify: `services/ai-gateway/public-admin/app.js`

**Step 1: Write minimal implementation**

In `setActivePage(page)`, compute the normalized URL with the existing `location.search` and `location.hash`, and only call `history.replaceState` with that full URL when the pathname changes.

**Step 2: Run targeted test to verify it passes**

Run: `pnpm --filter @neatech/ai-gateway test -- admin-ui.test.ts`

Expected: PASS for the updated callback-preservation assertion.

### Task 3: Verify The Full Package

**Files:**
- No code changes

**Step 1: Run package tests**

Run: `pnpm --filter @neatech/ai-gateway test`

Expected: Full ai-gateway suite passes.

**Step 2: Optional build verification**

Run: `pnpm --filter @neatech/ai-gateway build`

Expected: Build succeeds with the unchanged backend.
