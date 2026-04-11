# DEN-Owned Managed AI Routing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make DEN the single hosted service that owns admin-managed provider setup, per-user provider assignment, and prompt routing for OpenAI and Anthropic, while keeping the desktop/OpenCode contract stable in phase 1.

**Architecture:** Reuse the proven runtime logic from `services/ai-gateway`, but move hosted ownership into DEN. In phase 1, local `veslo-server` keeps exposing the existing `/ai-gateway/*` compatibility routes, but those routes forward to DEN-owned managed-AI endpoints on the hosted service. DEN serves the admin UI, owns OpenAI OAuth and Anthropic credential storage, enforces per-user provider/model policy, and executes upstream provider calls.

**Tech Stack:** TypeScript, Express, Drizzle ORM/MySQL, Better Auth, SolidJS admin bundle, Bun test, Node test, Tauri 2, WebdriverIO

---

### Task 1: Add DEN Managed-AI Runtime Configuration

**Files:**
- Create: `services/den/src/managed-ai/env.ts`
- Create: `services/den/src/managed-ai/db.ts`
- Modify: `services/den/src/env.ts`
- Modify: `services/den/src/index.ts`
- Test: `services/den/test/managed-ai-env.test.ts`

**Step 1: Write the failing test**

Add tests that expect DEN to parse a dedicated managed-AI runtime config:

```ts
test("managed ai env parses explicit database, secret key, and OpenAI OAuth config", () => {
  const parsed = parseEnv({
    DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_den",
    BETTER_AUTH_SECRET: "12345678901234567890123456789012",
    BETTER_AUTH_URL: "https://den.example.test",
    MANAGED_AI_DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_ai_gateway",
    MANAGED_AI_SECRET_KEY: "abcdefghijklmnopqrstuvwxyz123456",
    MANAGED_AI_OPENAI_CLIENT_ID: "openai-client",
    MANAGED_AI_OPENAI_CLIENT_SECRET: "openai-secret",
    MANAGED_AI_OPENAI_REDIRECT_BASE: "https://den.example.test/admin/oauth/openai/callback",
  });

  assert.equal(parsed.managedAi.databaseUrl, "mysql://root:root@127.0.0.1:3306/veslo_ai_gateway");
  assert.equal(parsed.managedAi.enabled, true);
});
```

Also add a negative case for missing managed-AI config when hosted managed routing is enabled.

**Step 2: Run test to verify it fails**

Run: `cd services/den && timeout 30s pnpm exec tsx --test test/managed-ai-env.test.ts`

Expected: FAIL because DEN has no managed-AI env parsing yet.

**Step 3: Write minimal implementation**

- add a `managedAi` block to `services/den/src/env.ts`
- keep it separate from Better Auth config
- include:
  - `enabled`
  - `databaseUrl`
  - `secretKey`
  - `openAi.clientId`
  - `openAi.clientSecret`
  - `openAi.redirectBase`
- add `services/den/src/managed-ai/db.ts` to create a dedicated DB handle for the existing managed-AI tables
- mount a placeholder health/boot log in `services/den/src/index.ts` only after env parsing succeeds

Recommended shape:

```ts
managedAi: {
  enabled: boolean;
  databaseUrl: string | null;
  secretKey: string | null;
  openAi: {
    clientId: string | null;
    clientSecret: string | null;
    redirectBase: string | null;
  };
}
```

**Step 4: Run test to verify it passes**

Run: `cd services/den && timeout 30s pnpm exec tsx --test test/managed-ai-env.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add services/den/src/managed-ai/env.ts services/den/src/managed-ai/db.ts services/den/src/env.ts services/den/src/index.ts services/den/test/managed-ai-env.test.ts
git commit -m "feat(den): add managed ai runtime config"
```

### Task 2: Port The Managed-AI Core Runtime Into DEN-Owned Modules

