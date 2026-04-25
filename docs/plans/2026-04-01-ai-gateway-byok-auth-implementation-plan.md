# AI Gateway BYOK Auth Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move OpenAI and Anthropic auth to `services/ai-gateway`, keep raw provider secrets gateway-only, and transparently route migrated provider traffic through the gateway while preserving `openai` and `anthropic` in Veslo UX.

**Architecture:** Finish `services/ai-gateway` as the authenticated provider edge: it owns secure secret storage, provider-scoped sticky leases, upstream forwarding, usage/audit persistence, and BYOK credential APIs. Update Veslo server/app to consume gateway-backed auth and status surfaces, then cut OpenCode over to gateway-backed provider routes without letting OpenCode persist raw provider secrets.

**Tech Stack:** TypeScript, Express, Drizzle ORM, MySQL, Node test runner via `tsx --test`, Bun tests for `packages/server`, SolidJS, Tauri desktop, Docker Compose dev stack, Chrome MCP

---

## Prerequisites

- Use `@superpowers:test-driven-development` while executing this plan.
- Stay on the dedicated worktree branch `codex/ai-gateway-auth-migration`.
- Do not run `packages/web`; UI verification must use `packages/desktop`.
- Because `packages/server/src` changes require a rebuilt sidecar, run `pnpm --filter veslo-server build:bin` before any desktop or orchestrator verification.
- Add MySQL to the Docker dev stack before relying on persistent gateway repos.
- This plan is rebased onto local `main` at `8cdf3e8d`, which already includes browser-based Den email verification/password reset flows and a longer orchestrator Docker healthcheck startup budget. Preserve those behaviors when editing shared auth or dev-stack files.

## Critical Dependency

Transparent provider swap only works if OpenCode can send gateway request context on every migrated provider call.

The gateway needs, at minimum:

```http
x-veslo-session-id: <veslo-session-id>
x-veslo-gateway-token: <short-lived gateway access token>
```

If OpenCode cannot supply those headers from configuration alone, patch upstream OpenCode before completing Task 10. Do not fake session stickiness with request-body heuristics.

### Task 1: Add gateway env, migrations, and persistence foundations

**Files:**
- Create: `services/ai-gateway/drizzle.config.ts`
- Modify: `services/ai-gateway/package.json`
- Modify: `services/ai-gateway/src/env.ts`
- Modify: `services/ai-gateway/src/db/schema.ts`
- Modify: `services/ai-gateway/test/env.test.ts`
- Modify: `services/ai-gateway/test/schema.test.ts`
- Modify: `packaging/docker/docker-compose.dev.yml`
- Modify: `packaging/docker/dev-up.sh`

**Step 1: Write the failing env/schema tests**

Add assertions for:

```ts
assert.equal(parsed.databaseUrl, "mysql://gateway:gateway@127.0.0.1:3306/veslo_ai_gateway");
assert.equal(parsed.secretKey, "test_secret_key_32_bytes_minimum____");
assert.equal(parsed.openAiOAuth.clientId, "client_id");
assert.ok(CoreTableNames.credential_usage_event);
assert.ok(CoreTableNames.audit_event);
```

**Step 2: Run the focused tests to verify they fail**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/env.test.ts test/schema.test.ts
```

Expected: FAIL because the new env fields, table names, and schema exports do not exist yet.

**Step 3: Add the minimal env and schema support**

Implement:

```ts
const envSchema = z.object({
  AI_GATEWAY_DATABASE_URL: z.string().min(1),
  AI_GATEWAY_SECRET_KEY: z.string().min(32),
  AI_GATEWAY_OPENAI_CLIENT_ID: z.string().min(1),
  AI_GATEWAY_OPENAI_CLIENT_SECRET: z.string().min(1),
  AI_GATEWAY_OPENAI_REDIRECT_BASE: z.string().url(),
})
```

and extend `schema.ts` with BYOK-ready tables and columns:

- `credential_record.owner_user_id`
- `credential_binding.owner_user_id`
- `credential_binding.provider`
- `session_lease.owner_user_id`
- `session_lease.provider`
- `credential_usage_event`
- `audit_event`

Also add `drizzle-kit` scripts and a MySQL container/env wiring in Docker. Keep the orchestrator healthcheck `start_period` at `240s` or higher; do not regress the new cold-boot allowance from `main`.

**Step 4: Re-run focused verification**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/env.test.ts test/schema.test.ts
pnpm --filter @neatech/ai-gateway build
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/package.json services/ai-gateway/drizzle.config.ts services/ai-gateway/src/env.ts services/ai-gateway/src/db/schema.ts services/ai-gateway/test/env.test.ts services/ai-gateway/test/schema.test.ts packaging/docker/docker-compose.dev.yml packaging/docker/dev-up.sh
git commit -m "feat: add ai gateway persistence foundations"
```

