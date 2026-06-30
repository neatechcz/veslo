# State and Config Reference

This document describes the main persistence and config surfaces used by Veslo.

## Scope Categories

- App-global UI preferences: browser storage keys in the Solid app.
- Workspace-scoped config: `.opencode/veslo.json`.
- Workspace automation state: `.opencode/veslo/automations.json`.
- OpenCode config: `opencode.json` or `opencode.jsonc`.
- Server connection state: browser storage keys managed by `packages/app/src/app/lib/veslo-server/connection.ts` and re-exported through `packages/app/src/app/lib/veslo-server.ts`.
- Den auth state: browser storage keys managed by `den-auth.ts`.
- Desktop local proof cache: app-data JSON managed by Tauri commands.

## App-Global Browser Preferences

Primary keys are defined in `packages/app/src/app/constants.ts`, related app helpers, or persisted directly from `app.tsx`.

Common keys:

- `veslo.defaultModel`
- `veslo.showThinking`
- `veslo.modelVariant`
- `veslo.modelVariant.maxDefaultMigration`
- `veslo.language`
- `veslo.hideTitlebar`
- `veslo.autoCompactContext`
- `veslo.themePref`
- `veslo.updateAutoCheck`
- `veslo.updateAutoDownload`
- `veslo.updateLastCheckedAt`
- `veslo.baseUrl`
- `veslo.clientDirectory`
- `veslo.projectDir`
- `veslo.engineSource`
- `veslo.engineCustomBinPath`
- `veslo.engineRuntime`
- `veslo.onboardingComplete`

`veslo.updateAutoDownload` is default-off when absent. A stored `1` is an explicit opt-in; otherwise an available update stays in the manual download flow. Legacy default-on stored values are migrated off once with `veslo.updateAutoDownloadDefaultOff.v1`. When enabled, failed automatic update downloads are retried with bounded backoff. The retry state is runtime-only; only the preference, migration marker, and last successful check time are stored.

`veslo.modelVariant` stores the app-global model variant / thinking effort. The built-in default is `xhigh` (Max). Existing stored values from before the Max-default migration are overwritten to `xhigh` once and marked by `veslo.modelVariant.maxDefaultMigration`; later user changes remain stored in `veslo.modelVariant`.

Session/sidebar convenience state also lives in local storage, for example:

- last selected session per workspace
- active pending draft key
- session directory override map
- subagent decoration preferences
- left sidebar width
- dashboard nav collapsed state
- project grouping and collapse state
- parent session branch expansion state

Treat these as UI state, not product contract, unless a feature depends on them explicitly.

Developer-only UI surfaces are not enabled by default. The app derives developer mode from the current URL search string, and only a `debug` parameter with no value or a truthy value (`1`, `true`, `yes`, `on`) exposes debug-only panels, badges, and diagnostics. The separate `veslo:workspace-debug` local storage flag keeps workspace tracing available without showing developer-only UI.

Session archive records are loaded through the Veslo server archive API. When a cloud account is available, archive requests use that account id as the owner key. In local desktop mode without cloud auth, loopback Veslo server archive requests use the local desktop owner key `local:desktop`; remote archive requests still require a cloud account id.

Pending draft content itself is additionally mirrored into the desktop pending-draft store so the one unpublished draft survives restart with its current text, attachment chips, and selected send destination.

During workspace switches, the sidebar may already have task rows for the target workspace while the global session store still reflects the previous workspace or is startup-empty. The sidebar must keep those existing target rows until scoped sessions for the target workspace load, so a transient empty store does not hide a remote worker's project list.

## Workspace Activation State

Workspace activation state is runtime-only state managed by `packages/app/src/app/context/workspace.ts`.

- `workspaceConnectionStateById[workspaceId].status === "connected"`
  Means the workspace activation flow succeeded for the app surface.
- In Tauri local-to-local browsing mode, the active workspace can be `connected` even while the live OpenCode client is intentionally detached.
- In that browsing mode the app loads sidebar/session history from SQLite first, checking the active workspace's `.opencode/opencode.db` before legacy/global OpenCode database locations, and only re-attaches the engine when the user performs an action that requires it, such as sending a message.
- The sidebar connection dot treats this state as runtime-available when the Veslo server is also connected, so browsing a different local workspace does not appear as a false runtime failure.
- The fullscreen workspace switch overlay is driven by an explicit blocking switch target, not by `connectingWorkspaceId` itself or by global engine `busyLabel` values. `connectingWorkspaceId` remains a runtime/sidebar guard; passive local browsing and scoped runtime warmup must not create a blocking overlay target.
- Runtime readiness checks that can target a concrete workspace should use workspace-scoped readiness (`isWorkspaceRuntimeReady(workspaceId)` in the app shell), not the global `engineReady` signal. The global signal remains a compatibility fallback for the active workspace; send, SSE, sidebar live sync, permission polling, and MCP runtime reads are expected to gate on the target workspace.
- Runtime readiness and app-level routing client reads are owned by the app runtime owner. It derives runtime availability from orchestrator ready snapshots, workspace routing entries, active legacy `engineReady`, and workspace busy state, then exposes an owner-gated routing wrapper for session, extension/skill, system-state, and routing-context consumers. For Tauri local workspaces running through `veslo-orchestrator`, a cached routing entry alone is not a readiness proof; the workspace must be present in the orchestrator ready/idle snapshot or be the active workspace with a confirmed legacy `engineReady`. It does not start, stop, or activate engines; lifecycle mutations still belong to the workspace/runtime controllers.
- MCP runtime status refresh is single-flight by workspace, project directory, and the current MCP entry list key. If the configured MCP entry list changes while an older status request is in flight, the new list must schedule its own runtime status read and stale older success or failure results must not overwrite or clear the current status UI.
- Desktop bootstrap marks local workspaces whose root folder no longer exists as `missing` and skips provisioning for them. App activation must not start a host or recreate files for a missing local workspace; it should leave the workspace removable from Veslo and ask the user to remove it or choose the folder again.

## Workspace Removal State

Removing a workspace is detach-only by default: it removes the workspace from Veslo state and the local server registry without deleting the user's project folder. Destructive local cleanup requires an explicit `deleteLocalData`/`delete_local_data` mode. For normal user folders that mode removes Veslo/OpenCode local state (`.opencode` and `opencode.jsonc`) only. For app-created private workspaces under the desktop private workspace root, the same explicit mode removes the private workspace child directory because that folder is Veslo-owned scratch data.

