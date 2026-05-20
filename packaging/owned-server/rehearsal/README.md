# Owned Server Staging Rehearsal

This runbook rehearses database restore and migrations on the owned server without
binding public ports or redirecting production traffic.

Use it for Phase 3 Task 6. The production cutover still requires a fresh
production dump and the Phase 5 gate from the migration plan.

## Isolation Rules

- Use a separate Compose project: `veslo-owned-server-staging`.
- Start only `den`, `ai-gateway`, and their database dependencies.
- Do not start `proxy` during the rehearsal.
- Do not use production DNS or production auth callback URLs.
- Do not use production secrets with synthetic data.
- Tear the staging project down after recording verification evidence.

## Prepare Staging Env

Copy the staging template on the server:

```bash
sudo mkdir -p /srv/veslo/env
sudo cp packaging/owned-server/env.staging.example /srv/veslo/env/staging.env
sudo chmod 600 /srv/veslo/env/staging.env
```

Edit `/srv/veslo/env/staging.env` if the rehearsal uses a real non-production
dump that depends on preserved continuity secrets. Keep the file out of git.

Validate Compose with the isolated project name:

```bash
sudo docker compose -p veslo-owned-server-staging -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/staging.env config --quiet
```

## Start Staging Services

Start the app and database services only:

```bash
sudo docker compose -p veslo-owned-server-staging -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/staging.env up -d --build den ai-gateway
```

This command starts `den-db`, `ai-gateway-db`, `den`, and `ai-gateway`. It does
not start `web` or `proxy`, so it does not bind host ports 80 or 443.

Check service state:

```bash
sudo docker compose -p veslo-owned-server-staging -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/staging.env ps
```

## Restore Real Non-Production Dumps

Copy sanitized dump files to `/srv/veslo/rehearsal/` and restore them with the
repo scripts:

```bash
ENV_FILE=/srv/veslo/env/staging.env \
DOCKER_COMPOSE="sudo docker compose -p veslo-owned-server-staging" \
  packaging/owned-server/backup/restore-mysql.sh --apply den-db den /srv/veslo/rehearsal/den-nonprod.sql

ENV_FILE=/srv/veslo/env/staging.env \
DOCKER_COMPOSE="sudo docker compose -p veslo-owned-server-staging" \
  packaging/owned-server/backup/restore-mysql.sh --apply ai-gateway-db veslo_ai_gateway /srv/veslo/rehearsal/ai-gateway-nonprod.sql
```

Record the dump source, sanitized path, and checksum in the verification log.

## Synthetic Fallback

Use this section only when a real non-production dump is unavailable and the
operator approves a synthetic rehearsal. This validates the owned-server restore
mechanics and migration commands, but it does not prove compatibility with real
production data.

Create synthetic dump files on the server:

```bash
sudo mkdir -p /srv/veslo/rehearsal

sudo tee /srv/veslo/rehearsal/den-synthetic.sql >/dev/null <<'SQL'
DROP TABLE IF EXISTS migration_rehearsal_probe;
CREATE TABLE migration_rehearsal_probe (
  id INT PRIMARY KEY,
  source VARCHAR(64) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO migration_rehearsal_probe (id, source) VALUES (1, 'synthetic-den');
SQL

sudo tee /srv/veslo/rehearsal/ai-gateway-synthetic.sql >/dev/null <<'SQL'
DROP TABLE IF EXISTS migration_rehearsal_probe;
CREATE TABLE migration_rehearsal_probe (
  id INT PRIMARY KEY,
  source VARCHAR(64) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO migration_rehearsal_probe (id, source) VALUES (1, 'synthetic-ai-gateway');
SQL
```

Restore the synthetic dumps:

```bash
ENV_FILE=/srv/veslo/env/staging.env \
DOCKER_COMPOSE="sudo docker compose -p veslo-owned-server-staging" \
  packaging/owned-server/backup/restore-mysql.sh --apply den-db den /srv/veslo/rehearsal/den-synthetic.sql

ENV_FILE=/srv/veslo/env/staging.env \
DOCKER_COMPOSE="sudo docker compose -p veslo-owned-server-staging" \
  packaging/owned-server/backup/restore-mysql.sh --apply ai-gateway-db veslo_ai_gateway /srv/veslo/rehearsal/ai-gateway-synthetic.sql
```

Verify the sentinel rows:

```bash
sudo docker compose -p veslo-owned-server-staging -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/staging.env exec -T den-db sh -c 'MYSQL_PWD="${MYSQL_ROOT_PASSWORD:?missing MYSQL_ROOT_PASSWORD}" mysql -uroot "$1" -Nse "SELECT COUNT(*) FROM migration_rehearsal_probe;"' sh den

sudo docker compose -p veslo-owned-server-staging -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/staging.env exec -T ai-gateway-db sh -c 'MYSQL_PWD="${MYSQL_ROOT_PASSWORD:?missing MYSQL_ROOT_PASSWORD}" mysql -uroot "$1" -Nse "SELECT COUNT(*) FROM migration_rehearsal_probe;"' sh veslo_ai_gateway
```

Expected: each command prints `1`.

## Run Migrations

Run the service migrations against the staging project:

```bash
sudo docker compose -p veslo-owned-server-staging -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/staging.env exec -T den pnpm --filter @neatech/den db:migrate

sudo docker compose -p veslo-owned-server-staging -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/staging.env exec -T ai-gateway pnpm --filter @neatech/ai-gateway db:migrate
```

Record the migration result in the verification log.

## Back Up The Rehearsed Databases

Before teardown, confirm backup works against the same staging project:

```bash
sudo mkdir -p /srv/veslo/backups/rehearsal

ENV_FILE=/srv/veslo/env/staging.env \
DOCKER_COMPOSE="sudo docker compose -p veslo-owned-server-staging" \
  packaging/owned-server/backup/backup-mysql.sh den-db den /srv/veslo/backups/rehearsal/den-rehearsal.sql

ENV_FILE=/srv/veslo/env/staging.env \
DOCKER_COMPOSE="sudo docker compose -p veslo-owned-server-staging" \
  packaging/owned-server/backup/backup-mysql.sh ai-gateway-db veslo_ai_gateway /srv/veslo/backups/rehearsal/ai-gateway-rehearsal.sql

sha256sum /srv/veslo/backups/rehearsal/*.sql
```

Record sanitized checksums in the verification log. Do not commit dump files.

## Teardown

After evidence is recorded, stop the staging project:

```bash
sudo docker compose -p veslo-owned-server-staging -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/staging.env down
```

Remove staging volumes only after confirming no evidence is still needed:

```bash
sudo docker compose -p veslo-owned-server-staging -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/staging.env down -v
```