### Task 2: Expand gateway repository ports for BYOK ownership, leases, and telemetry

**Files:**
- Modify: `services/ai-gateway/src/credentials/repository.ts`
- Modify: `services/ai-gateway/src/leases/repository.ts`
- Create: `services/ai-gateway/src/usage/repository.ts`
- Create: `services/ai-gateway/src/audit/repository.ts`
- Modify: `services/ai-gateway/src/typecheck/repository-contracts.ts`

**Step 1: Write the failing repository contract assertions**

Add repository contract coverage for:

```ts
type ResolveLeaseInput = { ownerUserId: string; provider: "openai" | "anthropic"; sessionId: string }
type ListEligibleBindingsInput = { ownerUserId: string; provider: string; excludeBindingId?: string }
type RecordUsageInput = { requestId: string; ownerUserId: string; provider: string; sessionId: string; bindingId: string; model: string }
```

**Step 2: Run the typecheck/build to verify it fails**

Run:

```bash
pnpm --filter @neatech/ai-gateway build
```

Expected: FAIL because the repository interfaces still expose global, provider-agnostic APIs.

**Step 3: Add the minimal repository interfaces**

Define ports like:

```ts
export interface CredentialRepository {
  listEligibleBindings(input: ListEligibleBindingsInput): Promise<CredentialBinding[]>;
  getCredentialRecordByBindingId(bindingId: string): Promise<CredentialRecord | null>;
  markCredentialState(input: MarkCredentialStateInput): Promise<void>;
}

export interface LeaseRepository {
  getActiveLease(input: ResolveLeaseInput): Promise<SessionLease | null>;
  createLeaseIfMissing(input: CreateSessionLeaseInput): Promise<SessionLease>;
  rebindLease(input: RebindSessionLeaseInput): Promise<SessionLease | null>;
}
```

Add dedicated usage and audit repository ports instead of pushing those concerns into `admin.ts`.

**Step 4: Re-run typecheck**

Run:

```bash
pnpm --filter @neatech/ai-gateway build
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/credentials/repository.ts services/ai-gateway/src/leases/repository.ts services/ai-gateway/src/usage/repository.ts services/ai-gateway/src/audit/repository.ts services/ai-gateway/src/typecheck/repository-contracts.ts
git commit -m "feat: expand ai gateway repository contracts"
```

### Task 3: Implement secure secret storage and a refresh-aware token broker

**Files:**
- Create: `services/ai-gateway/src/credentials/secret-store.ts`
- Create: `services/ai-gateway/src/credentials/encrypted-secret-store.ts`
- Create: `services/ai-gateway/src/credentials/default-token-broker.ts`
- Modify: `services/ai-gateway/src/credentials/token-broker.ts`
- Modify: `services/ai-gateway/src/index.ts`
- Create: `services/ai-gateway/test/token-broker.test.ts`

**Step 1: Write the failing token broker tests**

Cover:

```ts
test("returns api key auth for anthropic bindings", ...)
test("returns oauth access token for healthy openai binding", ...)
test("refreshes expired openai oauth tokens before proxying", ...)
test("marks revoked oauth credentials unhealthy without leaking tokens", ...)
```

**Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/token-broker.test.ts
```

Expected: FAIL because there is no real secret store or token broker implementation.

**Step 3: Add the minimal implementation**

Introduce:

```ts
export type StoredSecret =
  | { kind: "api_key"; apiKey: string }
  | { kind: "openai_oauth"; accessToken: string; refreshToken: string; expiresAt: string }