**Files:**
- Create: `services/den/src/managed-ai/access/repository.ts`
- Create: `services/den/src/managed-ai/access/mysql-repository.ts`
- Create: `services/den/src/managed-ai/credentials/repository.ts`
- Create: `services/den/src/managed-ai/credentials/mysql-repository.ts`
- Create: `services/den/src/managed-ai/credentials/secret-store.ts`
- Create: `services/den/src/managed-ai/credentials/mysql-secret-store.ts`
- Create: `services/den/src/managed-ai/credentials/default-token-broker.ts`
- Create: `services/den/src/managed-ai/credentials/openai-oauth.ts`
- Create: `services/den/src/managed-ai/leases/repository.ts`
- Create: `services/den/src/managed-ai/leases/mysql-repository.ts`
- Create: `services/den/src/managed-ai/leases/lease-broker.ts`
- Create: `services/den/src/managed-ai/providers/transport.ts`
- Create: `services/den/src/managed-ai/providers/openai-transport.ts`
- Create: `services/den/src/managed-ai/providers/anthropic-transport.ts`
- Create: `services/den/src/managed-ai/usage/repository.ts`
- Create: `services/den/src/managed-ai/usage/mysql-repository.ts`
- Create: `services/den/src/managed-ai/audit/repository.ts`
- Create: `services/den/src/managed-ai/audit/mysql-repository.ts`
- Create: `services/den/src/managed-ai/runtime/default-runtime.ts`
- Test: `services/den/test/managed-ai-token-broker.test.ts`
- Test: `services/den/test/managed-ai-lease-broker.test.ts`

**Step 1: Write the failing tests**

Port the minimal core tests from the current gateway runtime:

- token broker returns Anthropic API-key auth
- token broker refreshes expired OpenAI OAuth
- lease broker creates sticky provider-scoped leases
- permanent credential failure triggers rebind

Use the existing gateway tests as direct references:

- `services/ai-gateway/test/token-broker.test.ts`
- `services/ai-gateway/test/lease-broker.test.ts`

**Step 2: Run test to verify it fails**

Run: `cd services/den && timeout 30s pnpm exec tsx --test test/managed-ai-token-broker.test.ts test/managed-ai-lease-broker.test.ts`

Expected: FAIL because DEN has no managed-AI runtime modules yet.

**Step 3: Write minimal implementation**

- create a DEN-owned module tree under `services/den/src/managed-ai/`
- copy/adapt the working runtime logic from `services/ai-gateway/src/`
- keep table shapes and secret formats compatible with the existing AI-gateway data model
- do not rewrite the algorithms; prefer direct adaptation with renamed imports
- wire the runtime through `services/den/src/managed-ai/runtime/default-runtime.ts`

Core rule:

```ts
// Product model is DEN-owned, but phase 1 behavior should stay runtime-compatible
// with the current ai-gateway provider policy, credential, lease, and usage flow.
```

**Step 4: Run test to verify it passes**

Run: `cd services/den && timeout 30s pnpm exec tsx --test test/managed-ai-token-broker.test.ts test/managed-ai-lease-broker.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add services/den/src/managed-ai services/den/test/managed-ai-token-broker.test.ts services/den/test/managed-ai-lease-broker.test.ts
git commit -m "feat(den): add managed ai core runtime"
```

### Task 3: Add DEN User-Facing Managed-AI Endpoints

**Files:**
- Create: `services/den/src/managed-ai/auth/user-session.ts`
- Create: `services/den/src/managed-ai/auth/gateway-session.ts`
- Create: `services/den/src/managed-ai/http/user-credentials.ts`
- Create: `services/den/src/managed-ai/http/proxy.ts`
- Create: `services/den/src/managed-ai/http/providers/access-policy.ts`
- Create: `services/den/src/managed-ai/http/providers/openai.ts`
- Create: `services/den/src/managed-ai/http/providers/anthropic.ts`
- Modify: `services/den/src/index.ts`
- Test: `services/den/test/managed-ai-user-access.test.ts`
- Test: `services/den/test/managed-ai-proxy-auth.test.ts`
- Test: `services/den/test/managed-ai-proxy-access-policy.test.ts`
- Test: `services/den/test/managed-ai-proxy-usage.test.ts`

