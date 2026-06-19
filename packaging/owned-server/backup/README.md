# Owned Server Database Backup and Restore

This runbook covers the MySQL databases in the owned-server Compose stack:

- `den-db` / `den`
- `ai-gateway-db` / `veslo_ai_gateway`

Run these commands from the repo root on the owned server.

## Policy

- Run automated database backups daily through the production Compose `backup` service.
- Run manual backups immediately before production cutover and before any destructive restore.
- Copy backups off the owned server after each run. The server-local copy is not the backup of record.
- Encrypt backups before long-term storage or transmission outside the server.
- Test restore at least once before cutover, then on a recurring cadence after production migration.
- Keep the newest two successful backup sets on the owned server. Failed artifacts are retained separately for diagnosis.
- Record every backup and restore rehearsal in `docs/plans/assets/owned-server-migration/verification-log.md` with sanitized paths, timestamps, and checksums.

## Environment

Defaults:

```bash
COMPOSE_FILE=packaging/owned-server/compose.yml
ENV_FILE=/srv/veslo/env/production.env
DOCKER_COMPOSE="docker compose"
NODE_BIN=node
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

## Automated Daily Backup

Production uses the `backup` service in `packaging/owned-server/compose.yml`. The backup image includes the MySQL client, `zstd`, and Node.js for Lettr failure alerts. It dumps the MySQL services over the internal Compose network and writes backup sets to the host bind mount at `/srv/veslo/backups`.

Set the production env file as the authoritative source for `BACKUP_ALERT_EMAIL_RECIPIENTS`, and populate it with all current admins who must receive failure emails. The backup alert path reuses the existing Lettr env values from the same production env file:

```bash
LETTR_API_KEY=...
AUTH_EMAIL_ADDRESS=auth@veslo.work
AUTH_EMAIL_FROM_NAME=Veslo
BACKUP_ALERT_EMAIL_RECIPIENTS=admin1@example.com,admin2@example.com
BACKUP_DAILY_UTC_TIME=02:15:00
BACKUP_RANDOM_DELAY_SECONDS=900
```

Build and start the production backup scheduler through the same Compose command used by the deployment workflow:

```bash
sudo docker compose -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/production.env build backup
sudo docker compose -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/production.env up -d backup
```

Run the first manual backup through the same backup image:

```bash
sudo docker compose -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/production.env run --rm --no-deps backup bash ./packaging/owned-server/backup/backup-owned-server-databases.sh
```

Check scheduler status and logs:

```bash
sudo docker compose -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/production.env ps backup
sudo docker compose -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/production.env logs -f backup
```

The scheduler runs `packaging/owned-server/backup/backup-owned-server-databases-loop.sh`, which starts `backup-owned-server-databases.sh` daily at `BACKUP_DAILY_UTC_TIME` plus up to `BACKUP_RANDOM_DELAY_SECONDS` jitter. The runner dumps both databases, compresses each dump with `zstd`, verifies compressed contents, writes checksums, promotes a completed set atomically, and prunes only successful sets beyond the newest two successful backup sets.

The `systemd/` files in this directory remain available for hosts that explicitly prefer a host timer and allow the required root operations. Production uses the Compose `backup` service because the owned-server runner is intentionally limited to Docker operations.

Successful backup sets live under `/srv/veslo/backups/<UTC timestamp>/`:

```text
/srv/veslo/backups/20260619T021500Z/
  den.sql.zst
  den.sql.zst.sha256
  ai-gateway.sql.zst
  ai-gateway.sql.zst.sha256
  manifest.json
```

In-progress artifacts live under `/srv/veslo/backups/.in-progress/`. Failed artifacts are moved to `/srv/veslo/backups/.failed/<UTC timestamp>/` and are not pruned by the successful-set retention policy. Before preserving failed artifacts, the runner removes raw `.sql` files from staging so failed-artifact directories do not retain uncompressed production dumps.

Verify the latest backup files after the first manual run:

```bash
sudo docker compose -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/production.env run --rm --no-deps backup bash -lc '
  latest="$(find /srv/veslo/backups -mindepth 1 -maxdepth 1 -type d -name "????????T??????Z" | sort | tail -n 1)"
  cd "$latest"
  zstd -t den.sql.zst ai-gateway.sql.zst
  sha256sum -c den.sql.zst.sha256
  sha256sum -c ai-gateway.sql.zst.sha256
'
```

Trigger one controlled failure to verify exactly one failure email reaches the configured admins. Use an existing successful backup timestamp so the runner fails during preflight with `Backup timestamp already exists`, before any database dump starts:

```bash
latest="$(sudo docker compose -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/production.env run --rm --no-deps backup bash -lc 'find /srv/veslo/backups -mindepth 1 -maxdepth 1 -type d -name "????????T??????Z" | sort | tail -n 1')"
existing_timestamp="$(basename "$latest")"
sudo docker compose -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/production.env run --rm --no-deps -e BACKUP_TIMESTAMP="$existing_timestamp" backup bash ./packaging/owned-server/backup/backup-owned-server-databases.sh || true
```

After the email arrives, confirm the failure in the logs and verify the next normal manual run succeeds before relying on the timer:

```bash
sudo docker compose -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/production.env logs --tail=100 backup
sudo docker compose -f packaging/owned-server/compose.yml --env-file /srv/veslo/env/production.env run --rm --no-deps backup bash ./packaging/owned-server/backup/backup-owned-server-databases.sh
```

## Manual Backup

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