## Den Auth State

Managed by `packages/app/src/app/lib/den-auth.ts`.

Primary keys:

- `veslo.den.auth`
- `veslo.den.keepSignedIn`
- `veslo.den.apiBaseOverride`
- `veslo.den.desktopAuthPending`

Meaning:

- `veslo.den.auth`
  Persisted authenticated Den session state.
- `veslo.den.keepSignedIn`
  Controls whether auth prefers local storage across launches or narrower session lifetime.
- `veslo.den.apiBaseOverride`
  Developer override for the browser sign-in endpoint.
- `veslo.den.desktopAuthPending`
  Temporary desktop auth handoff state during browser sign-in.

In Tauri startup flows, the desktop auth snapshot is allowed to repair stale browser auth state. A snapshot is explicitly signed out only when it carries no auth and disables `keepSignedIn`; a signed-in snapshot may still disable `keepSignedIn` to request session-only auth. If the snapshot explicitly represents a signed-out state, or if the snapshot user identity conflicts with the browser-stored user identity, the snapshot wins before the rest of app bootstrap continues. Matching or identity-ambiguous browser auth stays in place and re-syncs the desktop snapshot instead, while still honoring the snapshot's `keepSignedIn` preference.

Desktop auth snapshots can also carry first-run UI metadata such as language and onboarding completion. Those snapshot values only fill missing or invalid browser-stored UI preferences; they must not overwrite a valid local `veslo.language` or `veslo.onboardingComplete` value.

## Veslo Error Monitoring

Veslo can send application errors to a Sentry-compatible service such as the internal Neatech GlitchTip instance. Monitoring is disabled unless a DSN is explicitly configured.

Release desktop builds get their GlitchTip DSN from the public, release-owned `VESLO_GLITCHTIP_DSN` GitHub Actions variable. The same value is passed to `VITE_VESLO_GLITCHTIP_DSN` for the frontend build and embedded into the native Tauri shell at compile time for installed macOS and Windows apps. This DSN is not a secret, but it is not user-configurable and the application must not expose a setting to change it.

Frontend environment variables:

- `VITE_VESLO_GLITCHTIP_DSN` - Sentry-compatible project DSN for browser/Solid errors. Required to enable frontend monitoring.
- `VITE_VESLO_GLITCHTIP_ENABLED` - optional kill switch. Values `0`, `false`, `no`, or `off` disable monitoring even when a DSN is present.
- `VITE_VESLO_GLITCHTIP_ENVIRONMENT` - optional environment name. Defaults to `production` for production frontend builds and `development` otherwise.
- `VITE_VESLO_GLITCHTIP_TRACES_SAMPLE_RATE` - optional trace sample rate, clamped to `0..1`. Defaults to `0`.

Desktop shell environment variables:

- `VESLO_GLITCHTIP_DSN` - Sentry-compatible project DSN for native Tauri/Rust errors. Required to enable native monitoring. Release builds embed this from the GitHub Actions variable when the runtime environment does not provide it.
- `VESLO_GLITCHTIP_ENVIRONMENT` - optional environment name. Defaults to `production` in release builds and `development` in debug builds.
- `VESLO_GLITCHTIP_TRACES_SAMPLE_RATE` - optional trace sample rate, clamped to `0..1`. Defaults to `0`.

Privacy defaults:

- Default user/personally identifying data is not sent.
- Browser session tracking is removed from the default Sentry browser integrations because GlitchTip does not support Sentry release-health sessions.
- The centralized app `reportError` path forwards handled errors with only Veslo context and severity tags. It must not attach workspace file contents, prompts, transcripts, access tokens, or raw debug-log payloads.

## Veslo Server Connection State

Managed by `packages/app/src/app/lib/veslo-server/connection.ts`.
Public callers should still import helpers from `packages/app/src/app/lib/veslo-server.ts`.

Primary keys:

- `veslo.server.urlOverride`
- `veslo.server.port`
- `veslo.server.token`

These control which Veslo server URL the app connects to and which bearer token it sends.

Invite-link and bundle-link parsing also lives in `packages/app/src/app/lib/veslo-server/connection.ts`.
Incoming query parameters can override the stored connection state for a launch flow.

The desktop shell also persists the managed local `veslo-server` process snapshot in the app-local data directory so a new app process can recover a still-running server. For the live managed child, native `veslo_server_info` reports process ownership and keeps the recorded URL/token/PID while the child is alive; HTTP health is polled separately by the frontend. Persisted snapshots from a previous app process still require a successful `/health` check before recovery and are cleaned up when stale.

Desktop-managed local Veslo server uses the fixed port `8787` and binds to loopback by default. The desktop runtime must not fall back to a dynamic port when `8787` is unavailable; port contention is a startup/recovery failure that must be resolved by stopping or recovering the process that owns the fixed port. The desktop E2E harness is the exception: it sets `VESLO_DESKTOP_SERVER_PORT` through its launcher, using `E2E_VESLO_SERVER_PORT` when provided or otherwise an auto-selected free port, so tests can run next to a user-launched production app without claiming `8787`. Same-machine app code that derives a local Veslo server URL from an OpenCode URL should normalize back to `http://127.0.0.1:8787` for the managed server outside this explicit harness override. `VESLO_DESKTOP_SERVER_HOST` is an explicit developer/operator override for external binds such as `0.0.0.0`; normal installed app startup should not require a local-network/firewall permission prompt.

Managed local sidecars distinguish internal runtime URLs from advertised connect URLs. Same-machine communication between the desktop shell, `veslo-server`, `veslo-orchestrator`, OpenCode, and `veslo-code-router` uses loopback OpenCode URLs such as `http://127.0.0.1:<port>`, and managed OpenCode binds to loopback unless `VESLO_OPENCODE_BIND_HOST` explicitly opts into an external interface. LAN, mDNS, and WSL-reachable engine URLs are for external clients or sandbox bridge modes only; they must not be passed as the local `--opencode-base-url` or `--opencode-url`, because sleep/resume and network changes can invalidate those addresses while the local OpenCode process remains healthy.