export interface SecretStore {
  put(secret: StoredSecret): Promise<{ secretRef: string }>
  get(secretRef: string): Promise<StoredSecret>
  replace(secretRef: string, secret: StoredSecret): Promise<void>
}
```

`DefaultTokenBroker` should:

- load the binding and owning credential
- decrypt the secret via `SecretStore`
- refresh OpenAI OAuth if expired
- persist refreshed tokens back through `SecretStore`
- return `UpstreamAuth`
- mark credentials unhealthy on permanent auth failures

Wire it into `createApp()` instead of the current throwing placeholder.

**Step 4: Re-run focused verification**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/token-broker.test.ts
pnpm --filter @neatech/ai-gateway build
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/credentials/secret-store.ts services/ai-gateway/src/credentials/encrypted-secret-store.ts services/ai-gateway/src/credentials/default-token-broker.ts services/ai-gateway/src/credentials/token-broker.ts services/ai-gateway/src/index.ts services/ai-gateway/test/token-broker.test.ts
git commit -m "feat: add ai gateway secret store and token broker"
```

### Task 4: Make sticky leases provider-scoped and backed by a real selector

**Files:**
- Modify: `services/ai-gateway/src/leases/repository.ts`
- Modify: `services/ai-gateway/src/leases/lease-broker.ts`
- Create: `services/ai-gateway/src/leases/binding-selector.ts`
- Create: `services/ai-gateway/src/leases/mysql-repository.ts`
- Modify: `services/ai-gateway/test/lease-broker.test.ts`

**Step 1: Write the failing lease tests**

Add coverage for:

```ts
test("keeps separate leases for the same session across openai and anthropic", ...)
test("reuses the same binding for repeated requests from one session and provider", ...)
test("rebinds only within the same owner user and provider pool", ...)
```

**Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/lease-broker.test.ts
```

Expected: FAIL because the broker and repo are still keyed only by `sessionId`.

**Step 3: Add the minimal provider-scoped lease implementation**

Change the broker contract to:

```ts
await leaseBroker.getOrCreateActiveLease({
  ownerUserId: "user_123",
  provider: "openai",
  sessionId: "session_123",
})
```

and create a selector that:

- lists eligible bindings for one `ownerUserId + provider`
- keeps current binding for healthy sessions
- picks a replacement excluding the failed binding

**Step 4: Re-run focused verification**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/lease-broker.test.ts
pnpm --filter @neatech/ai-gateway build
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/leases/repository.ts services/ai-gateway/src/leases/lease-broker.ts services/ai-gateway/src/leases/binding-selector.ts services/ai-gateway/src/leases/mysql-repository.ts services/ai-gateway/test/lease-broker.test.ts
git commit -m "feat: add provider scoped lease brokering"
```

### Task 5: Implement provider-native proxy routes, transports, and failure rebinding

**Files:**
- Modify: `services/ai-gateway/src/http/proxy.ts`
- Create: `services/ai-gateway/src/http/providers/openai.ts`
- Create: `services/ai-gateway/src/http/providers/anthropic.ts`
- Modify: `services/ai-gateway/src/providers/transport.ts`
- Create: `services/ai-gateway/src/providers/openai-transport.ts`
- Create: `services/ai-gateway/src/providers/anthropic-transport.ts`
- Modify: `services/ai-gateway/src/leases/error-classifier.ts`
- Modify: `services/ai-gateway/test/proxy.test.ts`

**Step 1: Write the failing proxy tests**

Cover:

```ts
test("POST /providers/openai/v1/chat/completions forwards with sticky openai lease", ...)
test("POST /providers/anthropic/v1/messages forwards with sticky anthropic lease", ...)
test("permanent credential failures call handleUpstreamFailure and retry once", ...)
test("transient upstream failures do not rebind", ...)
```

