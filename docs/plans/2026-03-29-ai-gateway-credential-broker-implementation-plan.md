# AI Gateway Credential Broker Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a standalone cloud AI gateway service with session-scoped credential leases, controlled failover, usage metering, platform-admin control plane, and a Den-backed user directory/invite integration.

**Architecture:** Add a new `services/ai-gateway` service that owns provider-compatible inference proxying, lease state, credential health, usage events, and a small internal admin UI. Keep long-lived secrets server-side only, pin sessions to logical leases with atomic rebinding, and extend `services/den` only for role-aware user directory and invite state so the new control plane can reflect existing `owner/member/platform_admin` reality instead of inventing a parallel identity model.

**Tech Stack:** TypeScript, Express, Zod, Drizzle ORM, MySQL, Redis-compatible lease locking/cache, Docker Compose dev stack, Node test runner via `tsx --test`, Chrome MCP, Tauri desktop for any cross-product verification

---

## Prerequisites

- Use `@superpowers:test-driven-development` during implementation.
- Execute this plan in a dedicated worktree, not on the shared `main` checkout.
- Keep the feature as a standalone service under `services/`, not inside `packages/web`.
- Do not run the main app as `packages/web`; use the Docker dev stack and, where needed, the Tauri desktop app.
- Because this is a new feature, follow the repo workflow: sync submodules, create worktree, run Docker dev stack, verify with Chrome MCP, capture screenshots.

### Task 1: Create the isolated worktree and capture a clean baseline

**Files:**
- Modify: none (environment setup only)

**Step 1: Sync remotes and submodules**

Run:

```bash
git fetch --all --prune
git submodule update --init --recursive
```

Expected: repository metadata is up to date and submodules are initialized.

**Step 2: Create the feature worktree**

Run:

```bash
git worktree add .worktrees/codex/ai-gateway-broker -b codex/ai-gateway-broker origin/main
cd .worktrees/codex/ai-gateway-broker
```

Expected: a clean worktree exists on branch `codex/ai-gateway-broker`.

**Step 3: Install dependencies and capture baseline**

Run:

```bash
pnpm install --frozen-lockfile
pnpm --filter @neatech/den test
```

Expected: install succeeds and current Den tests pass before feature edits.

**Step 4: Commit nothing**

No commit here. This task only establishes a clean baseline.

### Task 2: Scaffold the standalone `services/ai-gateway` service and wire it into the dev stack

**Files:**
- Create: `services/ai-gateway/package.json`
- Create: `services/ai-gateway/tsconfig.json`
- Create: `services/ai-gateway/src/index.ts`
- Create: `services/ai-gateway/src/env.ts`
- Create: `services/ai-gateway/test/health.test.ts`
- Modify: `packaging/docker/docker-compose.dev.yml`
- Modify: `packaging/docker/dev-up.sh`

**Step 1: Add the new workspace package**

Create `services/ai-gateway/package.json` with scripts and dependencies mirroring `services/den`:

```json
{
  "name": "@neatech/ai-gateway",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "tsx --test test/**/*.test.ts"
  }
}
```

Include at least: `express`, `zod`, `dotenv`, `drizzle-orm`, `mysql2`.

**Step 2: Add a minimal health-only server**

Create `services/ai-gateway/src/index.ts` with:

```ts
const app = express();
app.get("/health", (_req, res) => res.json({ ok: true, service: "ai-gateway" }));
app.listen(env.port, env.host);
```

Keep it intentionally tiny; this task is only for scaffolding and Docker wiring.

**Step 3: Add a failing health test first**

Create `services/ai-gateway/test/health.test.ts` that boots the app in-process and asserts:

- `GET /health` returns `200`
- payload contains `{ ok: true, service: "ai-gateway" }`

**Step 4: Wire the new service into Docker Compose**

Modify `packaging/docker/docker-compose.dev.yml` to add an `ai-gateway` service that:

- mounts the repo
- installs deps
- runs `pnpm --filter @neatech/ai-gateway dev`
- exposes a host port through env such as `VESLO_AI_GATEWAY_PORT`

Update `packaging/docker/dev-up.sh` to print the new URL alongside the existing stack URLs.

