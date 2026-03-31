# AI Gateway Admin UI Auth Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship a working web admin control plane for `services/ai-gateway` that reuses Den bearer auth, enforces `platform_admin`, deploys to Render, and passes live Playwright verification.

**Architecture:** Keep the admin UI inside `services/ai-gateway` so the gateway remains a standalone control-plane service. Use Den as the identity authority through small admin-session and user-directory endpoints, and let `ai-gateway` own the admin shell plus gateway read models. Start with fixture-backed read models where Slice B persistence is not finished yet, but keep route contracts final.

**Tech Stack:** TypeScript, Express, Better Auth bearer sessions via Den, minimal server-served HTML/CSS/JS, Node test runner via `tsx --test`, Render, Playwright MCP

---

### Task 1: Add Den admin session snapshot endpoint

**Files:**
- Create: `services/den/src/http/admin.ts`
- Modify: `services/den/src/index.ts`
- Test: `services/den/test/admin-auth.test.ts`

**Step 1: Write the failing Den auth test**

Cover:

- `GET /v1/admin/session` returns `401` without bearer auth
- returns `200` with authenticated session payload
- includes `platformAdmin`

**Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/admin-auth.test.ts
```

Expected: FAIL because the route does not exist.

**Step 3: Implement the minimal route**

- reuse `auth.api.getSession`
- reuse `isPlatformAdmin`
- return authenticated user summary and `platformAdmin`

**Step 4: Re-run the focused test**

Run the same command and expect PASS.

**Step 5: Commit**

```bash
git add services/den/src/http/admin.ts services/den/src/index.ts services/den/test/admin-auth.test.ts
git commit -m "feat: add den admin session snapshot"
```

### Task 2: Add Den platform-admin user directory endpoints

**Files:**
- Modify: `services/den/src/http/admin.ts`
- Test: `services/den/test/admin-users.test.ts`

**Step 1: Write the failing user-directory tests**

Cover:

- platform admin can list users
- non-admin is rejected
- platform admin can update admin flag / disable flag

**Step 2: Run the focused test to verify it fails**

```bash
pnpm --filter @neatech/den exec tsx --test test/admin-users.test.ts
```

Expected: FAIL because the endpoints do not exist yet.

**Step 3: Implement minimal admin user endpoints**

Add:

- `GET /v1/admin/users`
- `PATCH /v1/admin/users/:userId`

Use existing `user`, `platform_role`, and org membership tables.

**Step 4: Re-run the focused test**

Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/src/http/admin.ts services/den/test/admin-users.test.ts
git commit -m "feat: add den platform admin user directory"
```

### Task 3: Add ai-gateway admin auth middleware and Den client

**Files:**
- Create: `services/ai-gateway/src/admin/den-client.ts`
- Create: `services/ai-gateway/src/admin/auth.ts`
- Modify: `services/ai-gateway/src/env.ts`
- Modify: `services/ai-gateway/src/index.ts`
- Test: `services/ai-gateway/test/admin-auth.test.ts`

**Step 1: Write the failing ai-gateway auth test**

Cover:

- `/admin` returns `401` without bearer token
- rejects non-admin user snapshot
- accepts `platformAdmin`

**Step 2: Run the focused test to verify it fails**

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-auth.test.ts
```

Expected: FAIL because no admin auth middleware exists.

**Step 3: Implement minimal Den-backed admin auth**

- add `DEN_API_BASE` env support to `ai-gateway`
- call Den `GET /v1/admin/session` with the incoming bearer token
- gate on `platformAdmin === true`

**Step 4: Re-run the focused test**

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/admin services/ai-gateway/src/env.ts services/ai-gateway/src/index.ts services/ai-gateway/test/admin-auth.test.ts
git commit -m "feat: add ai gateway admin auth middleware"
```

### Task 4: Add gateway admin JSON endpoints with fixture-backed read models

**Files:**
- Create: `services/ai-gateway/src/admin/read-models.ts`
- Create: `services/ai-gateway/src/admin/api.ts`
- Modify: `services/ai-gateway/src/index.ts`
- Test: `services/ai-gateway/test/admin-api.test.ts`

