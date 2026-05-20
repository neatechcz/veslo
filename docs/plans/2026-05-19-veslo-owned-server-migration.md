# Veslo Owned Server Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move Veslo cloud services from Render/Vercel-hosted infrastructure to the owned Ubuntu server at `62.109.146.43` / `app.veslo.work`, while preserving auth, data, managed-AI access, feedback, and rollback safety.

**Architecture:** First migrate stable control-plane services into a Docker Compose production stack on the owned server: Den, Den MySQL, AI Gateway, AI Gateway MySQL, Veslo web, reverse proxy, TLS, logs, and backups. Keep Render worker provisioning temporarily for the first service cutover, then add a server-local worker provisioner as a separate phase so cloud workers can move off Render without coupling that work to the initial database/auth migration.

**Tech Stack:** Ubuntu 24.04, Docker Compose, Caddy or Traefik, MySQL 8.4, Node 22, pnpm 10.27.0, Express, Next.js, Drizzle migrations, GitHub Actions or SSH-based deploy scripts.

---

## Current Facts

- The new server is reachable over VPN via `neatech@62.109.146.43`.
- The server hostname is `neatech-veslo.cust.webglobe.com`.
- OS is Ubuntu 24.04.4 LTS.
- Disk is approximately 48 GB with about 45 GB free.
- Memory is approximately 31 GiB with no swap configured.
- Docker and Docker Compose are installed.
- The `neatech` user cannot currently access `/var/run/docker.sock` directly.
- `sudo docker ps` works and is the current server-side Docker execution path.
- General `sudo -n true` still fails, so do not assume unrestricted non-interactive sudo.
- Port 22 is reachable.
- Ports 80 and 443 were refusing connections at the time of inspection.
- `app.veslo.work` resolved to `62.109.146.43` once VPN was connected.
- `api.veslo.work` and `ai.veslo.work` also resolve to `62.109.146.43`.
- Lettr API is reachable from the server over outbound HTTPS; direct SMTP is not required for Veslo auth email.
- No Caddy or nginx reverse proxy was installed at the time of inspection.
- Node, npm, pnpm, Corepack, MySQL client, and `mysqldump` were not installed on the host at the time of inspection. The production plan should not depend on host Node tooling when Docker can provide the runtime.

## Migration Policy

Do not switch production traffic until all dark-launch checks pass. Do not remove Render services until the owned-server stack has handled real production traffic for a defined observation window and a final data parity check confirms no active writes remain on Render.

The first production cutover should move Den, AI Gateway, web, data, auth callbacks, managed-AI policy, feedback projection, and debug-log ingest. Render worker provisioning can remain temporarily enabled through Den until the server-local worker provisioner is built and verified.

## Execution Rules

- Each phase must end in its own commit, or multiple commits when a phase contains separate logical chunks.
- Each phase must include a verification gate before it can be marked complete.
- Code phases use tests, builds, and focused smoke checks.
- Infrastructure phases use smoke checks and recorded command evidence when unit tests do not apply.
- The verification result for each phase must be recorded in `docs/plans/assets/owned-server-migration/verification-log.md` or a phase-specific runbook/checklist.
- Server-side Docker commands use `sudo docker ...` and `sudo docker compose ...` unless maintainers later grant direct Docker access.
- No production DNS/live-traffic redirect is allowed before Phase 5.
- Render remains available for rollback until the observation window closes and decommission is explicitly approved.

## Domain Plan

Recommended domains:

- `app.veslo.work` for the Veslo web app and desktop onboarding browser flow.
- `api.veslo.work` for Den.
- `ai.veslo.work` for AI Gateway.
- `admin.veslo.work` only if admin needs a separate origin; otherwise keep admin under Den and AI Gateway paths.
- `*.workers.veslo.work` for later server-local workers.

Alternative low-risk cutover:

- Keep existing production public domains and repoint DNS to the owned server.
- Use `app.veslo.work`, `api.veslo.work`, and `ai.veslo.work` as staging names first.

## Phase 0: Server Maintainer Prerequisites

Ask the server maintainers to confirm:

- Production deployment may use `sudo docker ...` from the `neatech` account, or maintainers will provide another documented setup path.
- `neatech` can be added to the `docker` group later if maintainers prefer direct Docker access, but direct Docker access is no longer required for the first implementation pass.
- Ports 80 and 443 can be opened publicly.
- DNS for `veslo.work` can add `app`, `api`, `ai`, and later wildcard worker records.
- Docker Compose production workloads are allowed by the hoster.
- Outbound HTTPS/API traffic is unrestricted.
- Lettr outbound HTTPS remains allowed. Direct SMTP is not required because auth email delivery uses Lettr.
- Disk can be expanded if database/log/worker data grows.
- Backup, firewall, OS patching, and monitoring ownership is clear.
- No-swap operation is acceptable, or maintainers approve adding swap.

The durable prerequisites record lives in `docs/dev/cloud-deployments.md` under "Owned server production host prerequisites". Keep that section synchronized with this migration plan before each production infrastructure phase.

Proceed only after these answers are known.

### Task 1: Record Server Access Requirements

**Files:**
- Modify: `docs/dev/cloud-deployments.md`
- Modify: `docs/plans/2026-05-19-veslo-owned-server-migration.md`
- Modify: `docs/plans/assets/owned-server-migration/verification-log.md`

**Step 1: Add an owned-server prerequisites section**

Add a section to `docs/dev/cloud-deployments.md` documenting the minimum production host requirements:

- Ubuntu 24.04 or compatible Linux.
- Docker Compose.
- Runtime user with either direct Docker access or validated `sudo docker` access.
- Public 80/443.
- Off-server backup target.
- DNS control.
- Required outbound HTTPS access, including Lettr.

**Step 2: Verify docs mention the server prerequisites**

Run locally:

```bash
rg -n "owned server|Docker Compose|80|443|backup|DNS" docs/dev/cloud-deployments.md docs/plans/2026-05-19-veslo-owned-server-migration.md
```

Expected: both docs include the prerequisite language.

**Step 3: Commit**

Run:

```bash
git add docs/dev/cloud-deployments.md docs/plans/2026-05-19-veslo-owned-server-migration.md docs/plans/assets/owned-server-migration/verification-log.md
git commit -m "docs: record owned server migration prerequisites"
```

## Phase 1: Production Compose Stack

The first implementation artifact should be a repo-owned production deployment template. Do not hand-edit production containers directly on the server as the source of truth.

Recommended layout:

- `packaging/owned-server/compose.yml`
- `packaging/owned-server/Caddyfile`
- `packaging/owned-server/env.example`
- `packaging/owned-server/README.md`
- `packaging/owned-server/scripts/render-env-snapshot.md` or equivalent operator notes

### Task 2: Add Owned-Server Compose Skeleton

**Files:**
- Create: `packaging/owned-server/compose.yml`
- Create: `packaging/owned-server/Caddyfile`
- Create: `packaging/owned-server/env.example`
- Create: `packaging/owned-server/README.md`
- Test: `packaging/owned-server/README.md`

**Step 1: Write the deployment contract in README**

Document:

- required env vars,
- how secrets are provided,
- expected domains,
- persistent volumes,
- backup expectations,
- startup command,
- health-check command,
- explicit `sudo docker compose` command examples,
- rollback note.

**Step 2: Add Compose services**

Add services:

- `den-db`, MySQL 8.4, persistent volume.
- `ai-gateway-db`, MySQL 8.4, persistent volume.
- `den`, Node 22 build/runtime.
- `ai-gateway`, Node 22 build/runtime.
- `web`, Next.js build/runtime.
- `proxy`, Caddy or Traefik.

Do not expose MySQL publicly. Only expose proxy ports 80/443.

**Step 3: Add proxy routes**

Route:

- `api.veslo.work` to Den on container port 8788.
- `ai.veslo.work` to AI Gateway on container port 4034.
- `app.veslo.work` to web on container port 3005.

**Step 4: Add env example**

Include every env key needed by:

- `services/den/src/env.ts`
- `services/ai-gateway/src/env.ts`
- `packages/web/README.md`

Use placeholders only. Do not put secrets in git.

**Step 5: Validate Compose syntax locally**

Run locally:

```bash
docker compose -f packaging/owned-server/compose.yml config
```

Expected: Compose renders without syntax errors.

Run on the server after the files are deployed:

```bash
sudo docker compose -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/staging.env config
```

Expected: Compose renders without syntax errors on the target host.

**Step 6: Commit**

Run:

```bash
git add packaging/owned-server
git commit -m "infra: add owned server compose skeleton"
```

### Task 3: Add Production Build Commands