**Step 5: Run the new focused test and dev stack**

Run:

```bash
pnpm --filter @neatech/ai-gateway test
packaging/docker/dev-up.sh
```

Expected:

- health test passes
- Docker output prints the AI gateway URL

**Step 6: Commit the scaffold**

```bash
git add services/ai-gateway packaging/docker/docker-compose.dev.yml packaging/docker/dev-up.sh
git commit -m "feat: scaffold standalone ai gateway service"
```

### Task 3: Add gateway persistence schema and failing lease lifecycle tests

**Files:**
- Create: `services/ai-gateway/src/db/index.ts`
- Create: `services/ai-gateway/src/db/schema.ts`
- Create: `services/ai-gateway/src/leases/lease-broker.ts`
- Create: `services/ai-gateway/test/lease-broker.test.ts`

**Step 1: Define the core tables**

In `services/ai-gateway/src/db/schema.ts`, define minimal first-pass tables for:

```ts
type CredentialState = "healthy" | "degraded" | "draining" | "unhealthy" | "revoked";

credential_record
credential_binding
session_lease
usage_event
credential_health_event
```

Use explicit IDs rather than implicit numeric IDs.

**Step 2: Write failing lease tests first**

Create `services/ai-gateway/test/lease-broker.test.ts` covering:

- first request creates a lease
- later requests on same session reuse the same binding
- refreshable auth failure does not switch binding
- permanent credential failure rebinds once
- parallel failures only produce one rebinding

Use a pure in-memory fake repository first so the lease logic is easy to unit test.

**Step 3: Create the initial repository interface**

In `services/ai-gateway/src/leases/lease-broker.ts`, define small ports like:

```ts
type LeaseRepository = {
  getActiveLease(sessionId: string): Promise<SessionLease | null>;
  createLease(input: CreateLeaseInput): Promise<SessionLease>;
  rebindLease(input: RebindLeaseInput): Promise<SessionLease>;
};
```

Do not couple the broker to Express yet.

**Step 4: Run the focused tests and confirm failure**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/lease-broker.test.ts
```

Expected: FAIL until the broker implementation exists.

**Step 5: Commit the failing test checkpoint**

```bash
git add services/ai-gateway/src/db services/ai-gateway/src/leases services/ai-gateway/test/lease-broker.test.ts
git commit -m "test: specify ai gateway lease lifecycle"
```

### Task 4: Implement lease broker, error classification, and credential health transitions

**Files:**
- Modify: `services/ai-gateway/src/leases/lease-broker.ts`
- Create: `services/ai-gateway/src/leases/error-classifier.ts`
- Create: `services/ai-gateway/src/credentials/health-store.ts`
- Test: `services/ai-gateway/test/lease-broker.test.ts`

**Step 1: Implement the classification boundary**

Create `services/ai-gateway/src/leases/error-classifier.ts` with a pure API:

```ts
export type UpstreamFailureKind =
  | "refreshable_auth"
  | "permanent_credential"
  | "transient_upstream";
```

Translate provider failure shapes into one of those three buckets.

**Step 2: Implement sticky lease semantics**

In `lease-broker.ts`, make the broker:

- create a first binding when no lease exists
- return the active binding when it is healthy
- refresh the same binding on `refreshable_auth`
- atomically rebind on `permanent_credential`
- avoid immediate rebinding on `transient_upstream`

**Step 3: Add health transitions**

In `health-store.ts`, add small pure helpers like:

```ts
markCredentialHealthy(id)
markCredentialDraining(id, reason)
markCredentialUnhealthy(id, reason)
```

Make rebinding record both the old and new binding in history.

**Step 4: Re-run focused tests**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/lease-broker.test.ts
```

Expected: PASS.

**Step 5: Commit the lease broker**

```bash
git add services/ai-gateway/src/leases services/ai-gateway/src/credentials
git commit -m "feat: add sticky session lease broker with failover"
```

### Task 5: Add provider-compatible proxy routes and usage metering

**Files:**
- Create: `services/ai-gateway/src/http/proxy.ts`
- Create: `services/ai-gateway/src/credentials/token-broker.ts`
- Create: `services/ai-gateway/src/metering/usage-events.ts`
- Create: `services/ai-gateway/test/proxy.test.ts`
- Modify: `services/ai-gateway/src/index.ts`

