# Owned Server Dark Launch Runbook

This runbook is the Phase 4 entry path for VSLO-185. Use it only after the
database restore rehearsal has passed and before the Phase 5 production traffic
redirect.

Dark launch means the owned-server stack is running with production-equivalent
configuration and restored data, but existing production clients still use the
old deployment.

## Safety Rules

- Do not use synthetic dumps for Phase 4. Synthetic data is valid only for the
  Phase 3 restore-mechanics rehearsal.
- Do not start `proxy` until Den, AI Gateway, web, migrations, and restored data
  are verified.
- Do not redirect live production traffic during Phase 4.
- Keep Render and existing hosted services available for rollback.
- Record sanitized command results in the migration verification log before
  marking any Phase 4 task complete.

## Required Inputs

The operator needs these inputs before starting:

- A server checkout at the intended release commit.
- A completed owned-server env file outside the repo.
- A Den database dump from the current source environment.
- An AI Gateway database dump from the current source environment.
- Continuity secrets from the current services, including auth/session,
  worker-token encryption, managed-AI, debug-log, OAuth, YouTrack, and Lettr
  values.
- DNS for `api.veslo.work`, `ai.veslo.work`, and `app.veslo.work` pointing at
  the owned server.
- Public inbound ports 80 and 443 open on the server and upstream firewall.
- Outbound HTTPS allowed for Lettr, YouTrack, GitHub, Render, Vercel, Polar, and
  provider APIs used by managed AI.

If any required input is missing, do not start the public proxy. Record the
blocker and stop.

## Paths

Default production examples use these paths:

```bash
export VESLO_ENV_FILE=/srv/veslo/env/production.env
export VESLO_DUMP_DIR=/srv/veslo/dumps
```

If general sudo is not available for `/srv/veslo`, use a user-owned input
directory and pass the env file explicitly:

```bash
export VESLO_ENV_FILE=/home/neatech/veslo-owned-server-dark-launch-inputs/env/production.env
export VESLO_DUMP_DIR=/home/neatech/veslo-owned-server-dark-launch-inputs/dumps
```

## Preflight

Run on the server from the release checkout:

```bash
sudo docker ps
sudo docker compose -f packaging/owned-server/compose.yml --env-file "$VESLO_ENV_FILE" config --quiet
```

Expected:

- Docker is available through `sudo docker`.
- Compose renders without unresolved env or syntax errors.
- No unrelated Veslo production containers are running.

## Restore and Migrate

Start only databases first:

```bash
sudo docker compose -f packaging/owned-server/compose.yml --env-file "$VESLO_ENV_FILE" up -d den-db ai-gateway-db
```

Restore real dumps:

```bash
ENV_FILE="$VESLO_ENV_FILE" packaging/owned-server/backup/restore-mysql.sh --apply den-db den "$VESLO_DUMP_DIR/den-production.sql"
ENV_FILE="$VESLO_ENV_FILE" packaging/owned-server/backup/restore-mysql.sh --apply ai-gateway-db veslo_ai_gateway "$VESLO_DUMP_DIR/ai-gateway-production.sql"
```

Build and run migrations before starting long-lived app containers:

```bash
sudo docker compose -f packaging/owned-server/compose.yml --env-file "$VESLO_ENV_FILE" build den ai-gateway web
sudo docker compose -f packaging/owned-server/compose.yml --env-file "$VESLO_ENV_FILE" run --rm --no-deps den pnpm --filter @neatech/den db:migrate
sudo docker compose -f packaging/owned-server/compose.yml --env-file "$VESLO_ENV_FILE" run --rm --no-deps ai-gateway pnpm --filter @neatech/ai-gateway db:migrate
```

Expected:

- Both database containers are healthy.
- Both restores complete and checksums are recorded.
- Both migrations complete without schema errors.
- The web image is rebuilt with the intended public `NEXT_PUBLIC_*` values.

## Start Dark Launch

Start internal app services:

```bash
sudo docker compose -f packaging/owned-server/compose.yml --env-file "$VESLO_ENV_FILE" up -d den ai-gateway web
sudo docker compose -f packaging/owned-server/compose.yml --env-file "$VESLO_ENV_FILE" ps
```

Expected:

- `den-db`, `ai-gateway-db`, `den`, `ai-gateway`, and `web` are healthy.
- Public ports 80 and 443 are still not bound unless `proxy` was already running
  for this stack.

Start the public proxy only after the app services are healthy:

```bash
sudo docker compose -f packaging/owned-server/compose.yml --env-file "$VESLO_ENV_FILE" up -d proxy
```

Expected:

- Caddy obtains TLS certificates for `api.veslo.work`, `ai.veslo.work`, and
  `app.veslo.work`.
- No live production DNS cutover has been performed in this phase.

## Phase 4 Checks

Run the checks from the migration plan:

```bash
curl -fsS https://api.veslo.work/health
curl -fsS https://ai.veslo.work/health
curl -I https://app.veslo.work
```

Then verify:

- Browser auth and desktop handoff against owned-server Den.
- Existing restored sessions and `/v1/me`.
- Managed-AI access policy, token issuance, one small request, and usage row.
- Feedback projection to YouTrack.
- Debug-log ingest and admin lookup.
- Manual backup from the restored dark-launch databases.

Phase 4 passes only when every check is recorded in the verification log and
committed in the phase-specific commit.

## Stop or Roll Back Dark Launch

To stop public exposure while preserving restored data:

```bash
sudo docker compose -f packaging/owned-server/compose.yml --env-file "$VESLO_ENV_FILE" stop proxy
```

To stop app services while preserving database volumes:

```bash
sudo docker compose -f packaging/owned-server/compose.yml --env-file "$VESLO_ENV_FILE" stop web ai-gateway den
```

Do not run `down -v` against a real dark-launch stack unless the operator has
explicitly approved discarding the restored volumes.
