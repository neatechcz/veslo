# AI Gateway Control Plane Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver the AI gateway system in three independently shippable increments: core gateway data plane, metering/signals/read models, and the platform-admin control plane.

**Architecture:** Build `services/ai-gateway` as a standalone service and keep strict boundaries between the data plane, operational signals, and operator UI. Put lease, credential, usage, incident, and audit logic inside the gateway service; use `services/den` only for platform user directory and invite state so the control plane reflects existing `owner/member/platform_admin` behavior instead of inventing a second identity model.

**Tech Stack:** TypeScript, Express, Zod, Drizzle ORM, MySQL, Redis-compatible locking/cache, Docker Compose dev stack, Node test runner via `tsx --test`, Chrome MCP, Tauri desktop for any cross-product verification

---

## Delivery Slices

### Slice A: Core Gateway Data Plane

Ship this first. It must solve:

- server-side custody of provider secrets
- provider-compatible proxy entrypoints
- session lease creation/reuse
- controlled failover when credentials break

It does not wait for:

- HTML admin UI
- full reporting dashboards
- invite flow UX

### Slice B: Metering, Signals, and Read Models

Ship this second. It must solve:

- usage recording and aggregation
- credential-to-alert linkage
- audit event recording
- JSON read endpoints for admin surfaces

It does not wait for:

- polished control-plane pages
- user management UI

### Slice C: Control Plane and User Operations

Ship this last. It must solve:

- platform-admin-only access
- credentials/sessions/usage/alerts/users/audit pages
- selected-user edit flow
- Den-backed user and invite actions

---

## Prerequisites

- Use `@superpowers:test-driven-development` during implementation.
- Execute this plan in a dedicated worktree, not on the shared `main` checkout.
- Keep the feature as a standalone service under `services/`, not inside `packages/web`.
- Do not run the main app as `packages/web`; use the Docker dev stack and, where needed, the Tauri desktop app.
- Because this is a new feature, follow the repo workflow: sync submodules, create a worktree, run the Docker dev stack, verify with Chrome MCP, and capture screenshots for UI-facing slices.

### Task 1: Create the isolated worktree and baseline

**Files:**
- Modify: none (environment setup only)

**Step 1: Sync remotes and submodules**

Run:

```bash
git fetch --all --prune
git submodule update --init --recursive
```

Expected: repository metadata is current and submodules are initialized.

**Step 2: Create the feature worktree**

Run:

```bash
git worktree add .worktrees/codex/ai-gateway-control-plane -b codex/ai-gateway-control-plane origin/main
cd .worktrees/codex/ai-gateway-control-plane
```

Expected: a clean worktree exists on branch `codex/ai-gateway-control-plane`.

**Step 3: Install dependencies and record a baseline**

Run:

```bash
pnpm install --frozen-lockfile
pnpm --filter @neatech/den test
```

Expected: dependency install succeeds and current Den tests pass before feature work.

**Step 4: Commit nothing**

No commit here. This task only establishes a clean starting point.

## Slice A: Core Gateway Data Plane

### Task 2: Scaffold `services/ai-gateway` and wire it into the dev stack

**Files:**
- Create: `services/ai-gateway/package.json`
- Create: `services/ai-gateway/tsconfig.json`
- Create: `services/ai-gateway/src/index.ts`
- Create: `services/ai-gateway/src/env.ts`
- Create: `services/ai-gateway/test/health.test.ts`
- Modify: `packaging/docker/docker-compose.dev.yml`
- Modify: `packaging/docker/dev-up.sh`

**Step 1: Write the failing health test**

Create `services/ai-gateway/test/health.test.ts` to assert:

- `GET /health` returns `200`
- response contains `{ ok: true, service: "ai-gateway" }`

**Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/health.test.ts
```

Expected: FAIL because the service package does not exist yet.

**Step 3: Add the minimal workspace package and server**

Create the package files and a tiny Express server with only `/health`.

**Step 4: Wire the new service into Docker**

Expose the service from `packaging/docker/docker-compose.dev.yml` and print its URL from `packaging/docker/dev-up.sh`.

**Step 5: Re-run the focused test**

Run:

```bash
pnpm --filter @neatech/ai-gateway test
```

Expected: PASS for the health test.

**Step 6: Commit**

```bash
git add services/ai-gateway packaging/docker/docker-compose.dev.yml packaging/docker/dev-up.sh
git commit -m "feat: scaffold standalone ai gateway service"
```

### Task 3: Define core gateway persistence and repository ports

**Files:**
- Create: `services/ai-gateway/src/db/index.ts`
- Create: `services/ai-gateway/src/db/schema.ts`
- Create: `services/ai-gateway/src/credentials/repository.ts`
- Create: `services/ai-gateway/src/leases/repository.ts`
- Create: `services/ai-gateway/test/schema.test.ts`

**Step 1: Write a failing schema/port test**

Create `services/ai-gateway/test/schema.test.ts` that asserts the core table names and repository interfaces exist for:

- `credential_record`
- `credential_binding`
- `session_lease`
- `credential_health_event`

**Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/schema.test.ts
```

Expected: FAIL until the schema and ports exist.

**Step 3: Add the schema and repository contracts**

Create explicit IDs and small repository interfaces for credential and lease reads/writes.

**Step 4: Re-run the test**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/schema.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/db services/ai-gateway/src/credentials/repository.ts services/ai-gateway/src/leases/repository.ts services/ai-gateway/test/schema.test.ts
git commit -m "feat: add ai gateway schema and repository ports"
```

### Task 4: Specify sticky lease and failover semantics in tests

**Files:**
- Create: `services/ai-gateway/src/leases/lease-broker.ts`
- Create: `services/ai-gateway/src/leases/error-classifier.ts`
- Create: `services/ai-gateway/test/lease-broker.test.ts`

**Step 1: Write the failing lease tests**

Cover:

- first request creates a lease
- same session reuses the same binding
- refreshable auth failure does not rebind
- permanent credential failure rebinds once
- parallel failure handling is single-flight

**Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/lease-broker.test.ts
```

Expected: FAIL until the broker is implemented.

**Step 3: Implement the minimal classifier and broker**

Add the three failure buckets:

- `refreshable_auth`
- `permanent_credential`
- `transient_upstream`

Make the broker use sticky binding semantics and atomic rebinding.

**Step 4: Re-run the test**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/lease-broker.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/leases services/ai-gateway/test/lease-broker.test.ts
git commit -m "feat: add sticky session lease broker semantics"
```

### Task 5: Add proxy transport and token broker boundary

**Files:**
- Create: `services/ai-gateway/src/http/proxy.ts`
- Create: `services/ai-gateway/src/providers/transport.ts`
- Create: `services/ai-gateway/src/credentials/token-broker.ts`
- Create: `services/ai-gateway/test/proxy.test.ts`
- Modify: `services/ai-gateway/src/index.ts`

**Step 1: Write the failing proxy test**

Cover:

- first proxied request creates a lease
- second request on the same session reuses the binding
- upstream auth is fetched through `token-broker.ts`

**Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/proxy.test.ts
```

Expected: FAIL because no proxy route exists yet.

**Step 3: Add one provider-compatible route**

Start with:

```text
POST /v1/chat/completions
```

Keep the response shallow pass-through and hide all provider secrets behind the token broker.

**Step 4: Re-run the test**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/proxy.test.ts
```

Expected: PASS for the happy path.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/http services/ai-gateway/src/providers services/ai-gateway/src/credentials/token-broker.ts services/ai-gateway/test/proxy.test.ts services/ai-gateway/src/index.ts
git commit -m "feat: add ai gateway proxy transport"
```

### Task 6: Wire retry, rebinding, and credential health transitions through the proxy

**Files:**
- Create: `services/ai-gateway/src/credentials/health-store.ts`
- Modify: `services/ai-gateway/src/http/proxy.ts`
- Test: `services/ai-gateway/test/proxy.test.ts`

**Step 1: Extend the failing proxy test**

Add assertions for:

- refreshable auth triggers same-binding retry
- permanent credential failure triggers rebinding and one retry
- transient upstream failure does not immediately rebind

**Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/proxy.test.ts
```

Expected: FAIL on the new scenarios.

**Step 3: Implement health transitions and bounded retry rules**

Record at least:

- `healthy`
- `degraded`
- `draining`
- `unhealthy`
- `revoked`

**Step 4: Re-run the test**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/proxy.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/http/proxy.ts services/ai-gateway/src/credentials/health-store.ts services/ai-gateway/test/proxy.test.ts
git commit -m "feat: add gateway failover and credential health transitions"
```

### Task 7: Verify Slice A in Docker before moving on

**Files:**
- Modify: none (verification only)

**Step 1: Start the dev stack**

Run:

```bash
packaging/docker/dev-up.sh
```

Expected: the AI gateway service starts and its URL is printed.

**Step 2: Smoke-test the health and proxy route**

Run:

```bash
curl http://localhost:${VESLO_AI_GATEWAY_PORT:-4034}/health
```

Expected: JSON with `ok: true`.

**Step 3: Run the focused service test suite**

Run:

```bash
pnpm --filter @neatech/ai-gateway test
```

Expected: PASS for health, schema, lease, and proxy tests.

**Step 4: Commit nothing**

No commit here. This task is a slice gate.

## Slice B: Metering, Signals, and Read Models

### Task 8: Add usage event persistence and write-path tests

**Files:**
- Create: `services/ai-gateway/src/metering/usage-events.ts`
- Modify: `services/ai-gateway/src/db/schema.ts`
- Create: `services/ai-gateway/test/usage-events.test.ts`
- Modify: `services/ai-gateway/src/http/proxy.ts`

**Step 1: Write the failing usage-event test**

Cover recording of:

- `user_id`
- `org_id`
- `session_id`
- `credential_record_id`
- `credential_binding_id`
- `provider`
- `model`
- token counts

**Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/usage-events.test.ts
```

Expected: FAIL until `usage_event` exists and the proxy writes to it.

**Step 3: Add the table and write path**

Implement `recordUsageEvent()` and call it from the proxy after a successful upstream response.

**Step 4: Re-run the test**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/usage-events.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/metering services/ai-gateway/src/db/schema.ts services/ai-gateway/test/usage-events.test.ts services/ai-gateway/src/http/proxy.ts
git commit -m "feat: add usage event recording"
```

### Task 9: Add aggregated usage read models for total usage and breakdowns

**Files:**
- Create: `services/ai-gateway/src/metering/read-models.ts`
- Create: `services/ai-gateway/test/usage-read-models.test.ts`

**Step 1: Write the failing aggregation test**

Cover:

- total usage for a time window
- breakdown by credential
- breakdown by user
- breakdown by org

**Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/usage-read-models.test.ts
```

Expected: FAIL until the read-model helpers exist.

**Step 3: Implement the read-model helpers**

Expose narrow functions such as:

- `getUsageTotals(range)`
- `getUsageByCredential(range, filters)`
- `getUsageByUser(range, filters)`
- `getUsageByOrg(range, filters)`

**Step 4: Re-run the test**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/usage-read-models.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/metering/read-models.ts services/ai-gateway/test/usage-read-models.test.ts
git commit -m "feat: add usage aggregation read models"
```

### Task 10: Add incidents, credential-alert linking, and audit event storage

**Files:**
- Create: `services/ai-gateway/src/alerts/monitor.ts`
- Create: `services/ai-gateway/src/alerts/repository.ts`
- Create: `services/ai-gateway/src/audit/repository.ts`
- Modify: `services/ai-gateway/src/db/schema.ts`
- Create: `services/ai-gateway/test/incidents.test.ts`

**Step 1: Write the failing incidents test**

Cover:

- broken credential creates an incident
- incident links back to `credential_record_id`
- audit event is written for credential state changes

**Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/incidents.test.ts
```

Expected: FAIL until incident and audit persistence exists.

**Step 3: Add incident and audit tables plus monitor helpers**

Persist incident records, credential links, and audit trail events.

**Step 4: Re-run the test**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/incidents.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/alerts services/ai-gateway/src/audit services/ai-gateway/src/db/schema.ts services/ai-gateway/test/incidents.test.ts
git commit -m "feat: add incidents and audit event storage"
```

### Task 11: Expose admin JSON read endpoints before any HTML UI

**Files:**
- Create: `services/ai-gateway/src/http/admin-api.ts`
- Create: `services/ai-gateway/test/admin-api.test.ts`
- Modify: `services/ai-gateway/src/index.ts`

