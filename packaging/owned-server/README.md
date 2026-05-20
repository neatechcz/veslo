# Veslo Owned Server Deployment

This directory is the source of truth for the owned-server deployment template for VSLO-185. Do not hand-edit production containers as the durable deployment record.

## Services

- `den-db`: MySQL 8.4 for Den.
- `ai-gateway-db`: MySQL 8.4 for standalone AI Gateway.
- `den`: Den control plane on internal port 8788.
- `ai-gateway`: standalone AI Gateway on internal port 4034.
- `web`: Next.js cloud app on internal port 3005.
- `proxy`: Caddy reverse proxy and TLS endpoint on public ports 80 and 443.

Only the proxy publishes host ports. MySQL and app containers stay on the Compose network.

## Domains

- `https://api.veslo.work` routes to Den.
- `https://ai.veslo.work` routes to AI Gateway.
- `https://app.veslo.work` routes to the web app.

DNS for these names must point at the owned server before public TLS issuance can succeed. Production live traffic must not be redirected until the Phase 5 cutover gate in the migration plan.

## Environment

Create the production env file outside the repo:

```bash
sudo mkdir -p /srv/veslo/env
sudo cp packaging/owned-server/env.example /srv/veslo/env/production.env
sudo chmod 600 /srv/veslo/env/production.env
```

Fill `/srv/veslo/env/production.env` with production values. The template covers Den, AI Gateway, web, Lettr, Render worker provisioning, Vercel worker-domain integration, Polar, YouTrack, debug-log ingest, and managed-AI settings.

Auth email uses Lettr over HTTPS via `LETTR_API_KEY`, `AUTH_EMAIL_ADDRESS`, and `AUTH_EMAIL_FROM_NAME`. Direct SMTP is not required.

## Persistent Volumes

Compose creates these named volumes:

- `den-db-data` for Den MySQL data.
- `ai-gateway-db-data` for AI Gateway MySQL data.
- `caddy-data` for certificates and Caddy state.
- `caddy-config` for Caddy runtime config.
- `pnpm-store` for container-side pnpm cache.

Backups must be copied off-server. Database dump and restore automation is added in the later backup phase; until then, treat these volumes as stateful production data.

## Start

From a checked-out release on the server:

```bash
sudo docker compose -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/production.env config
sudo docker compose -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/production.env up -d
```

Use `sudo docker compose` because the initial server check confirmed `sudo docker ps` works while direct Docker socket access for `neatech` does not.

## Health Check

After startup:

```bash
curl -fsS https://api.veslo.work/health
curl -fsS https://ai.veslo.work/health
curl -I https://app.veslo.work
sudo docker compose -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/production.env ps
```

Application health checks are wired in the next task. Until that task is complete, the proxy and service commands are the skeleton contract and the Compose config check is the local validation gate.

## Logs

```bash
sudo docker compose -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/production.env logs -f den
sudo docker compose -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/production.env logs -f ai-gateway
sudo docker compose -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/production.env logs -f web
sudo docker compose -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/production.env logs -f proxy
```

## Rollback

Keep Render warm through the observation window. If cutover fails, stop writes to the owned-server stack, repoint DNS to Render, restore client-facing auth URLs to the previous production values, and record whether any writes landed on the owned server before rollback.