Release desktop builds must use bundled sidecars for `veslo-server`, `veslo-orchestrator`, `veslo-code-router`, and the default OpenCode runtime. If a bundled sidecar is missing, the app should fail with a concrete startup error instead of launching `bun`, `veslo`, `opencode`, or router commands from the user's `PATH`. `VESLO_DESKTOP_ALLOW_EXTERNAL_RUNTIME_BINARIES=1` is a developer override for PATH-based debugging only. `VESLO_SERVER_DEV_WATCH=1` starts `bun --watch src/cli.ts`; release builds reject it unless the same external-runtime override is present.

When the Windows WSL2/bwrap sandbox is active, OpenCode runs inside the managed WSL runtime. Host workspace paths such as `C:\Users\...\repo`, WSL mount paths such as `/mnt/c/Users/.../repo`, and the sandbox alias `/workspace` can all describe the same active workspace. Session list filters, sidebar scoping, and conversation binding lookups must treat these forms as equivalent for engines that actually launched through WSL. This equivalence does not solve OpenCode data-home location by itself: a DB stored in WSL guest home still needs an explicit host-readable path or a server-side content tunnel.

The packaged Windows runtime defaults to the managed `VesloSandbox` distro. Personal WSL2 distros are not selected automatically when the managed distro is missing. `VESLO_WSL_DISTRO` can point at an explicitly provisioned alternative, and `VESLO_WSL_ALLOW_PERSONAL_DISTRO_FALLBACK=1` re-enables fallback selection for diagnostics only.

The local server reports the active path mode through `/capabilities.sandbox`. Desktop-launched `veslo-server` processes must receive `VESLO_SANDBOX_BACKEND` from the Tauri shell so the app can choose sandbox path aliases before host paths when WSL2 is active. Orchestrator proxy path rewriting must use the actual engine child kind: `windows-wsl2` path aliases apply only to engines launched through WSL, while direct fallback engines keep host paths. `VESLO_DISABLE_SANDBOX=1` remains the hard opt-out and forces `backend=none`.

Windows local workspace start must not hard-block on WSL prerequisites, the managed `VesloSandbox` runtime, or workspace path mountability. Both explicit local host startup and lazy first-prompt runtime startup pass through the local runtime readiness hook, then let the orchestrator attempt the configured sandbox launch. If `windows-wsl2` launch setup fails because WSL, `VesloSandbox`, bwrap, or workspace mountability is unavailable, the orchestrator must log the sandbox failure, emit the unsandboxed warning, and start a direct engine so local conversations remain usable while repair is pending.

Developer debug surfaces expose both configured and effective sandbox state.
Settings devtools and the exported runtime debug report include configured
backend/enabled, effective backend, engine child kind/source, directory query
mode, engine-bridge requirement, and `sandboxFallback`. Use these fields instead
of `/capabilities.sandbox` alone when debugging Windows WSL fallback behavior.

Windows installer/onboarding prerequisite repair must install or update the WSL package without creating a personal default distro, then import the managed `VesloSandbox` distro. Real WSL/VesloSandbox setup failures must be logged as failed runtime setup instead of reported as prepared runtime. MSI package installs run the machine prerequisite phase as `SYSTEM`: that phase may enable Windows WSL features, stage the modern WSL app package, write ProgramData status/marker files, disable installer-time app launch, and return `3010` so Windows Installer can require a restart. It must not mask `3010` to success, show a custom shutdown popup, or import a per-user distro under `SYSTEM`.

Windows validation MSI packages must not run a generated WebView2 installer custom action. Tauri's `downloadBootstrapper`, `embedBootstrapper`, and `offlineInstaller` modes all add a nested WebView2 installer action with `Return=check`; download failures, WebView2 installer return codes, or restart-required outcomes can surface as a generic MSI failure after Veslo's own WSL setup has already succeeded. Validation MSI builds therefore use `webviewInstallMode.type = "skip"` and rely on the system WebView2 runtime while the WSL/reboot/Active Setup flow is under test.

After reboot, Veslo registers a non-interactive user-context startup continuation through Active Setup. That continuation waits briefly for WSL to become usable, imports/repairs `VesloSandbox` without elevation, and re-registers an HKCU RunOnce retry if WSL is still settling or sandbox provisioning fails. First-run onboarding and Settings repair remain the visible sandbox repair path; lazy first-prompt startup must continue through orchestrator direct fallback instead of blocking solely because the Windows WSL2 sandbox is not ready.

## Desktop Debug Log Forwarder

Production owned-server application log discovery and operational read commands
live in `docs/dev/veslo-application-logs.md`. Update that runbook whenever log
creation, forwarding, storage, retention, service names, or read commands change.

The Tauri shell writes a desktop-owned debug-log spool before handing events to the veslo-server debug log pipeline. Implementation lives in `packages/desktop/src-tauri/src/debug_logs_forwarder.rs`.

Spool location:

- `${VESLO_APP_LOCAL_DATA_DIR or app_local_data_dir()}/desktop-debug-log-spool/`
- `install-id.txt` — stable desktop install identifier used to correlate retries and app restarts.
- `pending.jsonl` — append-only file growing as sidecars emit lines and bootstrap diagnostics.
- `flushing-{uuid}.jsonl` — appears briefly during a flush; deleted on success, kept on failure for retry.

Behavior:

- A dedicated OS thread wakes every 5 s, atomically renames `pending.jsonl` to a `flushing-*` file, and first tries to POST batches of up to 500 events to `http://127.0.0.1:{port}/debug-logs` with `x-veslo-host-token` when veslo-server state has a base URL and host token. Server-side validation lives in `validateDebugLogBatch`.
- If veslo-server is missing, rejects the batch, lacks host-token/base-url state, or returns `cloudUploadEnabled: false`, the desktop uses the signed-in Den auth context to POST only desktop-owned diagnostics to `POST /v1/desktop-diagnostics`. The direct path is intentionally narrower than the local debug-log path: it accepts bootstrap diagnostics, Veslo server launch diagnostics, and `veslo-server-shell` stdout/stderr, but not arbitrary UI logs, prompts, transcripts, screenshots, or workspace file contents.
- Source labels in events: `Veslo bootstrap` for structured desktop diagnostics, `veslo-server-shell` for Tauri-side capture of Veslo server stdout/stderr, plus other sidecar labels such as `opencode-router`, `orchestrator`, and `engine` that are only shipped through the local veslo-server route. `chrome-devtools-mcp` is covered transparently because it runs as an orchestrator child.
- Retention: `pending.jsonl` is truncated back to ~35 MB whenever it crosses the 50 MB high-water mark. Truncation drops the oldest lines and keeps the JSONL boundary clean.
- Resilience: POST failures or missing cloud context leave the `flushing-*` file in place; the next tick retries. After a direct Den fallback failure, the desktop backs off further direct attempts for one minute and marks that flushing file as direct-retry-only so it does not keep reposting the same file to the local server while Den is unavailable. If direct diagnostics upload succeeds for a mixed file, only direct-eligible events are removed and non-direct events stay in the local spool for later veslo-server delivery.

