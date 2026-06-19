# Owned Server Daily Database Backups Design

## Context

The owned-server Compose stack stores production state in two MySQL databases:

- Den: `den-db` / `den`
- AI Gateway: `ai-gateway-db` / `veslo_ai_gateway`

Manual dump and restore helpers already live in `packaging/owned-server/backup/`.
The missing operational piece is a reliable daily full-backup job for the owned
server.

## Goals

- Create full backups of both MySQL databases every day.
- Store backup sets under `/srv/veslo/backups`.
- Compress dumps with `zstd`.
- Keep the newest two successful daily backup sets.
- Alert all current admins by email when a backup run fails.
- Avoid silent failure, overlapping runs, partial backups marked as complete, or
  retention deleting useful backups after a failed run.

## Non-Goals

- Do not add a new database backup product or external scheduler.
- Do not depend on Den or AI Gateway being healthy to send backup failure
  alerts.
- Do not send success emails for routine successful runs.
- Do not implement off-server backup storage in this first step. The existing
  runbook still treats server-local backups as insufficient for long-term
  disaster recovery.

## Selected Approach

Add a repo-managed backup runner script and install it through a `systemd` timer
and service on the owned server.

The runner uses the existing MySQL dump helper for the actual `mysqldump` calls,
compresses each dump with `zstd -3`, verifies the compressed dumps, writes
checksums and a manifest, then atomically promotes the completed set into
`/srv/veslo/backups`.

`systemd` is preferred over cron because it gives clear status, journald logs,
retry behavior, missed-run handling after reboot, and native protection against
overlapping service starts.

## Backup Set Layout

Each successful run creates a timestamped set:

```text
/srv/veslo/backups/20260619T020000Z/
  den.sql.zst
  den.sql.zst.sha256
  ai-gateway.sql.zst
  ai-gateway.sql.zst.sha256
  manifest.json
```

The runner writes into a staging path first, such as:

```text
/srv/veslo/backups/.in-progress/20260619T020000Z/
```

Only after both databases are dumped, compressed, verified, checksummed, and
recorded in the manifest does the runner rename the staging directory into the
successful backup-set directory.

Failed runs remain outside the successful set namespace, for example:

```text
/srv/veslo/backups/.failed/20260619T020000Z/
```

This makes incomplete backups visible for diagnosis without letting retention or
restore procedures treat them as successful backups.

## Compression

`zstd` is a required server dependency. The runner fails fast if `zstd` is not
installed. That failure is handled as a normal backup failure and sends the same
failure email.

Compression uses `zstd -3`, which is a practical balance between size reduction
and runtime for daily SQL dumps. There is no gzip fallback.

Verification must prove that each `.sql.zst` file can be decompressed and that
the decompressed stream looks like a MySQL dump. Checksums are created for the
compressed files because those are the files retained and restored from.

## Alerting

Backup failure alerts use the same Lettr email delivery surface already used by
Den and AI Gateway:

- `LETTR_API_KEY`
- `AUTH_EMAIL_ADDRESS`
- `AUTH_EMAIL_FROM_NAME`

The backup runner reads the owned-server production env file directly. It should
not depend on Den or AI Gateway being healthy when sending the failure email.

Recipients are configured with `BACKUP_ALERT_EMAIL_RECIPIENTS`, populated with
all current admins. This keeps backup alerting independent from the Den platform
admin lookup route during an outage. If `BACKUP_ALERT_EMAIL_RECIPIENTS` is
missing, the runner may fall back to `AI_GATEWAY_ALERT_EMAIL_RECIPIENTS`, but the
production install should set the dedicated backup recipient value explicitly.

Each failed run sends one email containing:

- host
- timestamp
- failing step
- final log excerpt
- path to failed-run artifacts, when present
- the systemd unit name and journal command to inspect details

Successful runs do not send email.

## Retention

Retention runs only after a complete new backup set is promoted. It deletes old
successful backup-set directories while keeping the newest two successful sets.

Retention must not count `.in-progress` or `.failed` directories as successful
sets. If retention fails, the whole run exits non-zero and sends the normal
failure email, because unexpected retention behavior is safer to surface than to
hide.

## Error Handling

The runner exits non-zero when any required step fails:

- missing required tools or env values
- overlapping run lock cannot be acquired
- Docker Compose command fails
- either database dump fails
- compression fails
- decompression or dump-shape verification fails
- checksum generation fails
- manifest writing fails
- promotion from staging fails
- retention fails
- failure email cannot be sent

The runner should use a lock file or `flock` to prevent overlapping runs even if
the service is started manually while the timer is active.

Temporary files are removed or moved into the failed-run directory. The runner
must not overwrite an existing successful set.

## Installation Shape

The repo should provide:

- backup runner script under `packaging/owned-server/backup/`
- `systemd` service example
- `systemd` timer example
- runbook updates covering install, manual first run, status checks, logs,
  restore rehearsal, and failure alert verification

The timer should run daily at an off-peak hour and use systemd persistence so a
missed run after reboot runs when the server comes back.

## Testing

Tests should avoid production data and real email delivery.

Required checks:

- shell/static validation for the backup scripts
- script-level tests with fake `docker compose`, fake `zstd`, and fake Lettr
  calls
- local integration-style test using temporary directories and synthetic MySQL
  dump streams
- docs verification that install/runbook examples reference `/srv/veslo/backups`
  and the final runner script

Operational verification after implementation:

- manual first run on the owned server
- confirm two `.sql.zst` files, two checksum files, and a manifest exist
- confirm `zstd -t` passes for both compressed dumps
- confirm retention keeps two successful sets
- trigger a controlled failure and confirm exactly one failure email reaches the
  configured admin recipients
- rehearse restore against a non-production or staging Compose project before
  relying on production restore procedures