**Step 1: Write the failing tests**

Add DEN-hosted tests that expect:

- `GET /api/me/ai-access` returns the authenticated user’s managed policy
- `POST /providers/openai/v1/chat/completions` requires a bearer token and `x-veslo-session-id`
- `POST /providers/anthropic/v1/messages` enforces assigned provider/model rules
- successful routed requests record usage against the real user

Use these current gateway tests as references:

- `services/ai-gateway/test/user-credentials.test.ts`
- `services/ai-gateway/test/proxy-auth.test.ts`
- `services/ai-gateway/test/proxy-access-policy.test.ts`
- `services/ai-gateway/test/proxy-usage.test.ts`

**Step 2: Run test to verify it fails**

Run: `cd services/den && timeout 30s pnpm exec tsx --test test/managed-ai-user-access.test.ts test/managed-ai-proxy-auth.test.ts test/managed-ai-proxy-access-policy.test.ts test/managed-ai-proxy-usage.test.ts`

Expected: FAIL because DEN does not expose those managed-AI routes yet.

**Step 3: Write minimal implementation**

- mount DEN-hosted managed-AI endpoints in `services/den/src/index.ts`
- keep the hosted route contract compatible with the current gateway contract:
  - `GET /api/me/ai-access`
  - `POST /providers/openai/v1/chat/completions`
  - `POST /providers/anthropic/v1/messages`
- authenticate all prompt calls with the DEN bearer token
- enforce AI-access policy before upstream transport
- reuse the DEN-owned runtime from Task 2

Recommended mount:

```ts
app.use("/api", createManagedAiUserRouter(runtime));
app.use("/providers", createManagedAiProxyRouter(runtime));
```

**Step 4: Run test to verify it passes**

Run: `cd services/den && timeout 30s pnpm exec tsx --test test/managed-ai-user-access.test.ts test/managed-ai-proxy-auth.test.ts test/managed-ai-proxy-access-policy.test.ts test/managed-ai-proxy-usage.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add services/den/src/managed-ai/auth services/den/src/managed-ai/http services/den/src/index.ts services/den/test/managed-ai-user-access.test.ts services/den/test/managed-ai-proxy-auth.test.ts services/den/test/managed-ai-proxy-access-policy.test.ts services/den/test/managed-ai-proxy-usage.test.ts
git commit -m "feat(den): add managed ai user routes"
```

### Task 4: Add DEN Admin APIs For User Assignment, Credentials, Sessions, Usage, Alerts, And Audit

**Files:**
- Create: `services/den/src/managed-ai/http/admin.ts`
- Modify: `services/den/src/http/admin-runtime.ts`
- Modify: `services/den/src/http/admin.ts`
- Modify: `services/den/src/index.ts`
- Test: `services/den/test/admin-managed-ai-user-access.test.ts`
- Test: `services/den/test/admin-managed-ai-credentials.test.ts`
- Test: `services/den/test/admin-managed-ai-read-models.test.ts`
- Test: `services/den/test/admin-managed-ai-actions.test.ts`

**Step 1: Write the failing tests**

Add tests that expect DEN admin APIs to expose:

- per-user AI access read/update
- credential list/create/revoke/drain/rotate
- sessions read model
- usage aggregate
- alerts read/update
- audit read

Start by porting the existing gateway coverage:

- `services/ai-gateway/test/admin-user-access.test.ts`
- `services/ai-gateway/test/admin-credentials-create.test.ts`
- `services/ai-gateway/test/admin-read-models.test.ts`
- `services/ai-gateway/test/admin-actions.test.ts`

**Step 2: Run test to verify it fails**