This forwarder is independent of the veslo-server pipeline below — events arrive at the server endpoint and join the same downstream spool/uploader path.

## Veslo Server Debug Log Pipeline

The server can capture structured runtime logs (its own logger output, audit entries, and any batch posted by the desktop shell to `POST /debug-logs`) into a durable on-disk spool and forward them to a remote ingest endpoint such as Den. The pipeline lives in `packages/server/src/debug-log-pipeline.ts` and is wired into `startServer` so no caller has to manage spool or retry logic.

Environment variables (all optional):

- `VESLO_LOG_INGEST_URL` — remote ingest URL (e.g. Den `/v1/internal/debug-logs`). Required to enable upload.
- `VESLO_LOG_INGEST_TOKEN` — bearer token sent as `Authorization: Bearer …`. Required to enable upload.
- `VESLO_LOG_BATCH_MAX_EVENTS` — events per upload batch (default 200).
- `VESLO_LOG_BATCH_MAX_BYTES` — bytes per upload batch (default 256 KB).
- `VESLO_LOG_SPOOL_MAX_BYTES` — soft cap for the local spool (default 100 MB). When the spool reaches 90 % of this value the pipeline drops oldest events down to 70 %.
- `VESLO_LOG_FLUSH_INTERVAL_MS` — uploader flush cadence (default 5000 ms).

Pipeline behavior:

- `enabled` is derived as `Boolean(ingestUrl && ingestToken)`. Without both vars the server route reports `cloudUploadEnabled: false` and does not retain desktop-forwarded events indefinitely; the desktop direct diagnostics path is responsible for bootstrap/server-launch fallback delivery after login.
- Server data dir default: `VESLO_DATA_DIR` wins when set. Without it, Windows uses `%LOCALAPPDATA%\com.neatech.veslo\veslo-server` (falling back to `%APPDATA%`), while macOS/Linux keep `<home>/.veslo/veslo-server`. On Windows, an existing legacy `<home>\.veslo\veslo-server` directory is copied into the AppData default on first resolve; if that copy fails, the server falls back to the legacy path so existing bindings and caches do not disappear after update.
- Desktop orchestrator data dir default: `VESLO_DATA_DIR` also controls the managed orchestrator. Dev startup sets it to `%LOCALAPPDATA%\com.neatech.veslo.dev\veslo-orchestrator-dev` on Windows so scratch, engine state, and OpenCode config stay under AppData. When that dev default is used, the Windows launcher copies missing files from the legacy `<home>\.veslo\veslo-orchestrator-dev` store and merges legacy `conversation_binding` rows into the AppData binding DB. Without an override, the production desktop fallback uses `%LOCALAPPDATA%\com.neatech.veslo\veslo-orchestrator` on Windows and `<home>/.veslo/veslo-orchestrator` on macOS/Linux.
- Spool location: `<server data dir>/debug-log-spool/events/`. One JSON file per event today (file-per-event format owned by `debug-log-spool.ts`); switching to JSONL append-only is tracked separately as a follow-up.
- Upload retry policy lives in `debug-log-uploader.ts` (3 attempts, 250 ms initial, 2× multiplier, capped at 2 s). Failed batches stay leased in the manifest and the next flush tick re-leases them after the lease TTL.
- Retention is enforced asynchronously after appends and by a maintenance loop that runs even when remote upload is disabled. The spool can temporarily exceed `VESLO_LOG_SPOOL_MAX_BYTES`, but `/debug-logs` ingest stays off the cleanup hot path and bulk-prunes old unleased events back toward the low-water mark.
- `POST /debug-logs` validates the host token and batch body, awaits the durable append when server-side cloud upload is configured, and returns `202 { ok: true, acceptedBatchIds, cloudUploadEnabled }`. Append failures return through the normal server error path so the desktop keeps its local copy.
- Process signals: `startServer` registers SIGINT/SIGTERM handlers that drain the pipeline (final flush) before exit.

## Den Debug Log Ingest

Den accepts uploaded debug-log batches from `veslo-server` at `POST /v1/internal/debug-logs`. The route uses a dedicated server-to-server bearer token (`DEN_LOG_INGEST_TOKEN`) and stores each event payload encrypted with `DEN_LOG_MASTER_KEY` plus operator-managed `DEN_LOG_MASTER_KEY_VERSION`.

Den also accepts the desktop fallback stream at `POST /v1/desktop-diagnostics`. That route uses the signed-in user's Better Auth bearer token and verifies org membership before ingesting into the same encrypted debug-log store. It accepts only desktop-owned diagnostics lanes (`Veslo bootstrap` diagnostic events and `veslo-server-shell` stdout/stderr), and it rejects arbitrary debug-log sources.

Environment variables:

- `DEN_LOG_INGEST_TOKEN` - internal bearer token required for ingest.
- `DEN_LOG_MASTER_KEY` - master key material used for AES-GCM payload encryption.
- `DEN_LOG_MASTER_KEY_VERSION` - key version stored with each event so manual rotations are traceable.
- `DEN_LOG_RETENTION_DAYS` - retention window for stored events and idempotency batch records (default 30).

Storage behavior:

- Searchable metadata remains cleartext: user, org, workspace, session, run, source, stream, level, event timestamp, sequence number, payload hash, and payload size.
- Raw payload content is encrypted before database insert and returned only through the admin read path.
- Batch id and `Idempotency-Key` are stored so `veslo-server` retry uploads are accepted without duplicating rows.
- Den runs a startup purge and daily retention loop for expired debug-log rows.

Read path:

- `GET /admin/api/debug-logs`
- `GET /admin/api/debug-logs/:eventId`
- `GET /admin/api/debug-logs/export`

This backend-first slice is platform-admin-only. A narrower `debug-logs-reader` role and full static Admin UI page remain follow-up work.

## Owned-Server Backup Config

