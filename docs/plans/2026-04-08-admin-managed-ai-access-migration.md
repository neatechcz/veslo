# Admin-Managed AI Access Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move OpenAI/Anthropic provider and model control out of the Veslo app and into the AI Gateway admin UI, with backend-enforced user access policy keyed to the existing Den user identity.

**Architecture:** Add a user-scoped AI access policy model to `services/ai-gateway`, expose admin/user API surfaces for it, enforce it in the gateway proxy, proxy the effective policy through `packages/server`, and replace user-facing provider/model controls in `packages/app` with read-only admin-managed state. Remove obsolete self-service credential routes and UI so the admin-controlled path is authoritative.

**Tech Stack:** TypeScript, Express, Drizzle ORM/MySQL, SolidJS, Bun test, Node test

---

### Task 1: Add AI Access Policy Schema And Repository

**Files:**
- Modify: `services/ai-gateway/src/db/schema.ts`
- Modify: `services/ai-gateway/drizzle/0000_past_randall_flagg.sql`
- Modify: `services/ai-gateway/test/schema.test.ts`
- Create: `services/ai-gateway/src/access/repository.ts`
- Create: `services/ai-gateway/src/access/mysql-repository.ts`
- Create: `services/ai-gateway/test/access-repository.test.ts`

**Step 1: Write the failing test**

Add repository tests that expect:

- a persisted user access policy can be created or updated
- a policy can be read by `userId`
- invalid provider/default model combinations are rejected by higher-level validation, not by silent repository behavior

**Step 2: Run test to verify it fails**

Run: `cd services/ai-gateway && pnpm test test/access-repository.test.ts`

Expected: FAIL because the repository and schema do not exist yet.

**Step 3: Write minimal implementation**

Implement:

- a new schema/table for user AI access policy
- repository types for the stored policy and update payload
- MySQL repository with `getByUserId` and `upsertByUserId`

**Step 4: Run test to verify it passes**

Run: `cd services/ai-gateway && pnpm test test/access-repository.test.ts test/schema.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add services/ai-gateway/src/db/schema.ts services/ai-gateway/drizzle/0000_past_randall_flagg.sql services/ai-gateway/src/access/repository.ts services/ai-gateway/src/access/mysql-repository.ts services/ai-gateway/test/access-repository.test.ts services/ai-gateway/test/schema.test.ts
git commit -m "feat(ai-gateway): add user ai access policy storage"
```

### Task 2: Expose Admin And User AI Access APIs

**Files:**
- Modify: `services/ai-gateway/src/http/admin.ts`
- Modify: `services/ai-gateway/src/index.ts`
- Modify: `services/ai-gateway/src/runtime/default-runtime.ts`
- Modify: `services/ai-gateway/test/admin-ui.test.ts`
- Create: `services/ai-gateway/test/admin-user-access.test.ts`

**Step 1: Write the failing test**

Add tests that expect:

- `GET /admin/api/users/:userId/ai-access` returns the stored policy
- `PUT /admin/api/users/:userId/ai-access` validates and saves the policy
- `GET /api/me/ai-access` returns the current signed-in user’s policy

**Step 2: Run test to verify it fails**

Run: `cd services/ai-gateway && pnpm test test/admin-user-access.test.ts test/admin-ui.test.ts`

Expected: FAIL because those endpoints do not exist.

**Step 3: Write minimal implementation**

Add:

- service/repository wiring for AI access policy
- admin route handlers
- signed-in user self-read route
- validation for enabled/provider/default-model/allowed-model relationships

**Step 4: Run test to verify it passes**

Run: `cd services/ai-gateway && pnpm test test/admin-user-access.test.ts test/admin-ui.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add services/ai-gateway/src/http/admin.ts services/ai-gateway/src/index.ts services/ai-gateway/src/runtime/default-runtime.ts services/ai-gateway/test/admin-user-access.test.ts services/ai-gateway/test/admin-ui.test.ts
git commit -m "feat(ai-gateway): add admin managed ai access endpoints"
```

### Task 3: Enforce AI Access In Provider Proxy

