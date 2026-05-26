# Veslo Owned Server Deployment

This directory is the source of truth for the owned-server deployment template for VSLO-185. Do not hand-edit production containers as the durable deployment record.

## Services

- `den-db`: MySQL 8.4 for Den.
- `ai-gateway-db`: MySQL 8.4 for standalone AI Gateway.
- `den`: Den control plane on internal port 8788.
- `ai-gateway`: standalone AI Gateway on internal port 4034.
- `web`: Next.js cloud app on internal port 3005.
- `worker-manager`: internal worker container manager on port 8790.
- `worker-runtime-image`: build-only Compose profile for the owned worker runtime image.
- `proxy`: Caddy reverse proxy and TLS endpoint on public ports 80 and 443.

Only the proxy publishes host ports. MySQL and app containers stay on the Compose network.

## Domains

- `https://api.veslo.work` routes to Den.
- `https://ai.veslo.work` routes to AI Gateway.
- `https://app.veslo.work` routes to the web app.
- `https://<worker-id>.workers.veslo.work` routes to owned-server cloud workers through the worker manager.

DNS for these names must point at the owned server before public TLS issuance can succeed. Worker routing additionally requires a wildcard DNS record for `*.workers.veslo.work`. Production live traffic must not be redirected until the Phase 5 cutover gate in the migration plan.

## Environment

Create the production env file outside the repo:

```bash
sudo mkdir -p /srv/veslo/env
sudo cp packaging/owned-server/env.example /srv/veslo/env/production.env
sudo chmod 600 /srv/veslo/env/production.env
```

Fill `/srv/veslo/env/production.env` with production values. The template covers Den, AI Gateway, web, Lettr, owned-server worker provisioning, temporary Render worker provisioning, Vercel worker-domain integration, Polar, YouTrack, debug-log ingest, and managed-AI settings.

The GitHub Actions deployment can point at a different server-side env file with `OWNED_SERVER_ENV_FILE`. The current production workflow default uses the existing production env path on the owned server until the host layout is normalized.

Auth email uses Lettr over HTTPS via `LETTR_API_KEY`, `AUTH_EMAIL_ADDRESS`, and `AUTH_EMAIL_FROM_NAME`. Direct SMTP is not required.

The web app reads public `NEXT_PUBLIC_*` values at image build time. Rebuild the `web` image after changing those values.

For database restore rehearsals, use `env.staging.example` and `rehearsal/README.md`. The rehearsal commands use a separate Compose project name and start only `den`, `ai-gateway`, and their database dependencies. They do not start `proxy` or bind public ports 80/443.

For Phase 4 dark launch, use `dark-launch/README.md`. The dark-launch path
requires production-equivalent env values and real Den plus AI Gateway dumps.
Do not start `proxy` for Phase 4 with synthetic data.

## Persistent Volumes

Compose creates these named volumes:

- `den-db-data` for Den MySQL data.
- `ai-gateway-db-data` for AI Gateway MySQL data.
- `den-codex-data` for Den-managed Codex runtime state.
- `ai-gateway-codex-data` for AI Gateway Codex runtime state.
- `caddy-data` for certificates and Caddy state.
- `caddy-config` for Caddy runtime config.

Backups must be copied off-server. Database dump and restore automation is added in the later backup phase; until then, treat these volumes as stateful production data.

Owned cloud worker workspace volumes are created dynamically with names like `veslo-worker-<worker-id>-workspace`. Worker deletion through Den removes the matching worker container and volume.

Database backup and restore commands live in `packaging/owned-server/backup/`. Run a manual backup before cutover, copy encrypted backups off-server, and rehearse restore against staging before touching production traffic.

## Start

From a checked-out release on the server:

```bash
sudo docker compose -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/production.env config
sudo docker compose -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/production.env build worker-runtime-image
sudo docker compose -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/production.env up -d --build
```

Use `sudo docker compose` because the initial server check confirmed `sudo docker ps` works while direct Docker socket access for `neatech` does not.

The app images use `node:22-bookworm-slim`, enable Corepack, prepare `pnpm@10.27.0`, install the workspace with the lockfile, run the service-specific build command, then start through the package start script:

- `pnpm --filter @neatech/den build` then `pnpm --filter @neatech/den start`.
- `pnpm --filter @neatech/ai-gateway build` then `pnpm --filter @neatech/ai-gateway start`.
- `pnpm --filter @neatech/worker-manager build` then `pnpm --filter @neatech/worker-manager start`.
- `pnpm --filter @neatech/veslo-web build` then `pnpm --filter @neatech/veslo-web start`.

The worker manager is the only long-running service that mounts `/var/run/docker.sock`. Den talks to it over the internal Compose network using `OWNED_WORKER_MANAGER_TOKEN`.

## GitHub Actions Deployment

Production deploys are normally run through the `Deploy Owned Server` GitHub Actions workflow. The workflow is manual-only and does not run on push.

The workflow runs on a repository self-hosted runner installed on the owned
server and labeled `veslo-owned-server`. This avoids requiring GitHub-hosted
runners to open inbound SSH to the production host.

Required GitHub Actions configuration:

- Repository self-hosted runner labels: `self-hosted`, `linux`, `x64`, and `veslo-owned-server`.
- `OWNED_SERVER_APP_DIR`: stable Git checkout directory on the owned server.
- `OWNED_SERVER_ENV_FILE`: production env file path on the owned server.

On each run, the workflow creates or updates the stable checkout, checks out the requested branch with the job `GITHUB_TOKEN`, validates the Compose configuration, builds `worker-runtime-image`, `worker-manager`, `den`, `ai-gateway`, and `web`, starts database dependencies, runs Den and AI Gateway migrations, starts the full stack, and verifies internal plus public health endpoints.

Keep production secrets in the server-side env file and GitHub secrets. Do not commit them.

## Health Check

After startup:

```bash
curl -fsS https://api.veslo.work/health
curl -fsS https://ai.veslo.work/health
curl -I https://app.veslo.work
curl -fsS http://127.0.0.1:8790/health
sudo docker compose -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/production.env ps
```

Compose also defines container health checks for Den `/health`, AI Gateway `/health`, worker manager `/health`, and the web app `/`.

## Logs

```bash
sudo docker compose -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/production.env logs -f den
sudo docker compose -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/production.env logs -f ai-gateway
sudo docker compose -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/production.env logs -f worker-manager
sudo docker compose -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/production.env logs -f web
sudo docker compose -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/production.env logs -f proxy
```

## Rollback

Keep Render warm through the observation window. If cutover fails, stop writes to the owned-server stack, repoint DNS to Render, restore client-facing auth URLs to the previous production values, and record whether any writes landed on the owned server before rollback.
