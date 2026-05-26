# State and Config Reference

This document describes the main persistence and config surfaces used by Veslo.

## Scope Categories

- App-global UI preferences: browser storage keys in the Solid app.
- Workspace-scoped config: `.opencode/veslo.json`.
- OpenCode config: `opencode.json` or `opencode.jsonc`.
- Server connection state: browser storage keys managed by `veslo-server.ts`.
- Den auth state: browser storage keys managed by `den-auth.ts`.

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

`veslo.updateAutoDownload` is default-on when absent. A stored `0` is an explicit opt-out and keeps the manual download flow.

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

Session archive records are loaded through the Veslo server archive API. When a cloud account is available, archive requests use that account id as the owner key. In local desktop mode without cloud auth, loopback Veslo server archive requests use the local desktop owner key `local:desktop`; remote archive requests still require a cloud account id.

Pending draft content itself is additionally mirrored into the desktop pending-draft store so unpublished drafts survive restart with their current text and attachment chips.

During workspace switches, the sidebar may already have task rows for the target workspace while the global session store still reflects the previous workspace or is startup-empty. The sidebar must keep those existing target rows until scoped sessions for the target workspace load, so a transient empty store does not hide a remote worker's project list.

## Workspace Activation State

Workspace activation state is runtime-only state managed by `packages/app/src/app/context/workspace.ts`.

- `workspaceConnectionStateById[workspaceId].status === "connected"`
  Means the workspace activation flow succeeded for the app surface.
- In Tauri local-to-local browsing mode, the active workspace can be `connected` even while the live OpenCode client is intentionally detached.
- In that browsing mode the app loads sidebar/session history from SQLite first, and only re-attaches the engine when the user performs an action that requires it, such as sending a message.
- The sidebar connection dot treats this state as runtime-available when the Veslo server is also connected, so browsing a different local workspace does not appear as a false runtime failure.

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

## Veslo Server Connection State

Managed by `packages/app/src/app/lib/veslo-server.ts`.

Primary keys:

- `veslo.server.urlOverride`
- `veslo.server.port`
- `veslo.server.token`

These control which Veslo server URL the app connects to and which bearer token it sends.

Invite-link and bundle-link parsing also lives in `veslo-server.ts`. Incoming query parameters can override the stored connection state for a launch flow.

The desktop shell also persists the managed local `veslo-server` process snapshot in the app-local data directory so a new app process can recover a still-running server. For the live managed child, native `veslo_server_info` reports process ownership and keeps the recorded URL/token/PID while the child is alive; HTTP health is polled separately by the frontend. Persisted snapshots from a previous app process still require a successful `/health` check before recovery and are cleaned up when stale.

## Desktop Debug Log Forwarder

The Tauri shell forwards stdout/stderr from every supervised sidecar (`veslo-server`, `opencode-router`, `veslo-orchestrator`, `engine`) into the veslo-server debug log pipeline. Implementation lives in `packages/desktop/src-tauri/src/debug_logs_forwarder.rs`.

Spool location:

- `${VESLO_APP_LOCAL_DATA_DIR or app_local_data_dir()}/desktop-debug-log-spool/`
- `pending.jsonl` — append-only file growing as sidecars emit lines.
- `flushing-{uuid}.jsonl` — appears briefly during a flush; deleted on success, kept on failure for retry.

Behavior:

- A dedicated OS thread wakes every 5 s, reads veslo-server `port` and `host_token` from `VesloServerManager` state, atomically renames `pending.jsonl` to a `flushing-*` file, and POSTs batches of up to 500 events to `http://127.0.0.1:{port}/debug-logs` with `x-veslo-host-token`. Server-side validation lives in `validateDebugLogBatch`.
- Source labels in events: `veslo-server-shell` (Tauri-side capture, distinct from server-internal `veslo-server-self`), `opencode-router`, `orchestrator`, `engine`. `chrome-devtools-mcp` is covered transparently because it runs as an orchestrator child.
- Retention: `pending.jsonl` is truncated back to ~35 MB whenever it crosses the 50 MB high-water mark. Truncation drops the oldest lines and keeps the JSONL boundary clean.
- Resilience: when veslo-server is not running (no port/token available) the flush thread skips the cycle. POST failures leave the `flushing-*` file in place; the next tick retries.

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