**Files:**
- Modify: `services/ai-gateway/src/http/proxy.ts`
- Modify: `services/ai-gateway/src/http/providers/openai.ts`
- Modify: `services/ai-gateway/src/http/providers/anthropic.ts`
- Modify: `services/ai-gateway/src/credentials/repository.ts`
- Modify: `services/ai-gateway/src/credentials/mysql-repository.ts`
- Modify: `services/ai-gateway/src/leases/binding-selector.ts`
- Modify: `services/ai-gateway/src/leases/repository.ts`
- Modify: `services/ai-gateway/test/proxy-auth.test.ts`
- Create: `services/ai-gateway/test/proxy-access-policy.test.ts`

**Step 1: Write the failing test**

Add tests that expect:

- requests fail when the user has no assigned AI access
- requests fail when provider does not match assigned provider
- requests fail when model is not allowed
- valid requests use the assigned provider/model path

**Step 2: Run test to verify it fails**

Run: `cd services/ai-gateway && pnpm test test/proxy-access-policy.test.ts test/proxy-auth.test.ts`

Expected: FAIL because the proxy does not consult access policy yet.

**Step 3: Write minimal implementation**

Implement:

- access-policy lookup inside the proxy path
- provider/model validation before upstream dispatch
- any minimal credential/binding ownership adjustment needed to support platform-managed provider pools

**Step 4: Run test to verify it passes**

Run: `cd services/ai-gateway && pnpm test test/proxy-access-policy.test.ts test/proxy-auth.test.ts test/proxy.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add services/ai-gateway/src/http/proxy.ts services/ai-gateway/src/http/providers/openai.ts services/ai-gateway/src/http/providers/anthropic.ts services/ai-gateway/src/credentials/repository.ts services/ai-gateway/src/credentials/mysql-repository.ts services/ai-gateway/src/leases/binding-selector.ts services/ai-gateway/src/leases/repository.ts services/ai-gateway/test/proxy-access-policy.test.ts services/ai-gateway/test/proxy-auth.test.ts
git commit -m "feat(ai-gateway): enforce admin managed provider access"
```

### Task 4: Move Admin Controls Into The Users Screen

**Files:**
- Modify: `services/ai-gateway/public-admin/index.html`
- Modify: `services/ai-gateway/public-admin/app.js`
- Modify: `services/ai-gateway/public-admin/app.css`
- Modify: `services/ai-gateway/test/admin-ui.test.ts`

**Step 1: Write the failing test**

Add UI shell tests that expect:

- the Users page contains AI access editor controls
- the admin bundle references the new AI access endpoints

**Step 2: Run test to verify it fails**

Run: `cd services/ai-gateway && pnpm test test/admin-ui.test.ts`

Expected: FAIL because the current admin UI has no AI access editor.

**Step 3: Write minimal implementation**

Implement:

- AI access form fields in the user editor
- load/save wiring in `app.js`
- clear save status and validation feedback

**Step 4: Run test to verify it passes**

Run: `cd services/ai-gateway && pnpm test test/admin-ui.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add services/ai-gateway/public-admin/index.html services/ai-gateway/public-admin/app.js services/ai-gateway/public-admin/app.css services/ai-gateway/test/admin-ui.test.ts
git commit -m "feat(ai-gateway): add ai access controls to admin users ui"
```

### Task 5: Proxy The Effective AI Access Through Veslo Server

**Files:**
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/server.ai-gateway.test.ts`

**Step 1: Write the failing test**

Add tests that expect:

- `GET /ai-gateway/me/ai-access` proxies caller auth to the gateway
- obsolete end-user credential management routes are absent or reject use

**Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test src/server.ai-gateway.test.ts`

Expected: FAIL because the new route is missing and self-service routes still exist.

**Step 3: Write minimal implementation**

Implement:

- the new proxy route for the app
- removal or disablement of user credential management proxy routes

**Step 4: Run test to verify it passes**

Run: `cd packages/server && bun test src/server.ai-gateway.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add packages/server/src/server.ts packages/server/src/server.ai-gateway.test.ts
git commit -m "feat(server): expose admin managed ai access route"
```