Owned-server database backups are production Compose operations, not app runtime state. The production backup root is `/srv/veslo/backups`, mounted into the `backup` service from the host.

Backup failure email reuses the existing Lettr configuration from the owned-server env file. The production env file used by the deployment workflow is the authoritative source for backup alert recipients and mail transport values:

- `LETTR_API_KEY`
- `AUTH_EMAIL_ADDRESS`
- `AUTH_EMAIL_FROM_NAME`
- `BACKUP_ALERT_EMAIL_RECIPIENTS`
- `AI_GATEWAY_ALERT_EMAIL_RECIPIENTS`

`BACKUP_ALERT_EMAIL_RECIPIENTS` should contain all current admins who must receive failure alerts. It belongs beside the Lettr values in the production env file. If the dedicated backup recipient list is blank, the alert helper falls back to `AI_GATEWAY_ALERT_EMAIL_RECIPIENTS`.

The production backup image includes `zstd`, Node.js, and the MySQL client. Compressed dumps are written as `.sql.zst` files and verified with `zstd -t`. Checksums are verified with `sha256sum -c`.

Scheduling is owned by the `backup` service in `packaging/owned-server/compose.yml`. The service runs `packaging/owned-server/backup/backup-owned-server-databases-loop.sh`, which starts `backup-owned-server-databases.sh` daily at `BACKUP_DAILY_UTC_TIME` plus up to `BACKUP_RANDOM_DELAY_SECONDS` jitter. The deployment workflow can also run an immediate one-off backup with `run_backup_now`.

## Managed-AI Routing and Accounting

Managed-AI inference routing is configured separately from signed-in app identity. Desktop and orchestrator defaults use the owned standalone AI Gateway at `https://ai.veslo.work`; `VESLO_MANAGED_AI_BASE_URL` overrides it, with `VESLO_AI_GATEWAY_BASE_URL` retained as the legacy fallback. The previous Render AI Gateway remains a transition and rollback surface, not the default for new builds.

AI Gateway `/health` is process liveness only. Use `/readiness` when the product, admin UI, or monitors need to show AI inference availability: it checks upstream provider reachability, at least one healthy credential, and at least one enabled AI-access policy. The local server exposes the same frontend-visible readiness through `/ai-gateway/readiness`; send-time provider proxy failures remain authoritative and continue returning normalized upstream failure diagnostics.

The desktop app keeps a local managed-AI access proof cache so it does not have to repeat `GET /ai-gateway/me/ai-access` on every reactive pass or process restart. The cache lives in:

- `${VESLO_APP_DATA_DIR or app_data_dir()}/access-proofs.v1.json`

Managed-AI proof entries are valid for 3 days. They store only non-secret policy metadata: a hashed cache key, fetch time, provider id, default model, allowed models, and optional policy timestamps/fingerprints. Gateway or Den bearer tokens are never written to this file; prompt/config paths still use the current Den auth token or local Veslo server client token at runtime. The cache key is based on Den user id, org id, and the managed gateway base URL. On desktop the app prefers stable Den/gateway identity over the local loopback Veslo server URL so local sidecar port changes do not invalidate the proof.

The same file format has a reserved `workspacePermissions` array for future local permission proof caching. That path is not active in the frontend today; workspace permission polling is still governed by runtime engine readiness and existing workspace config.

Desktop local workspaces separate the managed-AI access-policy source from the OpenCode provider routing target. The app may load the user's policy and gateway token from DEN or standalone AI Gateway, but generated OpenCode config must not persist live gateway credentials in `opencode.json` or `opencode.jsonc`. The generated provider `baseURL` points at the active local Veslo server, and local server authentication is referenced with `{env:VESLO_OPENCODE_SERVER_CLIENT_TOKEN}` so prompts keep flowing through the local-first runtime without commit-prone secrets. The generated model headers include only `x-veslo-session-id = ${OPENCODE_SESSION_ID}`; workspace identity is request/runtime state and must not be persisted into provider model config. The local proxy resolves placeholder session ids from OpenCode's real request session header (`x-session-id`) and falls back to workspace correlation only for legacy single-workspace active-run cases. Legacy `x-veslo-workspace-id` model headers are treated as stale config and are scrubbed by managed-AI config sync. The cloud gateway bearer is held only in local Veslo server runtime memory and attached by the proxy.

When the local Veslo server proxies managed-AI requests, successful JSON and streamed provider responses are passed through. Upstream non-2xx failures are normalized to a local `502` JSON error so a managed-AI gateway/provider block is not reported as local server authentication failure. The error details include a generated request id, provider/model/session/user/org context when available, upstream status/request id/content type, and a short sanitized upstream response snippet.

The local proxy must not parse the full provider request body before forwarding it. OpenCode can send large or chunked accumulated-session payloads, so local model extraction for error diagnostics is limited to small JSON requests with a known `Content-Length`; stream and large-body requests are forwarded without diagnostic pre-buffering.

The local server also treats body parsing as byte-bounded infrastructure. AI gateway error details include only a bounded sanitized upstream preview, large provider JSON success responses remain streamed, OpenCode JSON helper responses have explicit parsing limits, and local JSON/form ingest rejects oversized request bodies before validation or multipart parsing when possible. Transcript prefetch caches are bounded by estimated bytes as well as entry count, so large tool outputs cannot remain resident solely because the session count is low.

OpenCode JSON helper calls made by the local server use a bounded upstream timeout so stale interface URLs or hung sockets cannot hold UI-facing server routes for OS-level TCP timeouts. The default is 5000 ms and can be overridden for diagnostics/tests with `VESLO_OPENCODE_JSON_FETCH_TIMEOUT_MS`. Streaming pass-through proxy routes are not governed by this helper timeout.

Streaming pass-through OpenCode proxy routes (`/workspace/:id/opencode/*`) bound only the wait for upstream response headers (default 75 000 ms, override with `VESLO_OPENCODE_PROXY_HEADERS_TIMEOUT_MS`); once headers arrive, streamed bodies such as SSE are never cut. The orchestrator side of the same proxy never spawns an engine for `GET`/`HEAD` requests: when no engine is running for the workspace it responds immediately with `503 engine_not_running`, so background status polls (MCP, permission, LSP, health) fail fast instead of triggering and waiting on a 30-60 s engine cold start. Engines spawn only through explicit workspace activation and through non-GET proxy requests (the send path).