- `enabled` is derived as `Boolean(ingestUrl && ingestToken)`. Without both vars the spool keeps collecting and retention prunes the oldest entries; nothing is sent over the network. Flip the two vars and the pipeline starts uploading on the next tick — no restart required for the upload to start, but the running process must be restarted to pick up new env values.
- Spool location: `${VESLO_DATA_DIR or ~/.veslo/veslo-server}/debug-log-spool/events/`. One JSON file per event today (file-per-event format owned by `debug-log-spool.ts`); switching to JSONL append-only is tracked separately as a follow-up.
- Upload retry policy lives in `debug-log-uploader.ts` (3 attempts, 250 ms initial, 2× multiplier, capped at 2 s). Failed batches stay leased in the manifest and the next flush tick re-leases them after the lease TTL.
- Process signals: `startServer` registers SIGINT/SIGTERM handlers that drain the pipeline (final flush) before exit.

## Den Debug Log Ingest

Den accepts uploaded debug-log batches from `veslo-server` at `POST /v1/internal/debug-logs`. The route uses a dedicated server-to-server bearer token (`DEN_LOG_INGEST_TOKEN`) and stores each event payload encrypted with `DEN_LOG_MASTER_KEY` plus operator-managed `DEN_LOG_MASTER_KEY_VERSION`.

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

## Managed-AI Routing and Accounting

Managed-AI inference routing is configured separately from signed-in app identity. Desktop and orchestrator defaults use the owned standalone AI Gateway at `https://ai.veslo.work`; `VESLO_MANAGED_AI_BASE_URL` overrides it, with `VESLO_AI_GATEWAY_BASE_URL` retained as the legacy fallback. The previous Render AI Gateway remains a transition and rollback surface, not the default for new builds.

Desktop local workspaces separate the managed-AI access-policy source from the OpenCode provider routing target. The app may load the user's policy and gateway token from DEN or standalone AI Gateway, but the generated provider `baseURL` in `opencode.json` points at the active local Veslo server so prompts keep flowing through the local-first runtime.

When the local Veslo server proxies managed-AI requests, successful JSON and streamed provider responses are passed through. Upstream non-2xx failures are normalized to a local `502` JSON error so a managed-AI gateway/provider block is not reported as local server authentication failure. The error details include a generated request id, provider/model/session/user/org context when available, upstream status/request id/content type, and a short sanitized upstream response snippet.

The desktop app recognizes managed Codex credential exhaustion or missing eligible binding inside these normalized errors and formats it as an actionable AI access failure. Prompt sends that hit this condition set the session run state to failed and insert the error into the transcript instead of leaving OpenCode's empty assistant turn looking like an active run.

DEN managed-AI uses `MANAGED_AI_DATABASE_URL`. Standalone AI Gateway uses `AI_GATEWAY_DATABASE_URL`. Their assignment, credential, eligibility, and usage views match only when those services are intentionally pointed at the same managed-AI backing database and compatible config.

