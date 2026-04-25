# AI Gateway Backend Completion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Finish the Veslo AI gateway backend so live traffic uses authenticated, persistent, server-side credentials and the admin control plane reflects real runtime state.

**Architecture:** Implement the work in backend-first slices. First harden the live proxy path with authenticated gateway access, persistent credential/lease state, and refresh-capable OpenAI OAuth. Then attach runtime usage/audit/alert recording. Finally wire admin actions and close UI placeholders against those backend primitives.

**Tech Stack:** TypeScript, Express, Drizzle ORM, MySQL, Node test runner via `tsx --test`, Bun tests for `packages/server`

---

### Task 1: Add authenticated gateway principal resolution for provider proxy routes

**Files:**
- Create: `services/ai-gateway/src/auth/gateway-session.ts`
- Modify: `services/ai-gateway/src/http/proxy.ts`
- Modify: `services/ai-gateway/src/http/providers/openai.ts`
- Modify: `services/ai-gateway/src/http/providers/anthropic.ts`
- Test: `services/ai-gateway/test/proxy-auth.test.ts`

**Step 1: Write the failing test**

Cover:

- provider proxy rejects requests without gateway bearer auth
- provider proxy resolves a gateway principal instead of trusting `x-veslo-owner-user-id`
- the resolved user id becomes the lease owner id

**Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/proxy-auth.test.ts
```

Expected: FAIL because proxy routes do not authenticate gateway bearer tokens yet.

**Step 3: Implement the minimal runtime auth layer**

- add a small gateway-session resolver interface
- require bearer auth in provider routes
- stop using caller-supplied `x-veslo-owner-user-id` for lease ownership
- thread the resolved owner user id into the lease scope

**Step 4: Re-run the focused test**

Run the same command and expect PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/auth/gateway-session.ts services/ai-gateway/src/http/proxy.ts services/ai-gateway/src/http/providers/openai.ts services/ai-gateway/src/http/providers/anthropic.ts services/ai-gateway/test/proxy-auth.test.ts
git commit -m "feat: authenticate ai gateway provider proxy sessions"
```

### Task 2: Replace in-memory live credential and lease runtime with persistent repositories

**Files:**
- Create: `services/ai-gateway/src/credentials/mysql-repository.ts`
- Modify: `services/ai-gateway/src/index.ts`
- Modify: `services/ai-gateway/src/credentials/repository.ts`
- Modify: `services/ai-gateway/src/leases/mysql-repository.ts`
- Test: `services/ai-gateway/test/runtime-persistence.test.ts`

**Step 1: Write the failing test**

Cover:

- runtime app wiring uses persistent credential and lease repos by default
- creating a credential through BYOK APIs yields a persisted binding visible to lease selection
- leases survive app re-instantiation against the same repositories

**Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/runtime-persistence.test.ts
```

Expected: FAIL because `createApp()` still wires in-memory credentials and leases.

**Step 3: Implement the minimal persistent runtime wiring**

- add a MySQL credential repository for record/binding CRUD used by runtime
- update `createApp()` default wiring to use MySQL credential and lease repositories
- remove the seeded dev credential from default runtime startup

**Step 4: Re-run the focused test**

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/credentials/mysql-repository.ts services/ai-gateway/src/index.ts services/ai-gateway/src/credentials/repository.ts services/ai-gateway/src/leases/mysql-repository.ts services/ai-gateway/test/runtime-persistence.test.ts
git commit -m "feat: persist ai gateway runtime credentials and leases"
```

### Task 3: Wire OpenAI OAuth refresh into the live token broker

**Files:**
- Modify: `services/ai-gateway/src/credentials/openai-oauth.ts`
- Modify: `services/ai-gateway/src/credentials/default-token-broker.ts`
- Modify: `services/ai-gateway/src/index.ts`
- Test: `services/ai-gateway/test/token-broker-refresh-live.test.ts`

**Step 1: Write the failing test**

Cover:

- expired OpenAI OAuth credentials refresh successfully in default runtime wiring
- permanent refresh failures mark credentials unhealthy

**Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/token-broker-refresh-live.test.ts
```

Expected: FAIL because default runtime does not provide refresh support.

**Step 3: Implement the minimal refresh path**

- add refresh-token exchange support to the OpenAI OAuth client
- provide a `refreshOpenAiOAuth` dependency from `createApp()` wiring
- preserve existing permanent-credential unhealthy marking

**Step 4: Re-run the focused test**

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/credentials/openai-oauth.ts services/ai-gateway/src/credentials/default-token-broker.ts services/ai-gateway/src/index.ts services/ai-gateway/test/token-broker-refresh-live.test.ts
git commit -m "feat: wire live openai oauth refresh in ai gateway"
```

### Task 4: Implement deterministic credential rotation for initial session assignment

**Files:**
- Modify: `services/ai-gateway/src/leases/binding-selector.ts`
- Test: `services/ai-gateway/test/binding-selector.test.ts`

**Step 1: Write the failing test**

Cover:

- initial binding selection rotates across eligible healthy bindings instead of always picking the first
- replacement selection excludes the failed binding

**Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/binding-selector.test.ts
```

Expected: FAIL because selection is currently first-row only.

**Step 3: Implement the minimal rotation strategy**

- add deterministic round-robin selection over healthy bindings
- keep replacement selection within the same provider/user pool

**Step 4: Re-run the focused test**

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/leases/binding-selector.ts services/ai-gateway/test/binding-selector.test.ts
git commit -m "feat: rotate ai gateway bindings across sessions"
```

### Task 5: Record runtime usage from provider proxy requests

**Files:**
- Modify: `services/ai-gateway/src/http/proxy.ts`
- Modify: `services/ai-gateway/src/http/providers/openai.ts`
- Modify: `services/ai-gateway/src/http/providers/anthropic.ts`
- Modify: `services/ai-gateway/src/usage/mysql-repository.ts`
- Test: `services/ai-gateway/test/proxy-usage.test.ts`

**Step 1: Write the failing test**

Cover:

- successful OpenAI proxy requests record usage events
- successful Anthropic proxy requests record usage events
- usage records contain session id, user id, binding id, credential id, model, and token counts where available

**Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/proxy-usage.test.ts
```

Expected: FAIL because proxy routes do not call `recordUsage`.

**Step 3: Implement the minimal usage recording**

- add usage repository dependency to proxy routes
- derive request id, model, and token counts from provider responses when present
- fix `credential_record_id` vs `credential_binding_id` persistence in the usage repository

**Step 4: Re-run the focused test**

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/http/proxy.ts services/ai-gateway/src/http/providers/openai.ts services/ai-gateway/src/http/providers/anthropic.ts services/ai-gateway/src/usage/mysql-repository.ts services/ai-gateway/test/proxy-usage.test.ts
git commit -m "feat: record ai gateway proxy usage"
```

### Task 6: Replace fixture alerts with repository-backed operational alerts

**Files:**
- Create: `services/ai-gateway/src/alerts/repository.ts`
- Create: `services/ai-gateway/src/alerts/mysql-repository.ts`
- Modify: `services/ai-gateway/src/http/admin.ts`
- Test: `services/ai-gateway/test/admin-alerts.test.ts`

**Step 1: Write the failing test**

Cover:

- `/admin/api/alerts` returns repository-backed alerts instead of hard-coded fixtures
- alerts can represent rate limits, credential auth failures, and unusual error activity

**Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-alerts.test.ts
```

Expected: FAIL because alerts are fixture-backed.

**Step 3: Implement the minimal alert repository path**

- add an alert repository abstraction
- swap admin service to use the repository instead of `DEFAULT_ALERTS`
- keep alert generation simple at first, driven by persisted failure summaries

**Step 4: Re-run the focused test**

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/alerts/repository.ts services/ai-gateway/src/alerts/mysql-repository.ts services/ai-gateway/src/http/admin.ts services/ai-gateway/test/admin-alerts.test.ts
git commit -m "feat: back ai gateway alerts with repository data"
```

### Task 7: Add admin credential and alert action endpoints

**Files:**
- Modify: `services/ai-gateway/src/http/admin.ts`
- Modify: `services/ai-gateway/public-admin/app.js`
- Test: `services/ai-gateway/test/admin-actions.test.ts`

**Step 1: Write the failing test**

Cover:

- credentials can be revoked, drained, and rotated through admin APIs
- alerts can be acknowledged and resolved through admin APIs

**Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-actions.test.ts
```

Expected: FAIL because those action endpoints do not exist.

**Step 3: Implement the minimal action APIs and UI wiring**

- add explicit admin routes for credential actions and alert status changes
- wire the existing admin buttons to those routes
- refresh read models after each action

**Step 4: Re-run the focused test**

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/http/admin.ts services/ai-gateway/public-admin/app.js services/ai-gateway/test/admin-actions.test.ts
git commit -m "feat: wire ai gateway admin actions"
```

### Task 8: Verify gateway integration with the Veslo server proxy

**Files:**
- Modify: `packages/server/src/server.ai-gateway.test.ts`
- Modify: `packages/server/src/server.ts` if needed

**Step 1: Extend the failing integration test**

Cover:

- caller auth routes still proxy BYOK credential mutations correctly
- gateway-token routes still proxy provider traffic correctly
- no provider secrets leak back through the Veslo server

**Step 2: Run the focused test to verify behavior**

Run:

```bash
pnpm --filter veslo-server test packages/server/src/server.ai-gateway.test.ts
```

Expected: PASS after any required fixes.

**Step 3: Implement only necessary server adjustments**

- keep the server as a thin proxy
- preserve header redaction and response redaction behavior

**Step 4: Re-run the focused test**

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/server/src/server.ai-gateway.test.ts packages/server/src/server.ts
git commit -m "test: verify veslo server ai gateway integration"
```

### Task 9: Run final verification for the backend completion slices

**Files:**
- Modify: none unless verification exposes issues

**Step 1: Run the ai-gateway suite**

```bash
pnpm --filter @neatech/ai-gateway test
pnpm --filter @neatech/ai-gateway build
```

Expected: PASS.

**Step 2: Run the Veslo server gateway tests**

```bash
pnpm --filter veslo-server test packages/server/src/server.ai-gateway.test.ts
```

Expected: PASS.

**Step 3: Record any remaining E2E/manual verification gap**

If Docker or live credentials are unavailable, note the exact commands needed to finish the gate.