**Step 1: Write the failing admin API test**

Cover:

- `GET /admin/credentials`
- `GET /admin/sessions`
- `GET /admin/usage`
- `GET /admin/alerts`
- `GET /admin/audit`

Assertions should verify that payloads include totals and links already approved in the design.

**Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-api.test.ts
```

Expected: FAIL until the routes exist.

**Step 3: Implement the JSON read endpoints**

Use the metering, alert, audit, and lease read models. Do not let future UI pages query raw tables directly.

**Step 4: Re-run the test**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-api.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/http/admin-api.ts services/ai-gateway/test/admin-api.test.ts services/ai-gateway/src/index.ts
git commit -m "feat: add admin read endpoints for ai gateway"
```

### Task 12: Verify Slice B before any control-plane UI work

**Files:**
- Modify: none (verification only)

**Step 1: Run the gateway test suite**

Run:

```bash
pnpm --filter @neatech/ai-gateway test
```

Expected: PASS for data-plane and signal tests.

**Step 2: Smoke the JSON admin endpoints**

Run:

```bash
curl http://localhost:${VESLO_AI_GATEWAY_PORT:-4034}/admin/usage
curl http://localhost:${VESLO_AI_GATEWAY_PORT:-4034}/admin/alerts
```

Expected: both return structured JSON.

**Step 3: Commit nothing**

No commit here. This task is a slice gate.

## Slice C: Control Plane and User Operations

### Task 13: Extend Den with platform user directory and invite state

**Files:**
- Modify: `services/den/src/db/schema.ts`
- Modify: `services/den/src/index.ts`
- Create: `services/den/src/http/platform-users.ts`
- Create: `services/den/test/platform-users.test.ts`
- Create: `services/den/drizzle/0009_platform_invite.sql`

**Step 1: Write the failing Den test**

Cover:

- platform admin can list users and org memberships
- platform admin can create invite state for a new email
- platform admin can toggle platform-admin status
- non-platform admin is forbidden

**Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/platform-users.test.ts
```

Expected: FAIL until the router and persistence exist.

**Step 3: Add the invite schema and platform-user router**

Implement endpoints for:

- `GET /platform/users`
- `POST /platform/invites`
- `PATCH /platform/users/:userId`
- `POST /platform/users/:userId/platform-admin`
- `DELETE /platform/users/:userId/platform-admin`

**Step 4: Re-run the test**

Run:

```bash
pnpm --filter @neatech/den test
```

Expected: PASS with the new platform-user coverage included.

**Step 5: Commit**

```bash
git add services/den/src/db/schema.ts services/den/src/index.ts services/den/src/http/platform-users.ts services/den/test/platform-users.test.ts services/den/drizzle/0009_platform_invite.sql
git commit -m "feat(den): add platform user directory and invites"
```

### Task 14: Add platform-admin auth boundary for the gateway control plane

**Files:**
- Create: `services/ai-gateway/src/admin/auth.ts`
- Create: `services/ai-gateway/test/admin-auth.test.ts`
- Modify: `services/ai-gateway/src/index.ts`

**Step 1: Write the failing auth test**

Cover:

- platform admin can access `/admin`
- non-platform admin receives `403`
- admin JSON endpoints share the same gate

**Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-auth.test.ts
```

Expected: FAIL until the auth middleware exists.

**Step 3: Implement the auth boundary**

Have the gateway trust Den-backed user context instead of inventing a second role model.

**Step 4: Re-run the test**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-auth.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/admin/auth.ts services/ai-gateway/test/admin-auth.test.ts services/ai-gateway/src/index.ts
git commit -m "feat: gate ai gateway control plane to platform admins"
```

### Task 15: Build the control-plane shell and shared layout

**Files:**
- Create: `services/ai-gateway/src/admin/layout.ts`
- Create: `services/ai-gateway/src/admin/routes.ts`
- Create: `services/ai-gateway/src/admin/pages/overview.ts`
- Create: `services/ai-gateway/public/admin.css`
- Create: `services/ai-gateway/test/admin-shell.test.ts`
- Modify: `services/ai-gateway/src/index.ts`

**Step 1: Write the failing shell test**

Assert:

- `GET /admin` renders the overview shell
- navigation includes `Credentials`, `Sessions`, `Usage`, `Alerts`, `Users`, `Audit`

**Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-shell.test.ts
```