**Step 2: Run the focused tests to verify they fail**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/proxy.test.ts
```

Expected: FAIL because the proxy is generic, OpenAI-only, and never rebinds on failure.

**Step 3: Add the minimal routing and retry logic**

Use provider-specific routes:

```ts
router.use("/providers/openai", createOpenAiProxyRouter(...))
router.use("/providers/anthropic", createAnthropicProxyRouter(...))
```

and on permanent auth failure:

```ts
const nextLease = await deps.leaseBroker.handleUpstreamFailure({
  ownerUserId,
  provider,
  sessionId,
  currentBindingId: lease.activeBindingId,
  failure,
})
```

Retry exactly once after rebinding. Record usage only on successful upstream responses.

**Step 4: Re-run focused verification**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/proxy.test.ts
pnpm --filter @neatech/ai-gateway build
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/http/proxy.ts services/ai-gateway/src/http/providers/openai.ts services/ai-gateway/src/http/providers/anthropic.ts services/ai-gateway/src/providers/transport.ts services/ai-gateway/src/providers/openai-transport.ts services/ai-gateway/src/providers/anthropic-transport.ts services/ai-gateway/src/leases/error-classifier.ts services/ai-gateway/test/proxy.test.ts
git commit -m "feat: add provider native gateway proxy routes"
```

### Task 6: Replace fixture-backed admin data with real usage and audit read models

**Files:**
- Create: `services/ai-gateway/src/usage/mysql-repository.ts`
- Create: `services/ai-gateway/src/audit/mysql-repository.ts`
- Modify: `services/ai-gateway/src/http/admin.ts`
- Modify: `services/ai-gateway/test/admin-ui.test.ts`
- Create: `services/ai-gateway/test/admin-read-models.test.ts`

**Step 1: Write the failing admin read-model tests**

Cover:

```ts
test("admin credentials endpoint returns repository-backed credentials", ...)
test("admin sessions endpoint returns provider-scoped active leases", ...)
test("admin usage endpoint aggregates by credential and user", ...)
test("admin audit endpoint returns persisted events instead of fixtures", ...)
```

**Step 2: Run the focused tests to verify they fail**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-ui.test.ts test/admin-read-models.test.ts
```

Expected: FAIL because `admin.ts` still uses hard-coded fixtures.

**Step 3: Add the minimal repository-backed admin service**

Move fixture logic behind interfaces and replace it with:

```ts
await usageRepository.aggregateUsage({ groupBy, credentialId, userId, orgId })
await auditRepository.listEvents({ limit: 100 })
await credentialRepository.listAdminCredentials()
await leaseRepository.listAdminSessions()
```

Keep the static HTML shell, but stop embedding fake credential/session data.

**Step 4: Re-run focused verification**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-ui.test.ts test/admin-read-models.test.ts
pnpm --filter @neatech/ai-gateway build
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/usage/mysql-repository.ts services/ai-gateway/src/audit/mysql-repository.ts services/ai-gateway/src/http/admin.ts services/ai-gateway/test/admin-ui.test.ts services/ai-gateway/test/admin-read-models.test.ts
git commit -m "feat: add real ai gateway admin read models"
```

### Task 7: Add authenticated user BYOK credential APIs to the gateway

**Files:**
- Create: `services/ai-gateway/src/auth/user-session.ts`
- Create: `services/ai-gateway/src/credentials/openai-oauth.ts`
- Create: `services/ai-gateway/src/http/user-credentials.ts`
- Modify: `services/ai-gateway/src/index.ts`
- Create: `services/ai-gateway/test/user-credentials.test.ts`

**Step 1: Write the failing credential API tests**

Cover:

```ts
test("POST /api/providers/openai/oauth/start returns authorize url for the signed-in user", ...)
test("POST /api/providers/openai/oauth/callback stores refreshed oauth secret and binding", ...)
test("POST /api/providers/anthropic/api-keys stores an encrypted api key and binding", ...)
test("GET /api/providers/:provider/credentials never returns raw secrets", ...)
test("DELETE /api/providers/:provider/credentials/:id revokes the credential", ...)
```

**Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/user-credentials.test.ts
```

Expected: FAIL because there is no user-facing credential API yet.

**Step 3: Add the minimal credential API**

Add a bearer-token user resolver and routes like:

```ts
router.post("/api/providers/openai/oauth/start", ...)
router.post("/api/providers/openai/oauth/callback", ...)
router.post("/api/providers/anthropic/api-keys", ...)
router.get("/api/providers/:provider/credentials", ...)
router.delete("/api/providers/:provider/credentials/:credentialId", ...)
```

The response shape must be metadata-only:

```ts
{ id, provider, credentialType, state, createdAt, updatedAt, lastFailureAt }
```

Use the existing Den browser-authenticated user session from `main`. Do not introduce a second email/password login path inside `ai-gateway`, and do not bypass the browser-based verification/reset flow now used by Veslo onboarding.

**Step 4: Re-run focused verification**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/user-credentials.test.ts
pnpm --filter @neatech/ai-gateway build
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/auth/user-session.ts services/ai-gateway/src/credentials/openai-oauth.ts services/ai-gateway/src/http/user-credentials.ts services/ai-gateway/src/index.ts services/ai-gateway/test/user-credentials.test.ts
git commit -m "feat: add gateway byok credential apis"
```

### Task 8: Add Veslo server proxy routes and app client methods for gateway auth/state

**Files:**
- Modify: `packages/server/src/server.ts`
- Create: `packages/server/src/server.ai-gateway.test.ts`
- Modify: `packages/app/src/app/lib/veslo-server.ts`
- Modify: `packages/app/src/app/lib/veslo-server.test.ts`

**Step 1: Write the failing server/app client tests**

Cover:

```ts
test("server proxies ai-gateway credential routes with caller auth", ...)
test("server redacts gateway access tokens and never returns provider secrets", ...)
test("createVesloServerClient exposes startOpenAiOAuth, finishOpenAiOAuth, saveAnthropicApiKey, listGatewayCredentials, revokeGatewayCredential", ...)
```

**Step 2: Run the focused tests to verify they fail**

Run:

```bash
pnpm --filter veslo-server exec bun test src/server.ai-gateway.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/veslo-server.test.ts
```

Expected: FAIL because the server has no gateway proxy surface and the app client has no gateway methods.

**Step 3: Add the minimal proxy and client surface**

Add routes under Veslo server such as:

```ts
/ai-gateway/providers/openai/oauth/start
/ai-gateway/providers/openai/oauth/callback
/ai-gateway/providers/anthropic/api-keys
/ai-gateway/providers/:provider/credentials
```

and client methods mirroring those routes in `createVesloServerClient()`.

**Step 4: Re-run focused verification**

Run:

```bash
pnpm --filter veslo-server exec bun test src/server.ai-gateway.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/veslo-server.test.ts
pnpm --filter veslo-server build:bin
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/server/src/server.ts packages/server/src/server.ai-gateway.test.ts packages/app/src/app/lib/veslo-server.ts packages/app/src/app/lib/veslo-server.test.ts
git commit -m "feat: expose ai gateway auth through veslo server"
```

### Task 9: Migrate app provider auth flows away from OpenCode for OpenAI and Anthropic

**Files:**
- Modify: `packages/app/src/app/lib/provider-auth.ts`
- Create: `packages/app/src/app/lib/provider-auth.test.ts`
- Modify: `packages/app/src/app/components/provider-auth-modal.tsx`
- Modify: `packages/app/src/app/context/global-sync.tsx`
- Modify: `packages/app/src/app/utils/providers.ts`

**Step 1: Write the failing provider auth tests**

Cover:

```ts
test("submitProviderApiKey sends anthropic api keys to veslo server gateway api, not c.auth.set", ...)
test("startProviderAuth sends openai oauth start to veslo server gateway api, not c.provider.oauth.authorize", ...)
test("completeProviderAuthOAuth finishes openai oauth via veslo server gateway api", ...)
test("disconnectProvider revokes gateway credentials for migrated providers", ...)
test("lmstudio still uses the existing local config path", ...)
```

**Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/provider-auth.test.ts
```

Expected: FAIL because `provider-auth.ts` still uses `c.auth.set()` and `c.provider.oauth.*()` for migrated providers.

**Step 3: Add the minimal app migration**

Split migrated providers from legacy providers:

```ts
const GATEWAY_OWNED_PROVIDERS = new Set(["openai", "anthropic"])
```

For those providers:

- call Veslo server gateway methods
- refresh provider connection state from gateway metadata
- never call `c.auth.set()`
- never call `c.provider.oauth.authorize()` or `.callback()`

Keep LM Studio and other non-migrated providers on the existing path.

**Step 4: Re-run focused verification**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/provider-auth.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/provider-auth.ts packages/app/src/app/lib/provider-auth.test.ts packages/app/src/app/components/provider-auth-modal.tsx packages/app/src/app/context/global-sync.tsx packages/app/src/app/utils/providers.ts
git commit -m "feat: migrate app provider auth to ai gateway"
```