Run: `cd services/den && timeout 30s pnpm exec tsx --test test/admin-managed-ai-user-access.test.ts test/admin-managed-ai-credentials.test.ts test/admin-managed-ai-read-models.test.ts test/admin-managed-ai-actions.test.ts`

Expected: FAIL because DEN admin does not own the managed-AI read/write model yet.

**Step 3: Write minimal implementation**

- build a DEN-owned admin service for managed AI
- use the existing DEN session/admin checks for platform-admin auth
- expose the managed-AI admin API contract under `/admin/api/*`
- keep the user-directory part sourced from DEN proper
- keep the managed-AI part sourced from the DEN-owned managed-AI runtime

Critical rule:

```ts
// DEN owns both user identity and managed AI policy.
// Admin APIs must not round-trip through an external ai-gateway service.
```

**Step 4: Run test to verify it passes**

Run: `cd services/den && timeout 30s pnpm exec tsx --test test/admin-managed-ai-user-access.test.ts test/admin-managed-ai-credentials.test.ts test/admin-managed-ai-read-models.test.ts test/admin-managed-ai-actions.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add services/den/src/managed-ai/http/admin.ts services/den/src/http/admin-runtime.ts services/den/src/http/admin.ts services/den/src/index.ts services/den/test/admin-managed-ai-user-access.test.ts services/den/test/admin-managed-ai-credentials.test.ts services/den/test/admin-managed-ai-read-models.test.ts services/den/test/admin-managed-ai-actions.test.ts
git commit -m "feat(den): add managed ai admin api"
```

### Task 5: Add The Hosted Admin UI, Including Real OpenAI OAuth And Anthropic Credential Setup

**Files:**
- Create: `services/den/public-admin/index.html`
- Create: `services/den/public-admin/app.js`
- Create: `services/den/public-admin/app.css`
- Modify: `services/den/src/index.ts`
- Modify: `services/den/src/managed-ai/http/admin.ts`
- Modify: `services/den/src/managed-ai/credentials/openai-oauth.ts`
- Test: `services/den/test/admin-managed-ai-ui.test.ts`
- Test: `services/den/test/admin-managed-ai-openai-oauth.test.ts`

**Step 1: Write the failing tests**

Add UI and API tests that expect:

- `GET /admin/users` includes user AI access controls for `openai` and `anthropic`
- the credentials page includes:
  - OpenAI connect/reconnect UI
  - Anthropic shared-key create form
- OpenAI OAuth start/exchange routes exist and persist the platform credential
- admin session failures do not wipe the session on transient 5xx

Use these files as direct references:

- `services/ai-gateway/test/admin-ui.test.ts`
- `services/ai-gateway/src/credentials/openai-oauth.ts`

**Step 2: Run test to verify it fails**

Run: `cd services/den && timeout 30s pnpm exec tsx --test test/admin-managed-ai-ui.test.ts test/admin-managed-ai-openai-oauth.test.ts`

Expected: FAIL because DEN does not yet serve the managed admin UI or OpenAI OAuth flow.

**Step 3: Write minimal implementation**

- copy the working admin UI structure from `services/ai-gateway/public-admin/`
- adapt it so DEN serves `/admin` directly
- add OpenAI connect/reconnect controls instead of a plain “paste secret” flow
- keep Anthropic as shared API-key entry
- store OpenAI OAuth results as platform credentials in the DEN-owned managed-AI runtime

Recommended route contract:

```ts
POST /admin/api/credentials/openai/oauth/start
POST /admin/api/credentials/openai/oauth/exchange
POST /admin/api/credentials
PATCH /admin/api/users/:userId/ai-access
```

**Step 4: Run test to verify it passes**

Run: `cd services/den && timeout 30s pnpm exec tsx --test test/admin-managed-ai-ui.test.ts test/admin-managed-ai-openai-oauth.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add services/den/public-admin services/den/src/index.ts services/den/src/managed-ai/http/admin.ts services/den/src/managed-ai/credentials/openai-oauth.ts services/den/test/admin-managed-ai-ui.test.ts services/den/test/admin-managed-ai-openai-oauth.test.ts
git commit -m "feat(den): add managed ai admin ui and openai oauth"
```

