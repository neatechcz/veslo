# Admin-Managed AI Access Follow-Up Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the last legacy user BYOK gateway routes, add admin-only platform credential creation, and verify the real Veslo desktop flow end to end.

**Architecture:** Keep `services/ai-gateway` as the single source of truth for user AI access policy and platform credential routing. The user-authenticated gateway surface is reduced to `GET /api/me/ai-access`, while admin-authenticated routes gain direct API-key creation for platform-owned provider pools keyed as `platform:openai` and `platform:anthropic`.

**Tech Stack:** TypeScript, Express, Drizzle ORM/MySQL, SolidJS, Bun test, Node test, Tauri 2, WebdriverIO, Docker

---

### Task 1: Remove Legacy User BYOK Gateway Routes

**Files:**
- Modify: `services/ai-gateway/src/http/user-credentials.ts`
- Modify: `services/ai-gateway/src/index.ts`
- Modify: `services/ai-gateway/src/runtime/default-runtime.ts`
- Modify or Replace: `services/ai-gateway/test/user-credentials.test.ts`

**Step 1: Write the failing test**

Add focused tests that expect:

- `GET /api/me/ai-access` still returns the signed-in user policy
- the removed BYOK paths now return `404`

**Step 2: Run test to verify it fails**

Run: `cd services/ai-gateway && timeout 30s node --import tsx/esm --test test/user-credentials.test.ts`

Expected: FAIL because the old routes still exist.

**Step 3: Write minimal implementation**

- remove the user BYOK route handlers
- keep only the authenticated `/api/me/ai-access` route in that router, or split it into a narrower router if cleaner
- remove any now-unused runtime wiring for OpenAI OAuth and user credential mutation support

**Step 4: Run test to verify it passes**

Run: `cd services/ai-gateway && timeout 30s node --import tsx/esm --test test/user-credentials.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add services/ai-gateway/src/http/user-credentials.ts services/ai-gateway/src/index.ts services/ai-gateway/src/runtime/default-runtime.ts services/ai-gateway/test/user-credentials.test.ts
git commit -m "refactor(ai-gateway): remove legacy user credential routes"
```

### Task 2: Add Credential Names And Platform Create API To The Repository Layer

**Files:**
- Modify: `services/ai-gateway/src/db/schema.ts`
- Modify: `services/ai-gateway/drizzle/0000_past_randall_flagg.sql`
- Modify: `services/ai-gateway/src/credentials/repository.ts`
- Modify: `services/ai-gateway/src/credentials/mysql-repository.ts`
- Modify: `services/ai-gateway/src/typecheck/repository-contracts.ts`
- Modify: `services/ai-gateway/test/schema.test.ts`

**Step 1: Write the failing test**

Add or update tests to expect:

- `credential_record` has a `name` column
- repository contracts include admin/platform credential creation support

**Step 2: Run test to verify it fails**

Run: `cd services/ai-gateway && timeout 30s node --import tsx/esm --test test/schema.test.ts`

Expected: FAIL because the schema/repository contract does not support named platform credential creation yet.

**Step 3: Write minimal implementation**

- add `name` to `credential_record`
- add a repository input like `createPlatformCredential`
- make MySQL repository create the secret-backed record and binding for `platform:openai` or `platform:anthropic`

**Step 4: Run test to verify it passes**

Run: `cd services/ai-gateway && timeout 30s node --import tsx/esm --test test/schema.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add services/ai-gateway/src/db/schema.ts services/ai-gateway/drizzle/0000_past_randall_flagg.sql services/ai-gateway/src/credentials/repository.ts services/ai-gateway/src/credentials/mysql-repository.ts services/ai-gateway/src/typecheck/repository-contracts.ts services/ai-gateway/test/schema.test.ts
git commit -m "feat(ai-gateway): support named platform credentials"
```

### Task 3: Add Admin Credential Creation Endpoint

**Files:**
- Modify: `services/ai-gateway/src/http/admin.ts`
- Modify: `services/ai-gateway/src/runtime/default-runtime.ts`
- Create or Modify: `services/ai-gateway/test/admin-credentials-create.test.ts`

**Step 1: Write the failing test**

Add tests that expect:

- `POST /admin/api/credentials` creates an OpenAI platform credential
- `POST /admin/api/credentials` creates an Anthropic platform credential
- invalid provider or empty secret returns `400`

**Step 2: Run test to verify it fails**

Run: `cd services/ai-gateway && timeout 30s node --import tsx/esm --test test/admin-credentials-create.test.ts`

Expected: FAIL because the create route does not exist.

**Step 3: Write minimal implementation**

- validate `provider`, `secret`, and optional `name`
- encrypt/store the secret
- create the credential and platform binding
- return the created admin credential record

**Step 4: Run test to verify it passes**

Run: `cd services/ai-gateway && timeout 30s node --import tsx/esm --test test/admin-credentials-create.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add services/ai-gateway/src/http/admin.ts services/ai-gateway/src/runtime/default-runtime.ts services/ai-gateway/test/admin-credentials-create.test.ts
git commit -m "feat(ai-gateway): add admin platform credential creation"
```

### Task 4: Add Admin Credentials UI Create Form

**Files:**
- Modify: `services/ai-gateway/public-admin/index.html`
- Modify: `services/ai-gateway/public-admin/app.js`
- Modify: `services/ai-gateway/public-admin/app.css`
- Modify: `services/ai-gateway/test/admin-ui.test.ts`