**Files:**
- Modify: `packaging/owned-server/compose.yml`
- Modify: `packaging/owned-server/README.md`
- Test: `services/den/package.json`
- Test: `services/ai-gateway/package.json`
- Test: `packages/web/package.json`

**Step 1: Confirm service build commands**

Run:

```bash
pnpm --filter @neatech/den build
pnpm --filter @neatech/ai-gateway build
pnpm --filter @neatech/veslo-web build
```

Expected: all services build locally.

**Step 2: Wire build commands into containers**

For each app service:

- install dependencies through Corepack and pnpm,
- run service-specific build,
- start with the existing package start script.

**Step 3: Add health checks**

Use:

- Den: `GET /health`
- AI Gateway: `GET /health`
- Web: HTTP check on `/`

**Step 4: Validate with local Compose config**

Run locally:

```bash
docker compose -f packaging/owned-server/compose.yml config
```

Expected: config renders and includes health checks.

Run on the server after the files are deployed:

```bash
sudo docker compose -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/staging.env config
```

Expected: config renders and includes health checks on the target host.

**Step 5: Commit**

Run:

```bash
git add packaging/owned-server/compose.yml packaging/owned-server/README.md
git commit -m "infra: wire owned server production builds"
```

## Phase 2: Environment and Secret Inventory

The migration depends on preserving the same auth and encryption secrets where state continuity matters.

### Task 4: Create Production Env Mapping

**Files:**
- Create: `docs/plans/assets/owned-server-migration/env-inventory.md`
- Modify: `packaging/owned-server/env.example`

**Step 1: Document required Den env**

Include:

- `DATABASE_URL`
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_URL`
- `WORKER_TOKEN_ENCRYPTION_KEY`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `LETTR_API_KEY`
- `AUTH_EMAIL_ADDRESS`
- `AUTH_EMAIL_FROM_NAME`
- `DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED`
- `CORS_ORIGINS`
- `PROVISIONER_MODE`
- `RENDER_*` values for temporary worker provisioning
- `VERCEL_*` values if temporary vanity worker domains remain enabled
- `POLAR_*` values if paywall remains enabled
- `YOUTRACK_*`
- `DEN_LOG_*`
- `MANAGED_AI_*`

**Step 2: Document required AI Gateway env**

Include:

- `AI_GATEWAY_DATABASE_URL`
- `AI_GATEWAY_SECRET_KEY`
- `AI_GATEWAY_OPENAI_CLIENT_ID`
- `AI_GATEWAY_OPENAI_CLIENT_SECRET`
- `AI_GATEWAY_OPENAI_REDIRECT_BASE`
- `AI_GATEWAY_DEN_API_BASE`
- `AI_GATEWAY_CODEX_*`

**Step 3: Document required web env**

Include:

- `DEN_API_BASE`
- `DEN_AUTH_ORIGIN`
- `NEXT_PUBLIC_OPENWORK_APP_CONNECT_URL`
- `NEXT_PUBLIC_OPENWORK_AUTH_CALLBACK_URL`
- `NEXT_PUBLIC_POSTHOG_KEY`
- `NEXT_PUBLIC_POSTHOG_HOST`
- `LOOPS_API_KEY`

**Step 4: Verify all known env names are covered**

Run:

```bash
rg -n "DATABASE_URL|BETTER_AUTH|MANAGED_AI|AI_GATEWAY|YOUTRACK|POLAR|RENDER|VERCEL|DEN_LOG|DEN_API_BASE|DEN_AUTH_ORIGIN" docs/plans/assets/owned-server-migration/env-inventory.md packaging/owned-server/env.example
```

Expected: every migration-relevant env family is listed.

**Step 5: Commit**

Run:

```bash
git add docs/plans/assets/owned-server-migration/env-inventory.md packaging/owned-server/env.example
git commit -m "docs: map owned server production environment"
```

## Phase 3: Database Migration Rehearsal

Run a rehearsal before production cutover. Use a fresh dump copy, not the live production database, for the first restore.

### Task 5: Add Database Backup and Restore Runbook

**Files:**
- Create: `packaging/owned-server/backup/README.md`
- Create: `packaging/owned-server/backup/backup-mysql.sh`
- Create: `packaging/owned-server/backup/restore-mysql.sh`
- Modify: `packaging/owned-server/README.md`

**Step 1: Document backup policy**

Include:

- daily automated backups,
- before-cutover manual backup,
- off-server storage target,
- encryption requirement,
- restore test cadence.

**Step 2: Add backup script**

The script should accept:

- database service name,
- database name,
- output path.

It should use `mysqldump` through `docker compose exec` or a temporary MySQL client container.

**Step 3: Add restore script**

The script should accept:

- database service name,
- database name,
- input dump path.

It must print a clear warning and require an explicit confirmation flag such as `--apply`.

**Step 4: Validate scripts are syntactically valid**

Run:

```bash
bash -n packaging/owned-server/backup/backup-mysql.sh
bash -n packaging/owned-server/backup/restore-mysql.sh
```

Expected: both commands exit 0.

**Step 5: Commit**

Run:

```bash
git add packaging/owned-server/backup packaging/owned-server/README.md
git commit -m "infra: add owned server database backup runbook"
```

### Task 6: Rehearse Restore on the Owned Server

**Files:**
- Modify: `docs/plans/assets/owned-server-migration/verification-log.md`
- Create or modify: `packaging/owned-server/env.staging.example`
- Create or modify: `packaging/owned-server/rehearsal/README.md`

**Step 1: Confirm server Docker access through the approved path**

Run on the server:

```bash
docker ps
```

Expected: direct Docker access may fail for `neatech`. When it fails with Docker socket permission denied, run:

```bash
sudo docker ps
```

Expected: `sudo docker ps` works. Continue with `sudo docker ...` and `sudo docker compose ...` unless maintainers later grant direct Docker access.

**Step 2: Deploy isolated staging databases**

Use staging env values and a separate Compose project so rehearsal volumes cannot collide with production volumes. Start only databases before restore and migration. Do not start the public reverse proxy during the database rehearsal. If `/srv/veslo` cannot be created with general sudo, use a user-owned rehearsal directory and pass that env path consistently to `--env-file` and `ENV_FILE`.

Run on the server:

```bash
sudo docker compose -p veslo-owned-server-staging -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/staging.env up -d den-db ai-gateway-db
```

Expected: `den-db` and `ai-gateway-db` start and become healthy. `den`, `ai-gateway`, `web`, and `proxy` are not started yet, and ports 80/443 are not bound.

**Step 3: Restore a non-production dump copy or approved synthetic dump**

Run the restore script with `--apply` against staging DB volumes.

Expected: Den and AI Gateway databases contain copied rows. If no real non-production dump is available, use the synthetic fallback in `packaging/owned-server/rehearsal/README.md` only after recording that the result validates restore mechanics but not production-data compatibility.

**Step 4: Run migrations**

Build the app images, then run migrations in one-off app containers before starting the long-lived app services:

```bash
sudo docker compose -p veslo-owned-server-staging -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/staging.env build den ai-gateway
sudo docker compose -p veslo-owned-server-staging -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/staging.env run --rm --no-deps den pnpm --filter @neatech/den db:migrate
sudo docker compose -p veslo-owned-server-staging -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/staging.env run --rm --no-deps ai-gateway pnpm --filter @neatech/ai-gateway db:migrate
```

Expected: migrations complete without schema errors.

**Step 5: Start staging app services**

Run:

```bash
sudo docker compose -p veslo-owned-server-staging -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/staging.env up -d den ai-gateway
```

Expected: `den`, `ai-gateway`, and both databases are healthy. `web` and `proxy` are not started, and ports 80/443 are not bound.

**Step 6: Record rehearsal result**

Write the date, dump source, restore target, migration result, backup result, teardown result, and any issues into `docs/plans/assets/owned-server-migration/verification-log.md`.

**Step 7: Commit**

Run:

```bash
git add docs/plans/assets/owned-server-migration/verification-log.md packaging/owned-server/env.staging.example packaging/owned-server/rehearsal/README.md packaging/owned-server/README.md packaging/owned-server/backup/README.md docs/plans/2026-05-19-veslo-owned-server-migration.md
git commit -m "docs: record owned server database rehearsal"
```

## Phase 4: Dark Launch Verification

Dark launch means the owned server is fully running but production DNS and production clients still use the old deployment.

### Task 7: Verify Service Health

**Files:**
- Modify: `docs/plans/assets/owned-server-migration/verification-log.md`

**Step 1: Check Den health**

Run:

```bash
curl -fsS https://api.veslo.work/health
```

Expected:

```json
{"ok":true}
```

**Step 2: Check AI Gateway health**

Run:

```bash
curl -fsS https://ai.veslo.work/health
```

Expected:

```json
{"ok":true,"service":"ai-gateway"}
```

**Step 3: Check web app**

Run:

```bash
curl -I https://app.veslo.work
```

Expected: HTTP 200 or a valid Next.js response.

**Step 4: Record health evidence**

Add sanitized command results to the verification log.

**Step 5: Commit**

Run:

```bash
git add docs/plans/assets/owned-server-migration/verification-log.md
git commit -m "docs: record owned server health verification"
```

### Task 8: Verify Auth and Desktop Handoff

**Files:**
- Modify: `docs/plans/assets/owned-server-migration/verification-log.md`

**Step 1: Start desktop auth against staging Den**

Use the desktop Den API override or a test build with `VITE_DEN_API_BASE=https://api.veslo.work`.