### Task 6: Repoint Local Veslo Server Compatibility Routes To Hosted DEN

**Files:**
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/server.ai-gateway.test.ts`
- Modify: `packages/server/src/types.ts`
- Modify: `packages/desktop/src-tauri/src/veslo_server/spawn.rs`
- Modify: `packages/orchestrator/src/cli.ts`

**Step 1: Write the failing tests**

Update `packages/server/src/server.ai-gateway.test.ts` so it expects:

- local compatibility routes still exist
- they forward to the hosted DEN-managed base URL
- they forward DEN bearer auth for `/ai-gateway/me/ai-access`
- they forward the managed access token plus session id for provider prompt routes

Also add a test that prefers a new env like `VESLO_MANAGED_AI_BASE_URL` while still allowing fallback to `VESLO_AI_GATEWAY_BASE_URL` during migration.

**Step 2: Run test to verify it fails**

Run: `cd packages/server && timeout 30s pnpm exec bun test src/server.ai-gateway.test.ts`

Expected: FAIL because the local server still thinks in terms of a standalone AI gateway target and desktop/orchestrator do not set a managed DEN base URL.

**Step 3: Write minimal implementation**

- change `packages/server/src/server.ts` to resolve the hosted managed-AI base URL for the DEN-owned service
- preserve the existing local route names for phase 1
- update desktop `spawn.rs` to inject the managed hosted base URL by default
- update orchestrator startup to pass the same base URL when spawning `veslo-server`

Recommended env resolution:

```ts
const override =
  process.env.VESLO_MANAGED_AI_BASE_URL?.trim() ||
  process.env.VESLO_AI_GATEWAY_BASE_URL?.trim();
```

**Step 4: Run test to verify it passes**

Run: `cd packages/server && timeout 30s pnpm exec bun test src/server.ai-gateway.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add packages/server/src/server.ts packages/server/src/server.ai-gateway.test.ts packages/server/src/types.ts packages/desktop/src-tauri/src/veslo_server/spawn.rs packages/orchestrator/src/cli.ts
git commit -m "feat(server): forward managed ai routes to hosted den"
```

### Task 7: Verify The Real Desktop Flow End To End

**Files:**
- Modify if needed: `packages/e2e/specs/admin-managed-ai-access.spec.ts`
- Create if needed: `packages/e2e/specs/den-managed-openai-anthropic.spec.ts`
- Modify if needed: `packages/e2e/helpers/live-admin-check.ts`
- Modify if needed: `packages/e2e/scripts/check-live-admin-user.ts`
- Create: `docs/plans/assets/2026-04-10-den-managed-ai-admin-ui.png`
- Create: `docs/plans/assets/2026-04-10-den-managed-ai-openai-connected.png`
- Create: `docs/plans/assets/2026-04-10-den-managed-ai-anthropic-working.png`

**Step 1: Write the failing test**

Add or adapt an E2E spec that proves:

- admin can sign in to hosted DEN admin UI
- OpenAI platform OAuth can be connected
- Anthropic shared key can be stored
- a test user can be assigned `openai`
- a test user can be assigned `anthropic`
- the Veslo desktop app sends managed prompts through hosted DEN and receives responses

**Step 2: Run test to verify it fails**

Run:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle -- --features e2e
cd ../e2e
pnpm test --spec ./specs/den-managed-openai-anthropic.spec.ts
```

Expected: FAIL until hosted DEN and the local compatibility layer are both wired correctly.

**Step 3: Write minimal implementation**

- fill any remaining gaps found by the spec
- keep the fix surface as small as possible
- capture screenshots for the working admin UI and the working desktop status

**Step 4: Run test to verify it passes**