### Task 6: Replace User Provider/Model Controls In The App

**Files:**
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/pages/settings.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/types.ts`
- Modify: `packages/app/src/app/lib/veslo-server.ts`
- Modify: `packages/app/src/app/lib/opencode.ts`
- Modify: `packages/app/src/app/context/workspace.ts`
- Create: `packages/app/src/app/lib/ai-access.ts`
- Create: `packages/app/src/app/lib/ai-access.test.ts`
- Delete or stop using: `packages/app/src/app/components/provider-auth-modal.tsx`
- Delete or stop using: `packages/app/src/app/components/model-picker-modal.tsx`
- Delete or stop using: `packages/app/src/app/lib/provider-auth.ts`

**Step 1: Write the failing test**

Add tests that expect:

- the app can fetch and normalize the signed-in user’s AI access profile
- prompt configuration prefers admin-managed default model
- missing AI access produces a clear blocked state

**Step 2: Run test to verify it fails**

Run: `cd packages/app && pnpm test -- --runInBand src/app/lib/ai-access.test.ts`

Expected: FAIL because the new client/state module does not exist.

**Step 3: Write minimal implementation**

Implement:

- Veslo server client method for `GET /ai-gateway/me/ai-access`
- app state for effective AI access
- read-only UI summary
- removal of provider/model configuration UI and modal entry points
- prompt sending that uses admin-managed default model
- gateway routing sync without treating local config as user authority

**Step 4: Run test to verify it passes**

Run: `cd packages/app && pnpm test -- --runInBand src/app/lib/ai-access.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add packages/app/src/app/app.tsx packages/app/src/app/pages/settings.tsx packages/app/src/app/pages/session.tsx packages/app/src/app/pages/dashboard.tsx packages/app/src/app/types.ts packages/app/src/app/lib/veslo-server.ts packages/app/src/app/lib/opencode.ts packages/app/src/app/context/workspace.ts packages/app/src/app/lib/ai-access.ts packages/app/src/app/lib/ai-access.test.ts
git rm -f packages/app/src/app/components/provider-auth-modal.tsx packages/app/src/app/components/model-picker-modal.tsx packages/app/src/app/lib/provider-auth.ts
git commit -m "feat(app): switch to admin managed ai access"
```

### Task 7: Add Developer Documentation

**Files:**
- Create: `docs/ai-access-admin-managed.md`
- Modify: `AGENTS.md`

**Step 1: Write the failing test**

This task is documentation-only. No automated failing test is required.

**Step 2: Verify current docs are missing the new flow**

Run: `rg -n "admin managed ai access|ai access" docs AGENTS.md`

Expected: no complete developer doc for the new flow.

**Step 3: Write minimal implementation**

Document:

- the new login-to-routing flow
- admin responsibilities vs user app behavior
- setup/migration expectations
- any credential pool ownership assumptions

**Step 4: Verify docs exist**

Run: `rg -n "admin-managed|AI access|assigned provider" docs/ai-access-admin-managed.md AGENTS.md`

Expected: matches found in the new doc.

**Step 5: Commit**

```bash
git add docs/ai-access-admin-managed.md AGENTS.md
git commit -m "docs: describe admin managed ai access flow"
```

### Task 8: Run Focused Verification

**Files:**
- No code changes required

**Step 1: Run gateway tests**

Run: `cd services/ai-gateway && pnpm test test/access-repository.test.ts test/admin-user-access.test.ts test/admin-ui.test.ts test/proxy-access-policy.test.ts test/proxy-auth.test.ts test/proxy.test.ts test/schema.test.ts`

Expected: PASS

**Step 2: Run server tests**

Run: `cd packages/server && bun test src/server.ai-gateway.test.ts`

Expected: PASS

**Step 3: Run app tests**

Run: `cd packages/app && pnpm test -- --runInBand src/app/lib/ai-access.test.ts`

Expected: PASS

**Step 4: Run any additional impacted tests if failures indicate broader regressions**

Run only the minimal adjacent suites needed to confirm green behavior.

**Step 5: Commit verification notes if needed**

No commit required unless verification forces code changes.