**Step 1: Write the failing admin API tests**

Cover:

- `GET /api/admin/credentials`
- `GET /api/admin/sessions`
- `GET /api/admin/usage`
- `GET /api/admin/alerts`
- `GET /api/admin/audit`

Expected payloads should include enough fields for the approved UI.

**Step 2: Run the focused test to verify it fails**

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-api.test.ts
```

Expected: FAIL because the routes do not exist.

**Step 3: Implement minimal read-model adapters**

- start with static/in-memory records
- keep route contracts stable
- add credential-to-alert linkage and usage filters (`credential`, `user`, `org`)

**Step 4: Re-run the focused test**

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/admin/read-models.ts services/ai-gateway/src/admin/api.ts services/ai-gateway/src/index.ts services/ai-gateway/test/admin-api.test.ts
git commit -m "feat: add ai gateway admin read endpoints"
```

### Task 5: Add server-served admin UI pages

**Files:**
- Create: `services/ai-gateway/src/admin/ui.ts`
- Create: `services/ai-gateway/src/admin/ui-assets.ts`
- Modify: `services/ai-gateway/src/index.ts`
- Test: `services/ai-gateway/test/admin-ui.test.ts`

**Step 1: Write the failing UI route tests**

Cover:

- `/admin` serves HTML
- all approved page routes serve HTML
- signed-in layout contains nav items for all six pages

**Step 2: Run the focused test to verify it fails**

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-ui.test.ts
```

Expected: FAIL because no admin UI exists.

**Step 3: Implement the admin shell**

- left navigation for `Credentials`, `Sessions`, `Usage`, `Alerts`, `Users`, `Audit`
- top action area
- right detail panel behavior where required
- fetch JSON APIs from Task 4
- `Users` page includes create-user action in the top-right and right-side edit panel

**Step 4: Re-run the focused test**

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/admin/ui.ts services/ai-gateway/src/admin/ui-assets.ts services/ai-gateway/src/index.ts services/ai-gateway/test/admin-ui.test.ts
git commit -m "feat: add ai gateway admin web ui"
```

### Task 6: Wire user management actions through Den

**Files:**
- Modify: `services/ai-gateway/src/admin/api.ts`
- Modify: `services/ai-gateway/src/admin/den-client.ts`
- Test: `services/ai-gateway/test/admin-users-proxy.test.ts`

**Step 1: Write the failing proxy-action tests**

Cover:

- `GET /api/admin/users` proxies Den users
- `PATCH /api/admin/users/:id` proxies edit/disable/admin changes

**Step 2: Run the focused test to verify it fails**

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-users-proxy.test.ts
```

Expected: FAIL because proxy actions are not wired.

**Step 3: Implement the minimal proxy layer**

- pass through bearer token
- map Den payloads into UI payloads

**Step 4: Re-run the focused test**

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/admin/api.ts services/ai-gateway/src/admin/den-client.ts services/ai-gateway/test/admin-users-proxy.test.ts
git commit -m "feat: wire admin user actions through den"
```

### Task 7: Verify, deploy, and test live on Render

**Files:**
- Modify as needed: `.github/workflows/deploy-ai-gateway.yml`

**Step 1: Run the service-level verification**

```bash
pnpm --filter @neatech/ai-gateway test
pnpm --filter @neatech/ai-gateway build
pnpm --filter @neatech/den test
```

Expected: all pass.

**Step 2: Push the branch**

```bash
git push origin codex/ai-gateway-control-plane
```

**Step 3: Wait for Render deployment**

Use the existing AI gateway deploy workflow and confirm the Render URL is live.

**Step 4: Run Playwright MCP against the live site**

Verify:

- `/admin` auth gate
- successful sign-in or token bootstrap
- each page renders
- admin-only protection works
- `Users` page edit panel opens and action controls are visible

**Step 5: Commit any final deploy/test adjustments**

```bash
git add ...
git commit -m "test: verify ai gateway admin control plane live"
```