### Task 10: Cut OpenCode provider routing over to gateway-backed OpenAI and Anthropic

**Files:**
- Modify: `packages/app/src/app/lib/provider-auth.ts`
- Modify: `packages/app/src/app/lib/opencode.ts`
- Modify: `packages/server/src/server.ts`
- Create: `packages/app/src/app/lib/provider-routing.test.ts`

**Step 1: Write the failing routing tests**

Cover:

```ts
test("openai provider config points at ai-gateway openai route", ...)
test("anthropic provider config points at ai-gateway anthropic route", ...)
test("gateway access token is stored as a gateway credential, not a raw provider secret", ...)
test("migrated provider config export redacts gateway access tokens", ...)
```

**Step 2: Run the focused tests to verify they fail**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/provider-routing.test.ts
pnpm --filter veslo-server exec bun test src/server.ai-gateway.test.ts
```

Expected: FAIL because migrated providers are not yet routed to gateway endpoints.

**Step 3: Add the minimal routing cutover**

Write gateway-backed provider config instead of raw OpenAI/Anthropic auth:

```json
{
  "provider": {
    "openai": {
      "api": {
        "baseURL": "http://127.0.0.1:4034/providers/openai/v1",
        "headers": {
          "x-veslo-gateway-token": "${VESLO_GATEWAY_TOKEN}"
        }
      }
    }
  }
}
```

and equivalent Anthropic routing. If config alone cannot carry `x-veslo-session-id`, stop here and land the required upstream OpenCode patch before merging this task.

**Step 4: Re-run focused verification**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/provider-routing.test.ts
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter veslo-server exec bun test src/server.ai-gateway.test.ts
pnpm --filter veslo-server build:bin
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/provider-auth.ts packages/app/src/app/lib/opencode.ts packages/app/src/app/lib/provider-routing.test.ts packages/server/src/server.ts
git commit -m "feat: route migrated providers through ai gateway"
```

### Task 11: Verify end-to-end, capture screenshots, and remove migration leftovers

**Files:**
- Modify: `services/ai-gateway/src/index.ts`
- Modify: `packages/app/src/app/lib/provider-auth.ts`
- Modify: `packages/server/src/server.ts`
- Create: `docs/screenshots/ai-gateway-byok-openai-connect.png`
- Create: `docs/screenshots/ai-gateway-byok-anthropic-connect.png`
- Create: `docs/screenshots/ai-gateway-admin-usage.png`

**Step 1: Write the final regression checklist into tests/scripts**

Add or extend the smallest missing automated checks for:

```ts
// no raw provider secrets in exported config
assert.doesNotMatch(serializedConfig, /sk-ant|sk-proj|refresh_token|access_token/)
```

and one gateway smoke covering lease rebinding.

**Step 2: Run the full automated verification set**

Run:

```bash
pnpm --filter @neatech/ai-gateway test
pnpm --filter veslo-server test
pnpm --filter @neatech/veslo-ui test:unit
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter veslo-server build:bin
```

Expected: PASS.

**Step 3: Run the required manual stack verification**

Run:

```bash
packaging/docker/dev-up.sh
pnpm --filter @neatech/veslo dev
```

Then use `.opencode/skills/openwork-docker-chrome-mcp/SKILL.md` to verify:

- OpenAI OAuth connect
- Anthropic API key connect
- prompt success through gateway
- second session distributes to another binding for the same provider
- forced permanent failure causes rebind
- admin usage/session views show real data

Capture screenshots into `docs/screenshots/`.

**Step 4: Remove leftover direct-auth branches for migrated providers**

Delete or guard any remaining `openai` / `anthropic` calls to:

```ts
c.auth.set(...)
c.provider.oauth.authorize(...)
c.provider.oauth.callback(...)
```

LM Studio and other local-only providers must remain untouched.

**Step 5: Commit**

```bash
git add services/ai-gateway packages/server packages/app docs/screenshots
git commit -m "feat: finish ai gateway byok auth migration"
```
