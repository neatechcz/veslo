# Admin Module Routing Regression Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore Admin Den startup by serving every JavaScript module imported by its entry module with a JavaScript response through the real AI Gateway route stack.

**Architecture:** Preserve the explicit Admin asset allowlist and protected shell routing. Add a route-level HTTP regression that derives relative JavaScript imports from the served entry module, then verifies each imported URL is returned as JavaScript and never as the HTML shell.

**Tech Stack:** TypeScript, Express, browser-native ES modules, Node test runner through `tsx --test`, pnpm.

---

### Task 1: Add the failing real-Gateway asset regression

**Files:**

- Modify: `services/ai-gateway/test/admin-ui.test.ts`

**Step 1: Write the failing test**

Add a test that starts `createApp({ admin: createAdminServiceStub() })` on loopback, requests `/admin/app.js` with the Admin cookie, extracts every relative `from "./*.js"` import, and requests each discovered module through the same server. For every module assert:

```ts
assert.equal(response.status, 200)
assert.match(response.headers.get("content-type") ?? "", /(?:java|ecma)script/i)
assert.doesNotMatch(await response.text(), /^\s*<!doctype html>/i)
```

Also assert that at least one relative module was discovered so a malformed parser cannot create a vacuous pass.

**Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm --dir services/ai-gateway exec tsx --test --test-name-pattern "serves every JavaScript module" test/admin-ui.test.ts
```

Expected: FAIL because `/admin/admin-page-load-state.js` returns `text/html` from the protected shell handler.

### Task 2: Correct the Admin asset classification

**Files:**

- Modify: `services/ai-gateway/src/http/admin.ts`

**Step 1: Implement the minimal production fix**

Add `/admin/admin-page-load-state.js` to `adminAssetRequest`. Do not reorder middleware or broaden the accepted path pattern.

**Step 2: Run the focused test to verify it passes**

Run the focused command from Task 1.

Expected: PASS, with every imported Admin module served using a JavaScript MIME type.

### Task 3: Verify the branch

**Files:**

- Verify only; no additional source changes expected.

**Step 1: Run the complete Gateway suite**

```bash
pnpm --dir services/ai-gateway test
```

Expected: PASS.

**Step 2: Build the Gateway**

```bash
pnpm --dir services/ai-gateway build
```

Expected: PASS.

**Step 3: Repeat the real HTTP probe**

Use the focused route regression or an ephemeral Gateway process and confirm the page-load module returns a successful JavaScript response whose body starts with module exports, not HTML.

**Step 4: Run the repository quality command**

```bash
pnpm check
```

Expected: PASS when the branch provides the canonical command. If this historical branch lacks the command, record the tooling gap and rely on the applicable Gateway tests and build rather than inventing a replacement contract.

**Step 5: Review the final diff**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors and only the approved design, plan, test, and route classification changes.

**Step 6: Commit the repair**

```bash
git add docs/plans/2026-07-20-admin-module-routing-regression-design.md docs/plans/2026-07-20-admin-module-routing-regression-implementation-plan.md services/ai-gateway/test/admin-ui.test.ts services/ai-gateway/src/http/admin.ts
git commit -m "fix(ai-gateway): serve imported admin modules"
```
