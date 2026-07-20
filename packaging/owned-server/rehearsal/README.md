# Owned Server Staging Rehearsal

This runbook rehearses database restore and migrations on the owned server without
binding public ports or redirecting production traffic.

Use it for Phase 3 Task 6. The production cutover still requires a fresh
production dump and the Phase 5 gate from the migration plan.

## Isolation Rules

- Use a separate Compose project: `veslo-owned-server-rehearsal`.
- Start only `den`, `ai-gateway`, and their database dependencies.
- Do not start `proxy` during the rehearsal.
- Do not use production DNS or production auth callback URLs.
- Do not use production secrets with synthetic data.
- Tear the staging project down after recording verification evidence.

## Prepare Staging Env

Copy the rehearsal template on the server:

```bash
sudo mkdir -p /srv/veslo/env
sudo cp packaging/owned-server/env.rehearsal.example /srv/veslo/env/rehearsal.env
sudo chmod 600 /srv/veslo/env/rehearsal.env
```

Edit `/srv/veslo/env/rehearsal.env` if the rehearsal uses a real non-production
dump that depends on preserved continuity secrets. Keep the file out of git.

If the operator cannot create `/srv/veslo` with general sudo, use a user-owned
rehearsal directory instead and pass that path consistently to `--env-file` and
`ENV_FILE`.

Validate Compose with the isolated project name:

```bash
sudo docker compose -p veslo-owned-server-rehearsal -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/rehearsal.env config --quiet
```

## Start Staging Databases

Start the database services only:

```bash
sudo docker compose -p veslo-owned-server-rehearsal -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/rehearsal.env up -d den-db ai-gateway-db
```

This command starts only `den-db` and `ai-gateway-db`. Run migrations before
starting the long-lived app containers because Den and AI Gateway perform
boot-time schema reconciliation.

Check service state:

```bash
sudo docker compose -p veslo-owned-server-rehearsal -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/rehearsal.env ps
```

## Restore Real Non-Production Dumps

Copy sanitized dump files to `/srv/veslo/rehearsal/` and restore them with the
repo scripts:

```bash
ENV_FILE=/srv/veslo/env/rehearsal.env \
DOCKER_COMPOSE="sudo docker compose -p veslo-owned-server-rehearsal" \
  packaging/owned-server/backup/restore-mysql.sh --apply den-db den /srv/veslo/rehearsal/den-nonprod.sql

ENV_FILE=/srv/veslo/env/rehearsal.env \
DOCKER_COMPOSE="sudo docker compose -p veslo-owned-server-rehearsal" \
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

If `/srv/veslo/rehearsal` cannot be created, put the dump files under the
user-owned rehearsal directory and substitute those paths in the restore
commands.

Restore the synthetic dumps:

```bash
ENV_FILE=/srv/veslo/env/rehearsal.env \
DOCKER_COMPOSE="sudo docker compose -p veslo-owned-server-rehearsal" \
  packaging/owned-server/backup/restore-mysql.sh --apply den-db den /srv/veslo/rehearsal/den-synthetic.sql

ENV_FILE=/srv/veslo/env/rehearsal.env \
DOCKER_COMPOSE="sudo docker compose -p veslo-owned-server-rehearsal" \
  packaging/owned-server/backup/restore-mysql.sh --apply ai-gateway-db veslo_ai_gateway /srv/veslo/rehearsal/ai-gateway-synthetic.sql
```

Verify the sentinel rows:

```bash
sudo docker compose -p veslo-owned-server-rehearsal -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/rehearsal.env exec -T den-db sh -c 'MYSQL_PWD="${MYSQL_ROOT_PASSWORD:?missing MYSQL_ROOT_PASSWORD}" mysql -uroot "$1" -Nse "SELECT COUNT(*) FROM migration_rehearsal_probe;"' sh den

sudo docker compose -p veslo-owned-server-rehearsal -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/rehearsal.env exec -T ai-gateway-db sh -c 'MYSQL_PWD="${MYSQL_ROOT_PASSWORD:?missing MYSQL_ROOT_PASSWORD}" mysql -uroot "$1" -Nse "SELECT COUNT(*) FROM migration_rehearsal_probe;"' sh veslo_ai_gateway
```

Expected: each command prints `1`.

## Run Migrations

Build the app images, then run the service migrations in one-off containers
against the staging project:

```bash
sudo docker compose -p veslo-owned-server-rehearsal -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/rehearsal.env build den ai-gateway

sudo docker compose -p veslo-owned-server-rehearsal -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/rehearsal.env run --rm --no-deps den pnpm --filter @neatech/den db:migrate

sudo docker compose -p veslo-owned-server-rehearsal -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/rehearsal.env run --rm --no-deps ai-gateway pnpm --filter @neatech/ai-gateway db:migrate
```

Record the migration result in the verification log.

## Start Staging App Services

Start the app services after restore and migrations pass:

```bash
sudo docker compose -p veslo-owned-server-rehearsal -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/rehearsal.env up -d den ai-gateway
```

This command starts `den`, `ai-gateway`, and their already-running database
dependencies. It does not start `web` or `proxy`, so it does not bind host ports
80 or 443.

Check service state:

```bash
sudo docker compose -p veslo-owned-server-rehearsal -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/rehearsal.env ps
```

## Back Up The Rehearsed Databases

Before teardown, confirm backup works against the same staging project:

```bash
sudo mkdir -p /srv/veslo/backups/rehearsal

ENV_FILE=/srv/veslo/env/rehearsal.env \
DOCKER_COMPOSE="sudo docker compose -p veslo-owned-server-rehearsal" \
  packaging/owned-server/backup/backup-mysql.sh den-db den /srv/veslo/backups/rehearsal/den-rehearsal.sql

ENV_FILE=/srv/veslo/env/rehearsal.env \
DOCKER_COMPOSE="sudo docker compose -p veslo-owned-server-rehearsal" \
  packaging/owned-server/backup/backup-mysql.sh ai-gateway-db veslo_ai_gateway /srv/veslo/backups/rehearsal/ai-gateway-rehearsal.sql

sha256sum /srv/veslo/backups/rehearsal/*.sql
```

If `/srv/veslo/backups` cannot be created, write the rehearsal backups under
the user-owned rehearsal directory and record those sanitized paths.

Record sanitized checksums in the verification log. Do not commit dump files.

## Teardown

After evidence is recorded, stop the staging project:

```bash
sudo docker compose -p veslo-owned-server-rehearsal -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/rehearsal.env down
```

Remove staging volumes only after confirming no evidence is still needed:

```bash
sudo docker compose -p veslo-owned-server-rehearsal -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/rehearsal.env down -v
```