**Step 1: Write failing proxy tests**

Create `services/ai-gateway/test/proxy.test.ts` for:

- request with new session creates a lease
- repeated session request reuses binding
- permanent credential failure rebinds and retries once
- usage event is recorded with user/session/credential dimensions

Stub the upstream provider transport rather than calling a real provider.

**Step 2: Add a minimal provider-compatible route**

Start with one OpenAI-style endpoint in `services/ai-gateway/src/http/proxy.ts`, for example:

```ts
router.post("/v1/chat/completions", handler);
```

Keep request/response pass-through as shallow as possible in v1. Do not normalize the provider response shape.

**Step 3: Add token broker and usage event write path**

`token-broker.ts` should expose one narrow interface:

```ts
getUpstreamAuth(bindingId: string): Promise<{ kind: "api-key" | "oauth"; value: string }>
```

`usage-events.ts` should expose:

```ts
recordUsageEvent(input: UsageEventInput): Promise<void>
```

Record at least: user, org, session, worker, binding, credential, provider, model, token counts, timestamps, and failover marker.

**Step 4: Run tests and confirm pass**

Run:

```bash
pnpm --filter @neatech/ai-gateway test
```

Expected: PASS for both health and proxy/lease tests.

**Step 5: Commit proxy + metering**

```bash
git add services/ai-gateway/src/http services/ai-gateway/src/metering services/ai-gateway/test/proxy.test.ts services/ai-gateway/src/index.ts
git commit -m "feat: add ai gateway proxy and usage metering"
```

### Task 6: Add reporting and alerting endpoints for admin operations

**Files:**
- Create: `services/ai-gateway/src/http/admin-api.ts`
- Create: `services/ai-gateway/src/alerts/monitor.ts`
- Create: `services/ai-gateway/test/admin-api.test.ts`
- Modify: `services/ai-gateway/src/index.ts`

**Step 1: Add failing admin API tests**

Cover endpoints like:

- `GET /admin/overview`
- `GET /admin/credentials`
- `GET /admin/usage`
- `GET /admin/incidents`

Assertions should check that response payloads include the dimensions already approved in the design:

- usage per user
- usage per credential
- unhealthy/draining counts
- failover counts

**Step 2: Add a monitor module**

In `services/ai-gateway/src/alerts/monitor.ts`, implement pure threshold evaluation helpers such as:

```ts
detectCredentialFailureStorm(events)
detectMeteringGap(input)
detectProviderOutage(input)
```

The first version can return incident records without integrating pager delivery yet.

**Step 3: Implement the read endpoints**

Make `admin-api.ts` serve JSON read models for the control plane so the UI can be built against stable endpoints instead of reading the DB directly.

