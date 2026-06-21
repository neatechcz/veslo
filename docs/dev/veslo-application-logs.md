# Veslo Application Logs

This is the canonical runbook for finding Veslo application and server logs in the owned-server production runtime.

Use this document for questions like "what happened in the application", "what was the latest server log", or "which Veslo runtime logs exist". Keep the scope to Veslo application services, worker runtime services, and their debug-log ingestion path.

## Maintenance Rule

When a change affects how Veslo logs are created, forwarded, stored, retained, redacted, queried, or named, update this document in the same change. This includes changes to:

- owned-server Compose service names
- Docker logging driver or rotation settings
- worker container naming or lifecycle
- Den debug-log ingest schema, routes, retention, or admin read paths
- Veslo server debug-log spool format or upload behavior
- AI Gateway, Den, worker manager, or worker runtime log output
- production checkout or env-file paths used by the deployment workflow

Do not let this runbook become agent-only knowledge. If an investigation discovers a durable log location or a logging behavior changes, promote it here.

## Production Location

The owned-server deployment workflow is the source of truth for the production paths. The current workflow defaults are:

- App checkout: `/home/neatech/veslo-owned-server-production`
- Env file: `/home/neatech/veslo-owned-server-dark-launch-inputs/env/production.env`
- Compose file: `packaging/owned-server/compose.yml`
- Compose project: `veslo-owned-server`
- Self-hosted runner label: `veslo-owned-server`

The public Veslo application endpoints should resolve to the owned-server host. If SSH access or paths fail, check the current GitHub Actions variables for `OWNED_SERVER_APP_DIR` and `OWNED_SERVER_ENV_FILE`, then verify the active deployment workflow before searching elsewhere.

Use a local shell helper after connecting to the host:

```bash
cd /home/neatech/veslo-owned-server-production
OWNED_SERVER_ENV_FILE=/home/neatech/veslo-owned-server-dark-launch-inputs/env/production.env

compose() {
  sudo -n docker compose \
    -f packaging/owned-server/compose.yml \
    --env-file "$OWNED_SERVER_ENV_FILE" \
    "$@"
}
```

## First Checks

Start with service inventory and health:

```bash
compose config --services
compose ps
sudo -n docker ps \
  --filter label=com.docker.compose.project=veslo-owned-server \
  --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
```

The expected owned-server services are:

- `den`
- `ai-gateway`
- `web`
- `worker-manager`
- `proxy`
- `backup`
- `den-db`
- `ai-gateway-db`

Worker runtime containers are created dynamically by `worker-manager` and are not always present. Their names use:

- `veslo-worker-<worker-id>`
- `veslo-worker-<worker-id>-workspace` for the matching workspace volume

Check active worker containers with:

```bash
sudo -n docker ps \
  --format '{{.Names}}\t{{.Image}}\t{{.Status}}' \
  | grep '^veslo-worker-' || true
```

## Docker And Compose Logs

The primary currently-populated production log surface is Docker stdout/stderr for the Compose services and any active worker containers.

Read logs through Compose, not by browsing Docker's private storage directly:

```bash
compose logs --no-color --timestamps --tail=100 den
compose logs --no-color --timestamps --tail=100 ai-gateway
compose logs --no-color --timestamps --tail=100 web
compose logs --no-color --timestamps --tail=100 worker-manager
compose logs --no-color --timestamps --tail=100 proxy
compose logs --no-color --timestamps --tail=100 backup
compose logs --no-color --timestamps --tail=100 den-db
compose logs --no-color --timestamps --tail=100 ai-gateway-db
```

For follow mode:

```bash
compose logs --no-color --timestamps -f ai-gateway
```

To list the latest timestamp per service without dumping log payloads:

```bash
for service in $(compose config --services); do
  latest="$(
    compose logs --no-color --timestamps --tail=1 "$service" 2>/dev/null \
      | tail -n 1 \
      | sed -E 's/.*([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z).*/\1/' \
      || true
  )"
  [ -n "$latest" ] || latest="(no log line)"
  printf '%s\t%s\n' "$service" "$latest"
done
```

Some records are multi-line stack traces or object dumps. `--tail=1` can return only a closing brace or stack frame. If the latest line is incomplete, pull a small surrounding tail for that service and reconstruct the last block:

```bash
compose logs --no-color --timestamps --tail=80 ai-gateway
```

Docker currently uses the `json-file` log driver with rotation:

- `max-size=100m`
- `max-file=3`

Verify the driver and rotation settings with:

```bash
for service in den ai-gateway web worker-manager proxy backup den-db ai-gateway-db; do
  container="$(compose ps -q "$service")"
  printf '%s\t' "$service"
  sudo -n docker inspect \
    --format '{{.HostConfig.LogConfig.Type}} {{json .HostConfig.LogConfig.Config}}' \
    "$container"
done
```

## Den Debug-Log Ingest

Den accepts uploaded debug-log batches at `POST /v1/internal/debug-logs`. This is the application-queryable debug-log store: metadata is queryable, while payload content is encrypted and returned only through admin read paths.

Configuration lives in the Den container environment:

- `DEN_LOG_INGEST_TOKEN`
- `DEN_LOG_MASTER_KEY`
- `DEN_LOG_MASTER_KEY_VERSION`
- `DEN_LOG_RETENTION_DAYS`

Check configuration presence without printing secret values:

```bash
compose exec -T den node -e '
const keys = [
  "DEN_LOG_INGEST_TOKEN",
  "DEN_LOG_MASTER_KEY",
  "DEN_LOG_MASTER_KEY_VERSION",
  "DEN_LOG_RETENTION_DAYS",
];
console.log(JSON.stringify(Object.fromEntries(keys.map((key) => [
  key,
  {
    present: Boolean(process.env[key]),
    length: process.env[key]?.length ?? 0,
    value: key === "DEN_LOG_RETENTION_DAYS" ? process.env[key] ?? null : undefined,
  },
])), null, 2));
'
```

Check whether debug-log batches and events are stored, without reading encrypted payloads:

```bash
compose exec -T den sh -lc 'cd /app/services/den && node' <<'NODE'
const mysql = require("mysql2/promise");

(async () => {
  const connection = await mysql.createConnection(process.env.DATABASE_URL);
  try {
    const [summary] = await connection.execute(`
      SELECT
        COUNT(*) AS eventCount,
        MIN(event_timestamp) AS oldestEventTimestamp,
        MAX(event_timestamp) AS latestEventTimestamp,
        MAX(created_at) AS latestCreatedAt
      FROM debug_log_event
    `);
    const [batches] = await connection.execute(`
      SELECT
        COUNT(*) AS batchCount,
        MAX(created_at) AS latestBatchCreatedAt,
        MAX(expires_at) AS latestBatchExpiresAt
      FROM debug_log_batch
    `);
    const [sources] = await connection.execute(`
      SELECT
        source,
        stream,
        COALESCE(level, 'null') AS level,
        COUNT(*) AS count,
        MAX(event_timestamp) AS latestEventTimestamp
      FROM debug_log_event
      GROUP BY source, stream, level
      ORDER BY latestEventTimestamp DESC
      LIMIT 50
    `);
    const [latest] = await connection.execute(`
      SELECT
        id,
        batch_id AS batchId,
        event_id AS eventId,
        user_id AS userId,
        org_id AS orgId,
        workspace_id AS workspaceId,
        worker_id AS workerId,
        session_id AS sessionId,
        run_id AS runId,
        source,
        stream,
        level,
        event_timestamp AS eventTimestamp,
        created_at AS createdAt,
        payload_bytes AS payloadBytes
      FROM debug_log_event
      ORDER BY event_timestamp DESC
      LIMIT 1
    `);
    console.log(JSON.stringify({
      summary: summary[0],
      batches: batches[0],
      sources,
      latest: latest[0] || null,
    }, null, 2));
  } finally {
    await connection.end();
  }
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
NODE
```

Prefer metadata queries first. Read decrypted payloads only when the user explicitly asks and the operational need is clear.

## Veslo Server Debug-Log Pipeline

Desktop-launched Veslo servers and sidecars use the local debug-log forwarder and server pipeline documented in `docs/dev/state-and-config-reference.md`.

The important production distinction is:

- Docker/Compose logs show what each owned-server process wrote to stdout/stderr.
- Den debug-log ingest is the durable, application-queryable store for uploaded debug events.
- The two are not equivalent. If Den has zero debug-log events, Docker logs may still contain process output, but the application does not have queryable debug-log history for those events.

## AI Gateway And Den Codex Data Volumes

The owned-server stack mounts Codex data volumes for managed AI surfaces:

- `veslo-owned-server_ai-gateway-codex-data`
- `veslo-owned-server_den-codex-data`

These are not the primary log source, but they can contain runtime state if managed AI flows have written there. Check for known trace formats without reading payload content broadly:

```bash
compose exec -T ai-gateway sh -lc '
  find /var/lib/veslo-ai-gateway/codex -maxdepth 4 -type f \
    \( -name "*.log" -o -name "*.jsonl" -o -name "*.sqlite" \) \
    -printf "%TY-%Tm-%TdT%TH:%TM:%TS\t%s\t%p\n" 2>/dev/null \
    | sort | tail -40
'

compose exec -T den sh -lc '
  find /var/lib/veslo-den/codex -maxdepth 4 -type f \
    \( -name "*.log" -o -name "*.jsonl" -o -name "*.sqlite" \) \
    -printf "%TY-%Tm-%TdT%TH:%TM:%TS\t%s\t%p\n" 2>/dev/null \
    | sort | tail -40
'
```

If a future managed AI runtime starts writing durable trace files in these volumes, document the exact path, retention behavior, and safe read command here.

## Reporting Rules

When reporting log findings:

- State which log surface was checked.
- State the host, service, and timestamp basis.
- Distinguish Docker process logs from Den debug-log events.
- Do not print secrets or env values.
- Do not dump raw payloads unless explicitly needed.
- If only metadata was checked, say so.
- If an expected log store is empty, report it as empty rather than searching unrelated surfaces.