Run:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle -- --features e2e
cd ../e2e
pnpm test --spec ./specs/den-managed-openai-anthropic.spec.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add packages/e2e/specs packages/e2e/helpers packages/e2e/scripts docs/plans/assets
git commit -m "test(e2e): verify den-owned managed ai routing"
```

### Task 8: Remove Hosted Flow Dependence On The Standalone AI Gateway And Update Docs

**Files:**
- Modify: `services/ai-gateway/README.md` if present, or add a deprecation note in service docs
- Modify: `ARCHITECTURE.md`
- Modify: `INFRASTRUCTURE.md`
- Modify: `AGENTS.md` if product/runtime instructions mention `ai-gateway` as the hosted managed-AI owner
- Modify: `docs/admin-managed-ai-access.md` if present

**Step 1: Write the failing test**

Use a lightweight grep/script gate that fails if core docs still describe `services/ai-gateway` as the primary hosted runtime for managed AI.

Example:

```bash
rg -n "ai-gateway.*single source of truth|ai-gateway.*hosted runtime" ARCHITECTURE.md INFRASTRUCTURE.md AGENTS.md docs
```

**Step 2: Run check to verify it fails**

Run: `cd /home/michal/my_projects/veslo/.worktrees/codex/ai-gateway-auth-migration && rg -n "ai-gateway.*single source of truth|ai-gateway.*hosted runtime" ARCHITECTURE.md INFRASTRUCTURE.md AGENTS.md docs`

Expected: matches current stale wording.

**Step 3: Write minimal implementation**

- update docs so DEN/admin is described as the hosted managed-AI owner
- keep any remaining `ai-gateway` mentions explicitly transitional or internal-only

**Step 4: Run check to verify it passes**

Run: `cd /home/michal/my_projects/veslo/.worktrees/codex/ai-gateway-auth-migration && rg -n "ai-gateway.*single source of truth|ai-gateway.*hosted runtime" ARCHITECTURE.md INFRASTRUCTURE.md AGENTS.md docs`

Expected: no stale matches

**Step 5: Commit**

```bash
git add ARCHITECTURE.md INFRASTRUCTURE.md AGENTS.md docs
git commit -m "docs: describe den-owned managed ai routing"
```

### Final Verification

Run:

```bash
cd services/den && pnpm exec tsx --test test/managed-ai-env.test.ts test/managed-ai-token-broker.test.ts test/managed-ai-lease-broker.test.ts test/managed-ai-user-access.test.ts test/managed-ai-proxy-auth.test.ts test/managed-ai-proxy-access-policy.test.ts test/managed-ai-proxy-usage.test.ts test/admin-managed-ai-user-access.test.ts test/admin-managed-ai-credentials.test.ts test/admin-managed-ai-read-models.test.ts test/admin-managed-ai-actions.test.ts test/admin-managed-ai-ui.test.ts test/admin-managed-ai-openai-oauth.test.ts
cd /home/michal/my_projects/veslo/.worktrees/codex/ai-gateway-auth-migration/packages/server && pnpm exec bun test src/server.ai-gateway.test.ts
cd /home/michal/my_projects/veslo/.worktrees/codex/ai-gateway-auth-migration/packages/app && pnpm typecheck && node --test --import=tsx/esm src/app/lib/ai-access.test.ts
cd /home/michal/my_projects/veslo/.worktrees/codex/ai-gateway-auth-migration/packages/desktop && pnpm tauri build --debug --no-bundle -- --features e2e
cd /home/michal/my_projects/veslo/.worktrees/codex/ai-gateway-auth-migration/packages/e2e && pnpm test --spec ./specs/den-managed-openai-anthropic.spec.ts
```

Expected:

- all DEN managed-AI tests pass
- `packages/server` compatibility proxy test passes
- app typecheck and managed-AI config tests pass
- desktop E2E binary builds
- the DEN-managed OpenAI/Anthropic E2E spec passes