Managed-AI provider assignments may use `openai`, `anthropic`, `codex_oauth`, or `openai_compatible`. The desktop app treats these assignments as read-only policy and writes local OpenCode routing for the assigned provider. AI access rows also store `assignment_origin`: `auto_assigned` for DEN sign-up Codex defaults and `admin_assigned` for explicit admin edits or legacy rows. For `codex_oauth`, OpenCode still owns local tool execution and calls the local Veslo server route `/ai-gateway/providers/codex_oauth/v1`; the configured managed-AI service keeps the Codex OAuth auth JSON server-side, translates the OpenAI-compatible request to the ChatGPT Codex Responses endpoint, and translates the response back for OpenCode. Standalone AI Gateway admin model pickers use live upstream discovery for `openai_compatible` credentials and a gateway-owned Codex model catalog for `codex_oauth` credentials. Codex status probes run from temporary Codex homes, and refreshed probe auth JSON is written back to the credential's encrypted secret when Codex rotates it. Any assigned Codex row can be repaired to another healthy eligible Codex credential on the next request when its assigned credential becomes unhealthy, revoked, missing, permanently unavailable, or exhausted; the original assignment origin is preserved after repair, and legacy repairs without a stored model use the Codex catalog default. For `openai_compatible`, OpenCode uses the local Veslo server route `/ai-gateway/providers/openai_compatible/v1`; the upstream custom base URL and API key remain server-side in the configured managed-AI service's encrypted secret store.

Standalone AI Gateway credentials can be soft-deleted only after they are no longer usable and are not referenced by user AI-access policy. Active leases and assignment references still block soft-delete unless the credential is already revoked. Soft-deleted rows keep their credential id for audit, usage, and alert history, but `deleted_at` removes them from default admin lists, assignment options, rotation, and runtime selection; their stored secret is replaced with a deleted tombstone.

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

## Skills Inventory

The Skills page builds an app-wide inventory from three sources:

- user-global runtime skills from global OpenCode-compatible skill roots
- workspace-local skills discovered per readable local workspace
- Hub skills from the existing prepared catalog flow

User-global skills are runtime-available skills, not organization catalog or
admin-approved skills. Organization promotion and bulk rollout remain future
work until the Den/admin backend owns those concepts.

For inventory correctness, global skill roots and workspace skill roots are read
separately. Runtime-effective discovery may still include both scopes for active
workspace behavior, but the inventory must not expand global skills under every
workspace. Workspace rows represent only real workspace-local instances or
overrides.

Skill edit and save flows target a concrete inventory instance by scope,
workspace id, and path before falling back to name-based legacy commands. Delete
remains disabled for scoped inventory rows until a path-specific backend command
exists. Hub install uses an explicit target picker; current writes are limited
to the active workspace.

## Skill Registry State

The cloud skill registry introduces distribution state separate from runtime skill files. Registry state is cloud-owned and should not be inferred from local `.opencode/skills/` folders alone.

Registry-owned state:

- skill records, slugs, descriptions, tags, visibility, and review status
- immutable package versions and package digests
- personal, workspace, and organization installation records
- workspace desired skill sets
- review requests, reviewer decisions, and restore history

Local Veslo state:

- downloaded package archives before install
- cached package archives under `${VESLO_DATA_DIR or ~/.veslo/veslo-server}/skill-package-cache/`, keyed by package SHA-256 and verified before use
- unpacked runtime skill directories controlled by the local Veslo server
- workspace activation or reload state after a skill set changes
- any temporary install progress, errors, or selected install target in the app UI

The local server validates registry responses before using them. Validators accept only the response fields needed by the app/server contract and delegate package manifest checks to the skill package model. They are not a backend implementation and do not replace registry-side authorization, review workflow, package storage, or audit enforcement.

Registry auth is account-scoped:

- personal user: owns personal skills and personal installs
- workspace collaborator/admin: reads workspace skill sets; admins manage workspace installs
- org skill admin: manages organization skills, reviews, and org installs
- platform admin: manages platform skills and cross-tenant moderation

Registry-backed workspace skill-set changes are durable behavior. If the local app applies a changed workspace skill set, it should trigger the same server-backed install and reload semantics used for other skill mutations rather than writing only through the UI.

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
- browser local storage keeps the active pending draft key so the app can restore the same unpublished draft on restart
- `Chat` is globally singleton while unpublished: reopening it returns to the existing private pending draft
- project pending drafts are keyed by workspace plus normalized directory
- pending drafts remain out of the sidebar until a real session is created by sending them

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