**Step 4: Run the focused tests**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-api.test.ts
```

Expected: PASS.

**Step 5: Commit reporting and alerting**

```bash
git add services/ai-gateway/src/http/admin-api.ts services/ai-gateway/src/alerts services/ai-gateway/test/admin-api.test.ts services/ai-gateway/src/index.ts
git commit -m "feat: add ai gateway admin reporting endpoints"
```

### Task 7: Extend Den with platform user directory and invite state

**Files:**
- Modify: `services/den/src/db/schema.ts`
- Modify: `services/den/src/index.ts`
- Create: `services/den/src/http/platform-users.ts`
- Create: `services/den/test/platform-users.test.ts`
- Create: `services/den/drizzle/0009_platform_invite.sql`

**Step 1: Add failing Den tests first**

Create `services/den/test/platform-users.test.ts` to specify:

- platform admin can list users and platform-admin status
- platform admin can view org memberships and `owner/member` role data
- platform admin can create an invite record for an email not yet onboarded
- non-platform admin is forbidden

**Step 2: Add invite persistence**

In `services/den/src/db/schema.ts`, add a table like:

```ts
platform_invite(
  id,
  email,
  invited_by_user_id,
  status, // pending | requested | accepted | cancelled | expired
  target_org_id,
  target_org_role
)
```

Mirror it in `services/den/drizzle/0009_platform_invite.sql` and register reconciliation in `services/den/src/index.ts`.

**Step 3: Add the platform user router**

Create `services/den/src/http/platform-users.ts` with routes such as:

- `GET /platform/users`
- `POST /platform/invites`
- `POST /platform/users/:userId/platform-admin`
- `DELETE /platform/users/:userId/platform-admin`

Use `isPlatformAdmin()` from existing auth helpers rather than inventing a new auth concept.

**Step 4: Register the router and run tests**

Run:

```bash
pnpm --filter @neatech/den test
```

Expected: PASS with the new platform user and invite tests included.

**Step 5: Commit Den platform user support**

```bash
git add services/den/src/db/schema.ts services/den/src/index.ts services/den/src/http/platform-users.ts services/den/test/platform-users.test.ts services/den/drizzle/0009_platform_invite.sql
git commit -m "feat(den): add platform user directory and invites"
```

### Task 8: Build the platform-admin control plane UI inside the standalone service

**Files:**
- Create: `services/ai-gateway/src/admin/render.ts`
- Create: `services/ai-gateway/src/admin/layout.ts`
- Create: `services/ai-gateway/public/admin.css`
- Create: `services/ai-gateway/test/admin-ui.test.ts`
- Modify: `services/ai-gateway/src/index.ts`

**Step 1: Write a routing smoke test first**

Create `services/ai-gateway/test/admin-ui.test.ts` that asserts:

- `GET /admin` renders the overview shell
- `GET /admin/users` renders the users directory shell
- non-admin auth receives `403`

The tests can assert on HTML strings and key landmarks rather than full pixel output.

**Step 2: Add a tiny server-rendered UI shell**

In `services/ai-gateway/src/admin/render.ts`, create render helpers that output:

- left navigation
- overview cards
- credential health section
- active session lease detail
- user directory
- invite action panel

Keep it simple and internal; this is an operational surface, not product marketing UI.

**Step 3: Connect the UI to the JSON admin endpoints**

Route pages through the read models from `admin-api.ts` and Den’s platform user endpoints. Do not duplicate business logic inside the HTML renderer.

**Step 4: Run the UI tests**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-ui.test.ts
```

Expected: PASS.

**Step 5: Commit the control plane UI**

```bash
git add services/ai-gateway/src/admin services/ai-gateway/public/admin.css services/ai-gateway/test/admin-ui.test.ts services/ai-gateway/src/index.ts
git commit -m "feat: add ai gateway admin control plane"
```

### Task 9: Verify end-to-end through Docker, Chrome MCP, and screenshots

**Files:**
- Modify: documentation or evidence files only if needed for screenshots or notes

**Step 1: Bring up the full dev stack**

Run:

```bash
packaging/docker/dev-up.sh
```

Expected: stack prints URLs for Den, the main app, and the AI gateway service.

**Step 2: Seed or create minimal admin data**

Use local scripts or direct API calls to create:

- one `platform_admin`
- one org with `owner/member`
- at least two credentials
- at least one unhealthy credential event
- at least one invite in pending/requested state

**Step 3: Verify admin UI flows in browser**

Use Chrome MCP against the AI gateway admin URL and validate:

- overview renders metrics
- credentials screen shows health states
- user directory shows `platform_admin` and `owner/member`
- invite flow can create a pending invite state
- incident visibility is obvious

Capture screenshots into a repo evidence path such as:

```bash
mkdir -p evidence/ai-gateway-admin
```

**Step 4: Run the targeted automated tests**

Run:

```bash
pnpm --filter @neatech/ai-gateway test
pnpm --filter @neatech/den test
```

Expected: PASS.

**Step 5: Commit verification artifacts if appropriate**

```bash
git add evidence/ai-gateway-admin
git commit -m "test: capture ai gateway admin verification"
```

Only commit screenshots if they are intentionally part of the review package.

## Execution Notes

- Keep the first implementation slice narrow: one provider-compatible route, one lease path, one reporting slice.
- Prefer pure modules for lease logic, classification, and alert detection so test coverage stays high.
- Do not solve full provider-reported usage reconciliation in the first pass, but keep schema fields ready for it.
- Do not invent a second identity system in the gateway service; consume Den’s roles and invite state.