**Step 1: Write the failing test**

Add UI tests that expect:

- the Credentials page includes a create form
- the admin bundle submits `POST /admin/api/credentials`
- the page refreshes or updates the credentials list after successful create

**Step 2: Run test to verify it fails**

Run: `cd services/ai-gateway && timeout 30s node --import tsx/esm --test test/admin-ui.test.ts`

Expected: FAIL because the create UI does not exist.

**Step 3: Write minimal implementation**

- add provider/name/secret fields
- wire submit state and error handling
- refresh or prepend the created credential into the list
- do not echo the secret back into the UI after submission

**Step 4: Run test to verify it passes**

Run: `cd services/ai-gateway && timeout 30s node --import tsx/esm --test test/admin-ui.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add services/ai-gateway/public-admin/index.html services/ai-gateway/public-admin/app.js services/ai-gateway/public-admin/app.css services/ai-gateway/test/admin-ui.test.ts
git commit -m "feat(ai-gateway): add platform credential create form"
```

### Task 5: Prove Platform-Created Credentials Route Correctly

**Files:**
- Modify: `services/ai-gateway/test/proxy-access-policy.test.ts`
- Modify: `services/ai-gateway/test/proxy-usage.test.ts`
- Modify or Create: `services/ai-gateway/test/runtime-persistence.test.ts`

**Step 1: Write the failing test**

Add tests that expect:

- a credential created for `platform:openai` is eligible for an OpenAI-routed user session
- a credential created for `platform:anthropic` is eligible for an Anthropic-routed user session
- usage attribution still stays on the real user, not the platform owner

**Step 2: Run test to verify it fails**

Run: `cd services/ai-gateway && timeout 30s node --import tsx/esm --test test/proxy-access-policy.test.ts test/proxy-usage.test.ts test/runtime-persistence.test.ts`

Expected: FAIL until the create path and runtime expectations are aligned.

**Step 3: Write minimal implementation**

- adjust runtime persistence helpers or tests as needed
- make sure platform-created bindings flow through the existing platform owner selector cleanly

**Step 4: Run test to verify it passes**

Run: `cd services/ai-gateway && timeout 30s node --import tsx/esm --test test/proxy-access-policy.test.ts test/proxy-usage.test.ts test/runtime-persistence.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add services/ai-gateway/test/proxy-access-policy.test.ts services/ai-gateway/test/proxy-usage.test.ts services/ai-gateway/test/runtime-persistence.test.ts
git commit -m "test(ai-gateway): verify platform credential routing"
```

### Task 6: Update Developer Documentation

**Files:**
- Modify: `docs/admin-managed-ai-access.md`
- Modify: `docs/plans/2026-04-08-admin-managed-ai-access-follow-up-design.md`
- Modify: `docs/plans/2026-04-08-admin-managed-ai-access-follow-up-implementation-plan.md`

**Step 1: Write the failing doc checklist**

Create a short checklist covering:

- removed user BYOK routes
- admin credential create endpoint and UI
- required platform owner IDs
- deployment/manual setup notes

**Step 2: Review docs and identify missing items**

Run: `cd /home/michal/my_projects/veslo/.worktrees/codex/ai-gateway-auth-migration && rg -n "platform:openai|platform:anthropic|POST /admin/api/credentials|/api/providers/openai/oauth/start" docs services/ai-gateway`

Expected: find stale references or missing documentation details.

**Step 3: Write minimal documentation updates**

- describe the new admin create flow
- note that the old user BYOK endpoints are removed
- keep manual setup instructions explicit

**Step 4: Re-run the doc grep**

Run: `cd /home/michal/my_projects/veslo/.worktrees/codex/ai-gateway-auth-migration && rg -n "platform:openai|platform:anthropic|POST /admin/api/credentials|/api/providers/openai/oauth/start" docs services/ai-gateway`

Expected: only intentional references remain.

**Step 5: Commit**

```bash
git add docs/admin-managed-ai-access.md docs/plans/2026-04-08-admin-managed-ai-access-follow-up-design.md docs/plans/2026-04-08-admin-managed-ai-access-follow-up-implementation-plan.md
git commit -m "docs: document platform credential follow-up flow"
```

### Task 7: Run The AGENTS-Required Desktop End-To-End Gate

**Files:**
- No required source edits unless the E2E run exposes a bug

**Step 1: Start Docker dev stack**

Run: `cd /home/michal/my_projects/veslo/.worktrees/codex/ai-gateway-auth-migration && packaging/docker/dev-up.sh`

Expected: Docker services start successfully.

**Step 2: Build the desktop app with the WebDriver feature**

Run: `cd /home/michal/my_projects/veslo/.worktrees/codex/ai-gateway-auth-migration/packages/desktop && pnpm tauri build --debug --no-bundle -- --features e2e`

Expected: successful debug build.

**Step 3: Run the relevant UI test**

Run: `cd /home/michal/my_projects/veslo/.worktrees/codex/ai-gateway-auth-migration/packages/e2e && pnpm test --spec ./specs/<target>.spec.ts`

Expected: PASS against the desktop runtime.

**Step 4: If a failure occurs, debug and patch the minimal fix**

- inspect the failing spec/logs
- patch the specific regression
- rerun the exact failing command

**Step 5: Record evidence**

- note which exact commands passed
- if possible, capture screenshots or video per AGENTS expectations

**Step 6: Commit**

```bash
git add -A
git commit -m "test: verify admin managed ai flow in desktop runtime"
```