Desktop workspace activation passes the target workspace id to the orchestrator, not only the local path. This keeps the activated pool entry, the app route, and the `/workspace/:id/opencode/*` proxy URL on the same workspace identity even when persisted paths were imported from another profile or normalized differently. Send preflight health checks treat failed health probes against an existing routed local client as not-ready and recover the route before session creation; known stale signals include local OpenCode `engine_not_running`, `workspace not found`, `workspace_id_mismatch`, wrapped OpenCode request failures, and local 404/502/503 health responses. A completed workspace activation is not by itself treated as a completed health probe, and if recovery cannot prove a routed client the send blocks before creating pending UI state.

The desktop app recognizes managed Codex credential exhaustion or missing eligible binding inside these normalized errors and formats it as an actionable AI access failure. Prompt sends that hit this condition set the session run state to failed and insert the error into the transcript instead of leaving OpenCode's empty assistant turn looking like an active run.

DEN managed-AI uses `MANAGED_AI_DATABASE_URL`. Standalone AI Gateway uses `AI_GATEWAY_DATABASE_URL`. Their assignment, credential, eligibility, and usage views match only when those services are intentionally pointed at the same managed-AI backing database and compatible config.

Managed-AI provider assignments may use `openai`, `anthropic`, `codex_oauth`, or `openai_compatible`. The desktop app treats these assignments as read-only policy and writes local OpenCode routing for the assigned provider. AI access rows also store `assignment_origin`: `auto_assigned` for DEN sign-up Codex defaults and `admin_assigned` for explicit admin edits or legacy rows. For `codex_oauth`, OpenCode still owns local tool execution and calls the local Veslo server route `/ai-gateway/providers/codex_oauth/v1`; the configured managed-AI service keeps the Codex OAuth auth JSON server-side, translates the OpenAI-compatible request to the ChatGPT Codex Responses endpoint, and translates the response back for OpenCode. Standalone AI Gateway admin model pickers use live upstream discovery for `openai_compatible` credentials and a gateway-owned Codex model catalog for `codex_oauth` credentials. Codex status probes run from temporary Codex homes with the gateway's default Codex model, and refreshed probe auth JSON is written back to the credential's encrypted secret when Codex rotates it. If a Codex status probe reports refresh-token reuse, the standalone admin service quarantines the credential as unhealthy; the admin Reconnect action replaces the stored auth JSON in place and marks the same credential healthy again. If a Codex status probe reports that a specific model is unsupported for the credential's ChatGPT account, the credential remains available and that model is filtered from the credential's admin model list. Any assigned Codex row can be repaired to another healthy eligible Codex credential on the next request when its assigned credential becomes unhealthy, revoked, missing, permanently unavailable, or exhausted; the original assignment origin is preserved after repair, and legacy repairs without a stored model use the Codex catalog default. For `openai_compatible`, OpenCode uses the local Veslo server route `/ai-gateway/providers/openai_compatible/v1`; the upstream custom base URL and API key remain server-side in the configured managed-AI service's encrypted secret store.

Standalone AI Gateway credentials can be soft-deleted only after they are no longer usable and are not referenced by user AI-access policy. Active leases and assignment references still block soft-delete unless the credential is already revoked. Soft-deleted rows keep their credential id for audit, usage, and alert history, but `deleted_at` removes them from default admin lists, assignment options, rotation, and runtime selection; their stored secret is replaced with a deleted tombstone.

Standalone AI Gateway credential/account alert emails use DEN platform admins as the primary recipient list. DEN exposes them through `GET /v1/internal/platform-admin-recipients`, guarded by `DEN_AI_GATEWAY_INTERNAL_TOKEN`; AI Gateway calls that route with `AI_GATEWAY_DEN_INTERNAL_TOKEN`. `AI_GATEWAY_ALERT_EMAIL_RECIPIENTS` is a fallback for credential alerts when DEN lookup fails and is the configured recipient list for Codex capacity alerts. AI Gateway must also receive `LETTR_API_KEY`, `AUTH_EMAIL_ADDRESS`, and `AUTH_EMAIL_FROM_NAME` for email delivery. `AI_GATEWAY_CREDENTIAL_ALERT_EMAIL_INTERVAL_MS` controls the per-credential/account fault monitor cadence; `AI_GATEWAY_CODEX_CAPACITY_ALERT_EMAIL_INTERVAL_MS` controls the separate Codex capacity monitor cadence. The Codex capacity monitor emails for high/critical capacity thresholds and for partial or total loss of Codex limit visibility, including the case where a healthy credential shows `Codex OK, limits unknown` while other credentials still expose measurable limits.

The credential alert monitor emails the first active unresolved fault per credential/account reason and recipient, then throttles repeats for the same credential, same normalized reason/title, and same recipient for 24 hours. Later healthy credential-health events resolve earlier fault alerts for the same credential, so an expired throttle does not resend email after the underlying issue has recovered. It covers provider auth failures, quota/rate-limit failures, provider network failures, OpenAI-compatible/Codex transport failures, and assigned credentials that can no longer be resolved. It intentionally does not email for request validation errors, missing gateway auth/session headers, AI-access policy denial, recovered or already resolved alerts, or Codex capacity alerts handled by the capacity monitor.

Usage rows store request id, user id, org id, session id, credential record id, input tokens, output tokens, cached tokens, and total tokens. See `docs/features/session-runtime.md` for runtime selection, `all_codex_credentials_exhausted`, and temporary ineligibility semantics.

## Workspace-Scoped Config

Workspace config lives in:

- `<workspace>/.opencode/veslo.json`

The app-level type is `WorkspaceVesloConfig` in `packages/app/src/app/types.ts`.

Current structure:

- `version`
- `workspace.name`
- `workspace.createdAt`
- `workspace.preset`
- `authorizedRoots`
- `reload.auto`
- `reload.resume`

Meaning:

- `authorizedRoots`
  Roots the workspace may access through Veslo-managed local flows.
- `reload.auto`
  Whether queued reloads should apply automatically when the workspace is idle.
- `reload.resume`
  Whether Veslo should try to restore session continuity after an automatic reload.

## Workspace Automation State

Persistent Veslo automations live in:

- `<workspace>/.opencode/veslo/automations.json`