**Step 2: Sign in through browser onboarding**

Expected:

- browser auth opens on the owned-server app/domain,
- desktop receives credentials,
- desktop auth snapshot stores the owned-server Den API base,
- `/v1/me` returns the signed-in user and org.

**Step 3: Verify existing sessions still load**

Expected: user/org/session metadata loads from the restored Den database.

**Step 4: Record result**

Add auth result and any required OAuth callback configuration changes to the verification log.

**Step 5: Commit**

Run:

```bash
git add docs/plans/assets/owned-server-migration/verification-log.md
git commit -m "docs: record owned server auth verification"
```

### Task 9: Verify Managed AI

**Files:**
- Modify: `docs/plans/assets/owned-server-migration/verification-log.md`

**Step 1: Point a desktop runtime at the owned-server managed-AI base**

Set:

```bash
VESLO_MANAGED_AI_BASE_URL=https://ai.veslo.work
```

**Step 2: Check AI access policy**

Expected:

- policy loads for the signed-in user,
- assigned provider/model is present,
- gateway token is issued.

**Step 3: Run one small managed-AI request**

Use a test session and a minimal prompt.

Expected:

- request succeeds,
- usage row is recorded,
- no provider secret reaches the desktop.

**Step 4: Record result**

Add model/provider, status, and sanitized request id to the verification log.

**Step 5: Commit**

Run:

```bash
git add docs/plans/assets/owned-server-migration/verification-log.md
git commit -m "docs: record owned server managed-ai verification"
```

### Task 10: Verify Feedback and Debug Logs

**Files:**
- Modify: `docs/plans/assets/owned-server-migration/verification-log.md`

**Step 1: Verify feedback-to-YouTrack**

Submit a test feedback report against owned-server Den.

Expected:

- `POST /v1/feedback` returns a YouTrack issue id,
- issue exists in YouTrack,
- Den stores the `youtrackIssueId`.

**Step 2: Verify debug-log ingest**

Configure a test `veslo-server` with:

```bash
VESLO_LOG_INGEST_URL=https://api.veslo.work/v1/internal/debug-logs
VESLO_LOG_INGEST_TOKEN=<staging-token>
```

Expected: Den accepts a batch and admin debug-log read APIs can find it.

**Step 3: Record result**

Add sanitized issue id and debug-log batch id to the verification log.

**Step 4: Commit**

Run:

```bash
git add docs/plans/assets/owned-server-migration/verification-log.md
git commit -m "docs: record owned server feedback and log verification"
```

## Phase 5: Production Cutover

This phase needs a maintenance window. Do not run it until the dark launch passes.

This is the only phase where live traffic is redirected. The redirect happens after the final production database restore and owned-server production stack startup, then before post-cutover smoke checks. If any pre-redirect check fails, do not switch DNS.

Required pre-cutover gates:

- Phase 1 production Compose stack exists and renders on the target server.
- Phase 2 env and secrets inventory has been reviewed.
- Phase 3 database restore rehearsal has passed.
- Phase 4 dark launch has passed for health, auth, managed AI, feedback, debug-log ingest, and backups.
- DNS rollback path is documented.
- Maintenance window is approved.
- Render rollback target remains available.

### Task 11: Prepare Cutover Checklist

**Files:**
- Create: `docs/plans/assets/owned-server-migration/cutover-checklist.md`

**Step 1: Create checklist sections**

Include:

- pre-window checks,
- final Render DB backup,
- final owned-server restore,
- migration commands,
- DNS changes,
- post-cutover checks,
- rollback decision point,
- Render freeze/decommission conditions.

