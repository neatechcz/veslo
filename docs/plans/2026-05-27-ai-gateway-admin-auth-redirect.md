# AI Gateway Admin Auth Redirect Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent unauthenticated users from seeing the AI Gateway admin shell by redirecting `/admin` and `/admin/*` to the existing Den login flow.

**Architecture:** Reuse the existing Den desktop-auth browser handoff URL instead of adding an admin login page. The AI Gateway server starts the handoff, stores PKCE proof in an HTTP-only pending cookie, redirects to Den, exchanges the callback code, stores the returned Den admin token in an HTTP-only admin cookie, and only then serves the admin shell.

**Tech Stack:** TypeScript, Express, Den desktop-auth v1 handoff, Node test runner via `tsx --test`.

---

### Task 1: Add Redirect And Cookie Tests

**Files:**
- Modify: `services/ai-gateway/test/admin-ui.test.ts`

**Steps:**
1. Add a reusable admin service stub.
2. Update shell-render tests to send an admin cookie.
3. Add a failing test for unauthenticated `/admin/credentials` returning `302` to the Den `authorizeUrl`.
4. Add a failing callback test that exchanges the code, sets the admin auth cookie, clears the pending cookie, and redirects to the original admin path.
5. Add a failing API test that accepts the admin token from cookie.
6. Add a failing source test that client bootstrap validates the cookie session instead of showing the login panel immediately when localStorage has no token.
7. Run `pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-ui.test.ts` and confirm the new tests fail.

### Task 2: Implement Server-Side Admin Gate

**Files:**
- Modify: `services/ai-gateway/src/http/admin.ts`

**Steps:**
1. Add cookie parsing and serialization helpers.
2. Add PKCE state/verifier generation for server-started auth.
3. Add request-origin and safe-admin-return-path helpers.
4. Add protected admin shell handling before static admin shell routes.
5. On missing/invalid admin cookie, call `adminService.startBrowserAuth`, store pending proof cookie, and redirect to Den authorize URL.
6. On callback with `code` and `sessionId`, read pending proof, call `adminService.exchangeBrowserAuth`, set the admin token cookie, clear pending proof, and redirect to the stored admin return path.
7. Make admin API auth read bearer auth first and then the admin token cookie.
8. Add a sign-out endpoint that clears the admin token cookie.

### Task 3: Update Admin Client Fallback

**Files:**
- Modify: `services/ai-gateway/public-admin/app.js`

**Steps:**
1. Let `bootstrapSession()` call `/admin/api/session` even when localStorage has no token, so HTTP-only cookie sessions work.
2. On invalid/expired auth, clear localStorage and navigate to the current admin path so the server redirect starts the Den login flow.
3. On sign-out, call the sign-out endpoint and navigate back to `/admin`.

### Task 4: Document Durable Behavior

**Files:**
- Modify: `docs/dev/cloud-deployments.md`

**Steps:**
1. Document that standalone AI Gateway admin routes use server-side redirect to existing Den desktop-auth login.
2. Document that unauthenticated users should not receive the admin shell.

### Task 5: Verify

**Commands:**
- `pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-ui.test.ts`
- `pnpm --filter @neatech/ai-gateway build`

Expected: all focused admin UI tests pass and the gateway builds.