The file stores automation definitions and run history together under schema
version 1. Definitions include `name`, `prompt`, `schedule`, `target`,
`enabled`, `status`, `nextRunAt`, and timestamps. Runs are append-or-replace
history records keyed by run id and are not removed when an automation is
completed or cancelled.

The local `veslo-server` process owns runtime scheduling. On startup it creates
an automation runner only for writable, authorized configured workspaces, reads
the canonical store, initializes missing `nextRunAt` values for active enabled
automations, recovers recent due runs, skips stale missed runs after the runner
grace window, and sends prompts to the workspace OpenCode upstream. Mutating
automation routes refresh the runner for that workspace after the store write.

Legacy Agent Lab scheduler data may still exist at:

- `<workspace>/.opencode/veslo/agentlab/automations.json`

When the canonical automation file is absent, server reads migrate valid legacy
items into `.opencode/veslo/automations.json` and preserve legacy last-run
metadata as run history. The legacy file is left in place for compatibility; the
canonical file becomes the source of truth after migration. Read-only server
instances return the migrated view without writing the canonical file.

## OpenCode Config

OpenCode config lives in one of:

- `<workspace>/opencode.json`
- `<workspace>/opencode.jsonc`
- some flows also inspect `.opencode/opencode.json`

Use this surface for:

- plugins
- MCP server config
- agent overrides
- command-related OpenCode settings

Veslo pages that mutate plugins or MCP are usually editing this config, not `.opencode/veslo.json`.
The UI separates these concerns: Pluginy owns OpenCode plugin management, while
Napojení owns MCP servers and external-app connections. They are separate
dashboard tabs even though both can persist changes into OpenCode config.

Platform Google Workspace MCP installs write normal remote MCP entries into
OpenCode config. The entries point at Veslo-owned connector endpoints and may
include non-secret runtime headers. They must not include Google OAuth client
secrets, Google access tokens, or Google refresh tokens.

Veslo-managed connector runtime headers are renewable config material, not
provider authorization state. If a configured connector MCP reports an
authorization-like runtime failure, the app may ask the local Veslo server to
fetch a fresh short-lived connector token from Den and update the
`X-Veslo-Connector-Token` header in the workspace OpenCode config, then retry
the MCP status read once. This refresh path must not start browser OAuth and
must not revoke or create Google grants.

Google Workspace authorization is server-managed for production. Den owns the
Google OAuth callback, exchanges the code with Veslo's Google client secret,
and stores encrypted per-user grants by organization, user, and connector.
OpenCode config only represents local runtime installation, not Google grant
ownership.

Desktop workspace provisioning seeds the default Chrome MCP as a local command
using `npx -y chrome-devtools-mcp@latest --isolated`. Existing
`chrome-devtools` or `control-chrome` aliases are not duplicated. Known legacy
aliases that still use `chrome-devtools-mcp --isolated` are migrated to the
same npx fallback so they work outside the desktop sidecar PATH as well.

## Skills Inventory

The Skills page builds an app-wide inventory from four sources:

- user skills from the Veslo user skill store
- legacy user skills from user-level OpenCode-compatible skill roots
- workspace-local skills discovered per readable local workspace
- Hub skills from the existing prepared catalog flow

Use product terminology consistently:

- **User skill** means a skill installed for the current user and available
  across workspaces. Code and registry payloads may still call this
  `user-global` or `personal-global`; those are implementation scopes, not
  product labels.
- **Workspace skill** means a skill installed in one workspace.
- **Organization skill** means a skill owned by an organization catalog.
- **Public skill** means a skill published for broad catalog discovery.
- **Installed skill** means an active local or registry installation.
  **Removed skill** means a local skill captured in the removal journal or a
  registry installation/policy that can be restored from registry state.

## Skill Removal Journal

Recoverable local skill removals are stored by Veslo server under:

- `<server data dir>/skill-removals/records/`
- `<server data dir>/skill-removals/snapshots/`

Each removal record stores the removal id, skill name, scope (`workspace` or
`user-global`), original path, actor, optional reason, snapshot hash, status,
and removal/restore timestamps. Workspace removals also store the workspace id.
The app-facing list route returns only recoverability metadata and does not
expose actor tokens, root directories, original path internals, or snapshot
hashes.

Local removal is snapshot-first. Veslo server copies the skill directory into
the journal, hashes the snapshot, writes a pending record, removes the original
directory, and then marks the record removed. Restore verifies the record,
authorized workspace roots where applicable, destination conflicts, and snapshot
hash before copying the snapshot back and marking the record restored.

The Skills page reads this journal through Veslo server and includes removed
user and workspace skills in the deleted/removed skills view. Restored records
are hidden from the default list unless explicitly requested.

Avoid product copy such as "global skill", "managed skill", or "adopt". Use
"user skill", "installed skill", "organization skill", "public skill",
"install", "publish", "remove", and "restore" instead.

User skills are runtime-available skills, not organization catalog or
admin-approved skills. Organization promotion and bulk rollout remain future
work until the Den/admin backend owns those concepts.

For inventory correctness, Veslo user skill store entries, legacy user skill
roots, and workspace skill roots are read separately. Runtime-effective
discovery may still include both scopes for active workspace behavior, but the
inventory must not expand user skills under every workspace. Workspace rows
represent only real workspace-local instances or overrides.

Veslo-created user skills are stored under the server data directory in the
user skill store. Enabled store entries are materialized into each active
workspace under `.opencode/skills/veslo-user/<name>/SKILL.md` during workspace
activation or explicit store sync. The store remains the source of truth; the
workspace copy is a runtime artifact for OpenCode and sandbox visibility. Sync
must not overwrite an existing workspace skill with the same name and should
return a conflict instead.

Private app-created workspaces, including new private chat workspaces, remove
workspace-local skill directories that are exact copies of user-root skills
during provisioning. User-root skills remain user-global inventory entries and
must not become private workspace-only entries.

Older desktop builds created `workspace-guide` and `get-started` as
workspace-local onboarding skills. They are no longer part of the runtime skill
catalog. Workspace provisioning removes those legacy directories only when the
contents still match the generated onboarding templates and the directory
contains no files other than `SKILL.md`; user-owned skills with the same names or
additional files are preserved.