**Step 2: Include exact rollback path**

Rollback should be:

- repoint DNS to Render,
- keep owned-server stack running for forensic comparison,
- avoid deleting restored data,
- document whether any writes landed on the owned server before rollback.

**Step 3: Commit**

Run:

```bash
git add docs/plans/assets/owned-server-migration/cutover-checklist.md
git commit -m "docs: add owned server cutover checklist"
```

### Task 12: Execute Production Cutover

**Files:**
- Modify: `docs/plans/assets/owned-server-migration/verification-log.md`

**Step 1: Announce maintenance window**

Expected: no active deploys or expected production worker launches during the window.

**Step 2: Lower DNS TTL**

Expected: DNS records have low TTL before the final switch.

**Step 3: Pause or freeze old write path**

Prefer stopping public writes to Render Den during final backup. If a full freeze is not possible, record the exact residual-write risk.

**Step 4: Take final Render database dump**

Expected: final Den and AI Gateway dumps are complete and checksummed.

**Step 5: Restore final dumps to owned server**

Expected: restore succeeds and migrations complete.

**Step 6: Start production stack**

Run on the server:

```bash
sudo docker compose -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/production.env up -d
```

Expected: all services healthy.

**Step 7: Redirect live traffic by switching DNS**

Point production DNS records to `62.109.146.43`.

Expected: public traffic for the selected production domains resolves to the owned server. This is the live-traffic redirect point.

**Step 8: Run post-cutover verification**

Run the same checks from Tasks 7 through 10 against production domains.

**Step 9: Record result**

Record cutover start/end time, DNS records changed, final dump checksums, and verification results.

**Step 10: Commit**

Run:

```bash
git add docs/plans/assets/owned-server-migration/verification-log.md
git commit -m "docs: record owned server production cutover"
```

## Phase 6: Replace Render Worker Provisioning

This phase removes the largest remaining Render dependency. It should be built after the core stack is stable.

Recommended architecture:

- Add a small worker manager service on the owned server.
- Den calls the worker manager over an internal authenticated HTTP API.
- The worker manager owns Docker operations instead of exposing Docker directly to Den.
- Each worker runs as a container executing `veslo-orchestrator`.
- Each worker has a dedicated volume, token env, health check, resource limits, and lifecycle labels.
- Worker public URLs use wildcard DNS/TLS under `*.workers.veslo.work`.

### Task 13: Design the Server-Local Worker Provisioner

**Files:**
- Create: `docs/plans/2026-05-19-owned-server-worker-provisioner-design.md`
- Modify: `docs/dev/cloud-deployments.md`

**Step 1: Document provisioner contract**

Define:

- `POST /workers`
- `GET /workers/:id`
- `DELETE /workers/:id`
- internal auth,
- Docker labels,
- health check semantics,
- suspend/delete behavior,
- URL allocation.

**Step 2: Document Den changes**

Den should gain a provisioner mode such as `owned-server` or `docker-manager`, while keeping `render` until migration is complete.

**Step 3: Commit**

Run:

```bash
git add docs/plans/2026-05-19-owned-server-worker-provisioner-design.md docs/dev/cloud-deployments.md
git commit -m "docs: design owned server worker provisioner"
```

### Task 14: Implement and Verify Worker Provisioner

**Files:**
- Create: `services/worker-manager/package.json`
- Create: `services/worker-manager/src/index.ts`
- Create: `services/worker-manager/src/docker.ts`
- Create: `services/worker-manager/test/*.test.ts`
- Modify: `services/den/src/env.ts`
- Modify: `services/den/src/workers/provisioner.ts`
- Test: `services/den/test/render-provisioner.test.ts`
- Test: `services/den/test/owned-server-provisioner.test.ts`
- Modify: `packaging/owned-server/compose.yml`
- Modify: `packaging/owned-server/Caddyfile`

**Step 1: Write Den provisioner tests**

Expected: FAIL because the owned-server provisioner does not exist.

**Step 2: Write worker manager tests**

Mock Docker operations:

- create worker container,
- detect health,
- stop/delete worker,
- reject unauthorized internal calls.

Expected: FAIL because worker manager does not exist.

**Step 3: Implement worker manager**

Implement minimal HTTP API, Docker command adapter, auth middleware, and health response.

**Step 4: Implement Den owned-server provisioner**

Add env:

- `OWNED_WORKER_MANAGER_URL`
- `OWNED_WORKER_MANAGER_TOKEN`
- `OWNED_WORKER_PUBLIC_DOMAIN_SUFFIX`

Add `PROVISIONER_MODE=owned-server`.

**Step 5: Wire Compose**

Add worker manager service and route wildcard worker domains through the proxy.

**Step 6: Verify locally**

Run:

```bash
pnpm --filter @neatech/den test
pnpm --filter @neatech/worker-manager test
docker compose -f packaging/owned-server/compose.yml config
```

Expected: tests and Compose config pass.

**Step 7: Verify on server staging**

Create and delete one test cloud worker through Den.

Expected:

- Den returns a worker URL under the owned-server worker domain.
- Worker `/health` responds.
- Delete stops or removes the container.

**Step 8: Commit**

Run:

```bash
git add services/worker-manager services/den packaging/owned-server docs/dev/cloud-deployments.md
git commit -m "feat: add owned server worker provisioner"
```

## Phase 7: Render Decommission

Only start after owned-server workers are live or the product decision is to disable cloud workers.

### Task 15: Remove Render From Production Runtime

**Files:**
- Modify: `.github/workflows/deploy-den.yml`
- Modify: `.github/workflows/deploy-ai-gateway.yml`
- Modify: `docs/dev/cloud-deployments.md`
- Modify: `services/den/README.md`
- Modify: `packaging/owned-server/README.md`

**Step 1: Update deploy docs**

Document owned-server deployment as the production path.

**Step 2: Disable Render deployment workflows**

Either:

- remove production deploy behavior, or
- mark workflows as legacy/manual Render-only diagnostics.

**Step 3: Remove production Render env expectations**

Do not delete `render` provisioner code until all compatibility needs are decided. First remove it from production docs and env templates.

**Step 4: Verify no production docs point operators to Render**

Run:

```bash
rg -n "Render|onrender|RENDER_" docs/dev services/den/README.md packaging/owned-server .github/workflows
```

Expected: remaining matches are explicitly marked as legacy, temporary, or worker-provisioner compatibility.

**Step 5: Commit**

Run:

```bash
git add .github/workflows docs/dev services/den/README.md packaging/owned-server/README.md
git commit -m "docs: make owned server the production deploy path"
```

### Task 16: Shutdown Render Services

**Files:**
- Modify: `docs/plans/assets/owned-server-migration/verification-log.md`

**Step 1: Confirm no production writes on Render**

Compare:

- latest Den rows,
- latest AI Gateway usage rows,
- active worker list,
- DNS records,
- app/desktop configured bases.

**Step 2: Export final Render snapshots**

Keep final dumps and env snapshots in secure off-repo storage.

**Step 3: Disable or suspend Render services**

Do this from Render dashboard/API only after rollback window expires.

**Step 4: Rotate secrets**

Rotate secrets that were exposed to Render and are no longer required there.

**Step 5: Record decommission evidence**

Record date, services suspended, secrets rotated, and backup location reference in the verification log.

**Step 6: Commit**

Run:

```bash
git add docs/plans/assets/owned-server-migration/verification-log.md
git commit -m "docs: record Render decommission"
```

## Final Acceptance Criteria

- Production Den responds from the owned server.
- Production AI Gateway responds from the owned server.
- Production web app responds from the owned server.
- Desktop auth works against the owned-server Den API.
- Existing users, orgs, sessions, managed-AI assignments, credentials, and usage state survive migration.
- Managed-AI request succeeds through the owned-server AI Gateway.
- Feedback creates/reuses YouTrack issues through owned-server Den.
- Debug-log ingest works through owned-server Den.
- Backups are automated, encrypted, stored off-server, and restore-tested.
- Render is no longer required for Den, AI Gateway, or web.
- Render is no longer required for cloud workers after Phase 6.
- Rollback path is documented until the decommission window closes.

## Open Decisions

- Whether first production cutover keeps existing public domains or switches users directly to `*.veslo.work`.
- Whether the existing desktop default Den API base should change in a release before cutover.
- Whether AI Gateway remains a separate public service or Den fully owns managed-AI runtime in this migration.
- Whether cloud workers must be migrated immediately or can remain on Render temporarily.
- Whether worker storage needs durable per-worker volumes or can remain ephemeral.
- Which off-server backup target will be used.
- Who owns OS patching, firewall policy, and uptime monitoring.