Expected: FAIL until the HTML shell exists.

**Step 3: Add the shared layout and route registration**

Keep it internal and utilitarian; use the JSON admin endpoints as the data source.

**Step 4: Re-run the test**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-shell.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/admin services/ai-gateway/public/admin.css services/ai-gateway/test/admin-shell.test.ts services/ai-gateway/src/index.ts
git commit -m "feat: add ai gateway control plane shell"
```

### Task 16: Implement Credentials, Alerts, Usage, and Sessions pages

**Files:**
- Create: `services/ai-gateway/src/admin/pages/credentials.ts`
- Create: `services/ai-gateway/src/admin/pages/alerts.ts`
- Create: `services/ai-gateway/src/admin/pages/usage.ts`
- Create: `services/ai-gateway/src/admin/pages/sessions.ts`
- Create: `services/ai-gateway/test/admin-operations-pages.test.ts`
- Modify: `services/ai-gateway/src/admin/routes.ts`

**Step 1: Write the failing page test**

Assert:

- `Credentials` page shows active alert links per credential
- `Alerts` page shows selected incident actions
- `Usage` page defaults to total usage and offers filters for credential, user, and org
- `Sessions` page shows active binding and rebinding context

**Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-operations-pages.test.ts
```

Expected: FAIL until the pages exist.

**Step 3: Implement the pages**

Keep all data reads behind the JSON read endpoints from Slice B.

**Step 4: Re-run the test**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-operations-pages.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/admin/pages services/ai-gateway/test/admin-operations-pages.test.ts services/ai-gateway/src/admin/routes.ts
git commit -m "feat: add credential, alert, usage, and session admin pages"
```

### Task 17: Implement Users and Audit pages with selected-user editing

**Files:**
- Create: `services/ai-gateway/src/admin/pages/users.ts`
- Create: `services/ai-gateway/src/admin/pages/audit.ts`
- Create: `services/ai-gateway/test/admin-users-audit-pages.test.ts`
- Modify: `services/ai-gateway/src/admin/routes.ts`

**Step 1: Write the failing page test**

Assert:

- `Users` page shows a directory list and selected-user detail panel
- create-user action is rendered separately from the selected-user editor
- selected-user panel exposes save, disable, and guarded delete actions
- `Audit` page shows filters plus changed-field detail

**Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-users-audit-pages.test.ts
```

Expected: FAIL until the pages exist.

**Step 3: Implement the pages and hook them to Den-backed user actions**

Route user actions through Den platform-user endpoints rather than mutating user state directly inside the UI renderer.

**Step 4: Re-run the test**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-users-audit-pages.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/admin/pages/users.ts services/ai-gateway/src/admin/pages/audit.ts services/ai-gateway/test/admin-users-audit-pages.test.ts services/ai-gateway/src/admin/routes.ts
git commit -m "feat: add users and audit control plane pages"
```

### Task 18: Verify the full system through Docker, Chrome MCP, and screenshots

**Files:**
- Modify: documentation or evidence files only if needed for screenshots/notes

**Step 1: Bring up the full dev stack**

Run:

```bash
packaging/docker/dev-up.sh
```

Expected: Den and the AI gateway are both available.

**Step 2: Verify end-to-end flows**

Verify at minimum:

- proxy request creates and reuses a session lease
- broken credential generates an incident linked to the credential
- usage can be queried by total, credential, user, and org
- platform admin can open the control plane
- selected user can be edited, disabled, and guarded for deletion

**Step 3: Capture screenshots**

Capture:

- credentials page with incident linkage
- usage page with breakdown controls
- users page with selected-user detail panel

Store them under the repo’s docs/pr evidence location if required by the branch workflow.

**Step 4: Run the final relevant tests**

Run:

```bash
pnpm --filter @neatech/ai-gateway test
pnpm --filter @neatech/den test
```

Expected: PASS.

**Step 5: Commit final polish**

```bash
git add .
git commit -m "feat: ship ai gateway control plane"
```
