# Owned Server Database Backup and Restore

This runbook covers the MySQL databases in the owned-server Compose stack:

- `den-db` / `den`
- `ai-gateway-db` / `veslo_ai_gateway`

Run these commands from the repo root on the owned server.

## Policy

- Run automated database backups daily.
- Run manual backups immediately before production cutover and before any destructive restore.
- Copy backups off the owned server after each run. The server-local copy is not the backup of record.
- Encrypt backups before long-term storage or transmission outside the server.
- Test restore at least once before cutover, then on a recurring cadence after production migration.
- Record every backup and restore rehearsal in `docs/plans/assets/owned-server-migration/verification-log.md` with sanitized paths, timestamps, and checksums.

## Environment

Defaults:

```bash
COMPOSE_FILE=packaging/owned-server/compose.yml
ENV_FILE=/srv/veslo/env/production.env
DOCKER_COMPOSE="docker compose"
```

On the current owned server, use `sudo docker compose`:

```bash
DOCKER_COMPOSE="sudo docker compose" \
  packaging/owned-server/backup/backup-mysql.sh den-db den /srv/veslo/backups/den-$(date -u +%Y%m%dT%H%M%SZ).sql
```

For staging rehearsals, keep volumes isolated with a separate Compose project:

```bash
ENV_FILE=/srv/veslo/env/staging.env
DOCKER_COMPOSE="sudo docker compose -p veslo-owned-server-staging"
```

The full owned-server rehearsal procedure lives in `packaging/owned-server/rehearsal/README.md`.

## Backup

Back up Den:

```bash
DOCKER_COMPOSE="sudo docker compose" \
  packaging/owned-server/backup/backup-mysql.sh den-db den /srv/veslo/backups/den-manual.sql
```

Back up AI Gateway:

```bash
DOCKER_COMPOSE="sudo docker compose" \
  packaging/owned-server/backup/backup-mysql.sh ai-gateway-db veslo_ai_gateway /srv/veslo/backups/ai-gateway-manual.sql
```

Create checksums:

```bash
sha256sum /srv/veslo/backups/*.sql
```

Encrypt before off-server transfer with the operator-approved encryption tool. Do not commit backup files or checksums that reveal private storage paths.

## Restore

Restores are destructive. The restore script refuses to run unless `--apply` is provided.

Restore Den into the selected Compose environment:

```bash
DOCKER_COMPOSE="sudo docker compose" \
  packaging/owned-server/backup/restore-mysql.sh --apply den-db den /srv/veslo/backups/den-manual.sql
```

Restore AI Gateway:

```bash
DOCKER_COMPOSE="sudo docker compose" \
  packaging/owned-server/backup/restore-mysql.sh --apply ai-gateway-db veslo_ai_gateway /srv/veslo/backups/ai-gateway-manual.sql
```

After restore, run the service migrations from the migration plan and then perform health checks before allowing traffic.
