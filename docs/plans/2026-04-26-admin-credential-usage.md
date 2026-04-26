# Admin Credential Usage Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show usage for every credential on the hosted AI Gateway admin Usage page, with best-effort Codex limits/status metadata.

**Architecture:** Extend the existing admin usage response rather than adding a second endpoint. Compose recorded usage from the usage repository with the full credential list from the credential repository in the admin service, then render the new `credentialUsage` list in the static admin UI. Keep Codex limits status failure-tolerant and secret-safe.

**Tech Stack:** TypeScript, Express, Drizzle-backed repositories, Node test runner through `tsx`, static HTML/CSS/JS admin shell.

---

### Task 1: Add Usage API Contract Coverage

**Files:**
- Modify: `services/ai-gateway/test/admin-read-models.test.ts`
- Modify: `services/ai-gateway/src/usage/repository.ts`
- Modify: `services/ai-gateway/src/http/admin.ts`

**Step 1: Write the failing test**

Add a test that calls `GET /admin/api/usage?groupBy=credential` with two credentials, where only one appears in the aggregate usage response. Assert that the JSON includes `credentialUsage` for both credentials and that the Codex credential has a status object.

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/ai-gateway exec tsx --test services/ai-gateway/test/admin-read-models.test.ts`

Expected: FAIL because `credentialUsage` is not present.

**Step 3: Implement minimal API contract**

Add exported usage types for per-credential usage and upstream status. Update the admin service to compose `credentialUsage` from `listAdminCredentials()` plus `aggregateUsage()`.

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @neatech/ai-gateway exec tsx --test services/ai-gateway/test/admin-read-models.test.ts`

Expected: PASS.

### Task 2: Add Credential Usage UI Coverage

**Files:**
- Modify: `services/ai-gateway/test/admin-ui.test.ts`
- Modify: `services/ai-gateway/public-admin/index.html`
- Modify: `services/ai-gateway/public-admin/app.js`
- Modify: `services/ai-gateway/public-admin/app.css`

**Step 1: Write the failing tests**

Assert that `/admin/usage` contains a credential usage table target and that `/admin/app.js` references `credentialUsage`, renders Codex limits status, and falls back for credentials without upstream status.

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/ai-gateway exec tsx --test services/ai-gateway/test/admin-ui.test.ts`

Expected: FAIL because the DOM target and render logic do not exist.

**Step 3: Implement minimal UI**

Add a table or card section under the existing Usage series. Render credential name, provider, state, requests, tokens, active leases, last usage, and upstream status.

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @neatech/ai-gateway exec tsx --test services/ai-gateway/test/admin-ui.test.ts`

Expected: PASS.

### Task 3: Add Codex Status Provider Seam

**Files:**
- Create: `services/ai-gateway/src/usage/codex-status.ts`
- Modify: `services/ai-gateway/src/http/admin.ts`
- Test: `services/ai-gateway/test/admin-read-models.test.ts`

**Step 1: Write the failing test**

Add test coverage for injected Codex status text or unavailable status, proving the API shape is stable and secret-free.

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/ai-gateway exec tsx --test services/ai-gateway/test/admin-read-models.test.ts`

Expected: FAIL until the status provider is wired.

**Step 3: Implement minimal status provider**

Add a small parser/provider that returns unavailable status by default and can parse status text supplied by configuration or dependency injection. Do not run interactive `/status` synchronously on page load.

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @neatech/ai-gateway exec tsx --test services/ai-gateway/test/admin-read-models.test.ts`

Expected: PASS.

### Task 4: Verify And Build

**Files:**
- Modify only if verification reveals defects.

**Step 1: Run focused tests**

Run: `pnpm --filter @neatech/ai-gateway exec tsx --test services/ai-gateway/test/admin-read-models.test.ts services/ai-gateway/test/admin-ui.test.ts`

Expected: PASS.

**Step 2: Run service build**

Run: `pnpm --filter @neatech/ai-gateway build`

Expected: PASS.

**Step 3: Check git status**

Run: `git status --short`

Expected: only intentional feature files are changed.
