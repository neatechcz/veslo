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

- SSH target: `neatech@62.109.146.43`
- Hostname observed on the server: `neatech-veslo.cust.webglobe.com`
- App checkout: `/home/neatech/veslo-owned-server-production`
- Env file: `/home/neatech/veslo-owned-server-dark-launch-inputs/env/production.env`
- Compose file: `packaging/owned-server/compose.yml`
- Compose project: `veslo-owned-server`
- Self-hosted runner label: `veslo-owned-server`

The public Veslo application endpoints should resolve to the owned-server host. If SSH access or paths fail, check the current GitHub Actions variables for `OWNED_SERVER_APP_DIR` and `OWNED_SERVER_ENV_FILE`, then verify the active deployment workflow before searching elsewhere.

Do not assume local SSH aliases such as `neatechapps` or `neatech-internal` are the owned-server host. Connect directly to `neatech@62.109.146.43` unless a newer hostname is documented here.

Use a local shell helper after connecting to the host:

```bash
ssh neatech@62.109.146.43

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

Den accepts uploaded debug-log batches at `POST /v1/internal/debug-logs` for server-to-server `veslo-server` shipping and at `POST /v1/desktop-diagnostics` for signed-in desktop fallback diagnostics when the local server is unavailable or not a trusted carrier. Both routes write to the application-queryable debug-log store: metadata is queryable, while payload content is encrypted and returned only through admin read paths.

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

To check a specific user's recent debug-log metadata without printing payloads or secrets:

```bash
TARGET_EMAIL=peter.durik@neatech.cz

compose exec -T -e TARGET_EMAIL="$TARGET_EMAIL" den sh -lc 'cd /app/services/den && node' <<'NODE'
const mysql = require("mysql2/promise");

const targetEmail = process.env.TARGET_EMAIL?.trim().toLowerCase();
if (!targetEmail) {
  throw new Error("TARGET_EMAIL is required");
}