Skill edit and save flows target a concrete inventory instance by scope,
workspace id, and path before falling back to name-based legacy commands.
Remove and restore target only concrete skill locations or registry records
that the app can mutate safely. Hub install uses an explicit target picker;
current writes are limited to the active workspace. Installing a user skill into
a workspace uses an explicit workspace picker and writes only to local workspace
skill roots. Private app-created workspaces are valid inventory sources when
they already contain skills, but they are not valid install targets and should
be omitted from workspace install pickers.
Bulk transfer actions are scoped by homogeneous inventory selections: selected
user skills can be installed into a workspace, selected workspace skills can be
copied or moved into user skills, and mixed user/workspace selections do not
expose transfer actions.

## Skill Registry State

The cloud skill registry introduces distribution state separate from runtime skill files. Registry state is cloud-owned and should not be inferred from local `.opencode/skills/` folders alone.

Registry-owned state:

- skill records, slugs, descriptions, tags, visibility, and review status
- immutable package versions and package digests
- personal, workspace, and organization installation records
- rollout policies for organization and platform distribution
- workspace desired skill sets
- review requests, reviewer decisions, and restore history

Local Veslo state:

- downloaded package archives before install
- cached package archives under `<server data dir>/skill-package-cache/`, keyed by package SHA-256 and verified before use
- unpacked runtime skill directories controlled by the local Veslo server
- server-controlled workspace skill materializations under `.opencode/skills/veslo-managed/`, with a root manifest and per-skill ownership markers
- app-facing resource inventory owner envelopes for MCP config entries, skills, plugins, commands, and Veslo user-global skill store records; these describe durable definition ownership and do not own MCP polling or connection state
- pre-change backups for server-controlled materialization replacement/removal under the Veslo data directory
- workspace activation or reload state after a skill set changes
- any temporary install progress, errors, or selected install target in the app UI

The local server validates registry responses before using them. Validators accept only the response fields needed by the app/server contract and delegate package manifest checks to the skill package model. They are not a backend implementation and do not replace registry-side authorization, review workflow, package storage, rollout policy enforcement, or audit enforcement.

Rollout policies keep catalog source separate from install target. An
organization or public skill can be targeted either as a user skill or as a
workspace skill, but the same effective skill/audience cannot have both target
types active at once. Target changes are retarget or move operations. Policy
removal can be `user_removable`, `admin_removable`, or `locked`; locked policies
are reserved for future required system skills and must be treated as
non-removable by normal users.

Registry-backed rollout policy changes are durable distribution state. Event
polling should invalidate visible skill inventory, mark active workspaces as
pending reload, and allow idle user-skill or workspace materialization to sync
through the local server. Offline clients keep using the last local lockfile and
materialization manifests until registry sync succeeds.

Registry search can be proxied through the local Veslo server at `/v1/skills/search` so the app can reuse server-side registry auth configuration and response validation. Search indexing remains registry-owned and includes package metadata plus searchable package text/code under the registry size limit; clients may pass language context for server-side query expansion and must not implement semantic skill search locally. Registry update events can be polled through `/v1/skill-registry-events`; active workspace updates should become pending reload state, while idle workspace and user-skill updates can be materialized immediately. Registry writes use host/owner-authenticated local proxy routes for skill creation, immutable version publishing, installation create/update/delete/restore, review request create/approve/reject, and workspace skill-set replacement. Runtime mutation remains explicit: `/workspace/:id/skills/materialization/sync` and `/skills/materialization/sync-global` require host or owner auth and must not rewrite server-controlled skill files while an agent run is active.

The Skills page now treats installed skills as an app-wide inventory with filterable location rows. UI filters are local presentation state. Registry-backed install and publish preparation can create the initial skill, version, and installation through the local server proxy. Registry-backed publish, approval, remove, restore, and workspace skill-set controls should call the local proxy only when the selected row has concrete registry identifiers for the action target, then refresh registry metadata and local inventory after success.

Registry auth is account-scoped:

- personal user: owns personal skills and personal installs
- workspace collaborator/admin: reads workspace skill sets; admins manage workspace installs
- org skill admin: manages organization skills, reviews, and org installs
- platform admin: manages platform skills and cross-tenant moderation

Registry-backed workspace skill-set changes are durable behavior. If the local app applies a changed workspace skill set, it should trigger the same server-backed install and reload semantics used for other skill mutations rather than writing only through the UI.

Desktop-launched local Veslo server instances preserve the app workspace id when registering local workspace roots. Standalone `veslo-server` still generates a stable path-hash id unless a config workspace `id` or matching `--workspace-id` is provided.

## Import and Export

Workspace config export/import is handled by `packages/app/src/app/stores/config-store.ts` and Tauri commands.

Current local archive format:

- export file extension: `.veslo-workspace`
- export/import is only supported for local workers
- import expects a target folder and then activates the imported local workspace

## Notion and Other Integration Status

Some lightweight status values are persisted in browser storage for UI continuity, for example:

- `veslo.notionStatus`
- `veslo.notionStatusDetail`
- `veslo.notionSkillInstalled`

Treat them as UI hints. The integration itself still depends on the real config/runtime state.

## Pending Draft Persistence

Desktop pending drafts are stored outside browser local storage in the Tauri app data directory.

Current behavior:

- pending draft metadata and attachment copies live in the desktop pending-draft store
- browser local storage keeps the active pending draft key so the app can restore the global unpublished draft route on restart
- unpublished chats use one global draft body for the whole app until the first message creates a real session
- the pending draft record uses a fixed global id, while its metadata records the selected destination: private chat, workspace id, and normalized directory
- `Chat`, project `+`, and the composer target picker move that one draft between destinations instead of loading separate workspace draft bodies
- old per-workspace pending draft records are obsolete and ignored rather than migrated
- real sessions still use normal per-session composer draft storage after the unpublished draft is materialized
- pending drafts remain out of the sidebar until a real session is created by sending them; a newly registered local directory may still appear immediately as the top empty workspace-only project row in by-project mode

## Precedence Rules

Use this general precedence order when debugging config:

1. Explicit invite or bundle link in the current URL
2. Explicit browser-stored override for the current app surface
3. Workspace-scoped config in `.opencode/veslo.json`
4. OpenCode config in `opencode.json` or `opencode.jsonc`
5. Environment defaults and built-in fallbacks

## Change Guidelines

- If a new persistent setting is user-facing, document its key and scope here.
- If a new workspace-level setting changes runtime behavior, document it here and in the matching feature doc.
- Do not document ephemeral signals or transient component state unless future agents must preserve it for correctness.