(async () => {
  const connection = await mysql.createConnection(process.env.DATABASE_URL);
  try {
    const [users] = await connection.execute(
      "SELECT id, email, name FROM `user` WHERE lower(email) = ? LIMIT 1",
      [targetEmail],
    );
    const user = Array.isArray(users) ? users[0] : null;
    if (!user?.id) {
      console.log(JSON.stringify({ user: null }, null, 2));
      return;
    }

    const [lastHourEvents] = await connection.execute(`
      SELECT
        COUNT(*) AS eventCount,
        MAX(event_timestamp) AS latestEventTimestamp,
        MAX(created_at) AS latestCreatedAt
      FROM debug_log_event
      WHERE user_id = ? AND event_timestamp >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 HOUR)
    `, [user.id]);

    const [latestSessions] = await connection.execute(`
      SELECT
        id,
        user_agent AS userAgent,
        created_at AS createdAt,
        updated_at AS updatedAt,
        expires_at AS expiresAt
      FROM \`session\`
      WHERE user_id = ?
      ORDER BY updated_at DESC
      LIMIT 10
    `, [user.id]);

    console.log(JSON.stringify({
      user,
      lastHourEvents: lastHourEvents[0],
      latestSessions,
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

If `debug_log_batch` and `debug_log_event` are empty, Den is configured to accept debug logs but no desktop/server process has uploaded any events. Desktop-launched `veslo-server` only forwards to Den when it is started with `VESLO_LOG_INGEST_URL` and `VESLO_LOG_INGEST_TOKEN`; otherwise events stay in the user's local spool and are not queryable from the cloud server.

In updater investigations on Windows, also collect `C:\ProgramData\veslo-updater-msi.log` from the affected machine because the Windows MSI installer writes there independently of Den debug-log ingest.

For clean-install MSI failures, collect the newest `%TEMP%\MSI*.LOG` file from the affected Windows user. Veslo MSI packages set `MsiLogging=voicewarmupx!`, so a double-clicked install should create this verbose Windows Installer log even when the failure happens before Veslo's PowerShell runtime scripts start. The log can also include the final log path in the `MsiLogFileLocation` property.

If Veslo's WSL helper logs end with `WSL prerequisite helper finished with exit code 0` but Windows Installer still reports a generic failure, inspect the MSI log for WebView2 custom actions. Current validation MSI builds must use `webviewInstallMode.type = "skip"` and must not contain `DownloadAndInvokeBootstrapper`, `InvokeBootstrapper`, or `InvokeStandalone`; those generated actions run a nested WebView2 installer and can fail the MSI after Veslo's WSL setup has already succeeded.

For clean-install WSL runtime setup issues, also collect `%ProgramData%\Veslo\logs\wsl2-client-installer.log`, `%ProgramData%\Veslo\logs\wsl2-prerequisite-installer.log`, `%ProgramData%\Veslo\logs\wsl2-runtime-setup-status.txt`, `%ProgramData%\Veslo\runtime-setup-restart-required.marker`, `%LOCALAPPDATA%\Veslo\logs\wsl2-client-installer.log`, and `%LOCALAPPDATA%\Veslo\logs\wsl2-sandbox-installer.log` when those files exist. MSI clean installs run the machine prerequisite phase as `NT AUTHORITY\SYSTEM`; if Windows reports `3010`, the MSI must surface the native Windows Installer restart requirement instead of masking it or launching Veslo. The machine phase also registers a non-interactive Active Setup startup continuation so the target user context can import/provision `VesloSandbox` after reboot. That continuation may re-register an HKCU RunOnce retry if WSL is still settling or sandbox provisioning fails. NSIS clean installs also print these paths in the installer detail log and stop on non-restart runtime setup failures.

If one of these logs ends after `wsl.exe --status`, check whether the next lines report `Native command timed out after 45 seconds` and exit code `1460`. That means the Windows WSL command hung rather than returning a normal status. MSI installs should then complete the package install and leave first-run onboarding/Settings repair to retry with user-visible guidance.

Newer WSL installer helpers print a `Script revision:` line near the start of their logs. If that line is missing after installing a validation MSI that should contain it, the affected machine is still running an old installed helper. Current MSI packages remove the old WSL helper `.ps1` files from `INSTALLDIR` during install before copying the new files.

When the client runtime installer logs `wsl.exe --status failed` because WSL is not installed, the next expected step is `WSL status already failed; skipping redundant prerequisite check and launching elevated WSL prerequisite install from the installer flow.` A log that stops at a local `wsl2-prerequisite-installer.ps1 -CheckOnly` invocation is from an older validation helper.

If `wsl2-prerequisite-installer.ps1 -Install` returns `1` or `2`, inspect the same prerequisite log for the current script revision. Current MSI machine setup does not call `wsl.exe` or nested `msiexec` under LocalSystem. It checks Windows optional feature state, enables `Microsoft-Windows-Subsystem-Linux` and `VirtualMachinePlatform`, and stages the modern WSL MSIX bundle with `Add-AppxProvisionedPackage` when needed. The client installer and Settings/onboarding repair output should include a `Latest WSL prerequisite helper transcript` section after prerequisite repair attempts.

## Veslo Server Debug-Log Pipeline

Desktop-launched Veslo servers and sidecars use the local debug-log forwarder and server pipeline documented in `docs/dev/state-and-config-reference.md`.

The important production distinction is:

- Docker/Compose logs show what each owned-server process wrote to stdout/stderr.
- Den debug-log ingest is the durable, application-queryable store for uploaded debug events.
- The two are not equivalent. If Den has zero debug-log events, Docker logs may still contain process output, but the application does not have queryable debug-log history for those events.

## GlitchTip Error Monitoring

Veslo also has Sentry-compatible error monitoring through the internal Neatech GlitchTip deployment. Treat this as the error/exception surface, not as a replacement for Docker logs or Den debug-log ingest.

- Service: internal GlitchTip on `glitchtip.neatech.cz`
- Hosting: standalone `neatech-glitchtip` Docker Compose deployment on `neatech-internal-apps-01.cust.webglobe.com`
- Project: `veslo`
- Retention: GlitchTip event retention is configured on the GlitchTip service, currently 30 days in the running container

Monitoring is opt-in for local development and release-owned for GitHub desktop builds. Release builds configure the public `VESLO_GLITCHTIP_DSN` GitHub Actions variable once, pass it to `VITE_VESLO_GLITCHTIP_DSN`, and embed it into the native shell for installed macOS and Windows apps. The DSN is public and not user-configurable; the application must not expose a setting to change it. Publish workflows enable strict verification with `VESLO_REQUIRE_GLITCHTIP_RELEASE_ENV=1`; manual validation workflows can keep warning mode for missing values. The detailed variable list and privacy rules live in `docs/dev/state-and-config-reference.md`.

When investigating production errors, start with GlitchTip for grouped exceptions and stack traces. Use this runbook's Docker and Den sections when you need raw process output, encrypted debug-log metadata, sidecar forwarding behavior, or application-queryable log history.

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
