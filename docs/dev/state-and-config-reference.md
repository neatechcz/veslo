# State and Config Reference

This document describes the main persistence and config surfaces used by Veslo.

## Scope Categories

- App-global UI preferences: browser storage keys in the Solid app.
- Workspace-scoped config: `.opencode/veslo.json`.
- Workspace automation state: `.opencode/veslo/automations.json`.
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

Automatic update checks are always enabled; legacy stored `veslo.updateAutoCheck=0` values are ignored and overwritten on the next preference persist. `veslo.updateAutoDownload` is default-on when absent. A stored `0` is an explicit opt-out and keeps the manual download flow. Turning auto-download off while an automatic download is active pauses the auto-download flow and restores the update to manual availability; a late automatic completion is ignored for UI state. When enabled, failed automatic update downloads are retried with bounded backoff. The retry state is runtime-only; only the preference and last successful check time are stored.

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
- In that browsing mode the app loads sidebar/session history from SQLite first, checking the active workspace's `.opencode/opencode.db` before legacy/global OpenCode database locations, and only re-attaches the engine when the user performs an action that requires it, such as sending a message.
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

Desktop-managed local Veslo server uses the fixed port `8787`. The desktop runtime must not fall back to a dynamic port when `8787` is unavailable; port contention is a startup/recovery failure that must be resolved by stopping or recovering the process that owns the fixed port. The desktop E2E harness is the exception: it sets `VESLO_DESKTOP_SERVER_PORT` through its launcher, using `E2E_VESLO_SERVER_PORT` when provided or otherwise an auto-selected free port, so tests can run next to a user-launched production app without claiming `8787`. Same-machine app code that derives a local Veslo server URL from an OpenCode URL should normalize back to `http://127.0.0.1:8787` for the managed server outside this explicit harness override.

Managed local sidecars distinguish internal runtime URLs from advertised connect URLs. Same-machine communication between the desktop shell, `veslo-server`, `veslo-orchestrator`, OpenCode, and `veslo-code-router` uses loopback OpenCode URLs such as `http://127.0.0.1:<port>`. LAN or mDNS connect URLs are for external clients only; they must not be passed as the local `--opencode-base-url` or `--opencode-url`, because sleep/resume and network changes can invalidate those addresses while the local OpenCode process remains healthy.

Desktop-managed OpenCode, Veslo server, Veslo orchestrator, and OpenCode Router processes launch through the desktop supervised-process wrapper. On Windows, that wrapper applies the hidden-process creation flags before spawn so first launch, restart, and fallback command startup do not create visible console windows. Sidecar stdout/stderr still flows through the debug-log forwarding path below.

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
- Retention is enforced asynchronously after appends and by a maintenance loop that runs even when remote upload is disabled. The spool can temporarily exceed `VESLO_LOG_SPOOL_MAX_BYTES`, but `/debug-logs` ingest stays off the cleanup hot path and bulk-prunes old unleased events back toward the low-water mark.
- `POST /debug-logs` validates the host token and batch body before returning `202`, then appends the events to the durable spool asynchronously. Append failures are logged locally; sidecar log forwarding must not block server health or other UI-facing routes on disk cleanup.
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

The local proxy must not parse the full provider request body before forwarding it. OpenCode can send large or chunked accumulated-session payloads, so local model extraction for error diagnostics is limited to small JSON requests with a known `Content-Length`; stream and large-body requests are forwarded without diagnostic pre-buffering.

The local server also treats body parsing as byte-bounded infrastructure. AI gateway error details include only a bounded sanitized upstream preview, large provider JSON success responses remain streamed, OpenCode JSON helper responses have explicit parsing limits, and local JSON/form ingest rejects oversized request bodies before validation or multipart parsing when possible. Transcript prefetch caches are bounded by estimated bytes as well as entry count, so large tool outputs cannot remain resident solely because the session count is low.

OpenCode JSON helper calls made by the local server use a bounded upstream timeout so stale interface URLs or hung sockets cannot hold UI-facing server routes for OS-level TCP timeouts. The default is 5000 ms and can be overridden for diagnostics/tests with `VESLO_OPENCODE_JSON_FETCH_TIMEOUT_MS`. Streaming pass-through proxy routes are not governed by this helper timeout.

The desktop app recognizes managed Codex credential exhaustion or missing eligible binding inside these normalized errors and formats it as an actionable AI access failure. Prompt sends that hit this condition set the session run state to failed and insert the error into the transcript instead of leaving OpenCode's empty assistant turn looking like an active run.

DEN managed-AI uses `MANAGED_AI_DATABASE_URL`. Standalone AI Gateway uses `AI_GATEWAY_DATABASE_URL`. Their assignment, credential, eligibility, and usage views match only when those services are intentionally pointed at the same managed-AI backing database and compatible config.

Managed-AI provider assignments may use `openai`, `anthropic`, `codex_oauth`, or `openai_compatible`. The desktop app treats these assignments as read-only policy and writes local OpenCode routing for the assigned provider. AI access rows also store `assignment_origin`: `auto_assigned` for DEN sign-up Codex defaults and `admin_assigned` for explicit admin edits or legacy rows. For `codex_oauth`, OpenCode still owns local tool execution and calls the local Veslo server route `/ai-gateway/providers/codex_oauth/v1`; the configured managed-AI service keeps the Codex OAuth auth JSON server-side, translates the OpenAI-compatible request to the ChatGPT Codex Responses endpoint, and translates the response back for OpenCode. Standalone AI Gateway admin model pickers use live upstream discovery for `openai_compatible` credentials and a gateway-owned Codex model catalog for `codex_oauth` credentials. Codex status probes run from temporary Codex homes with the bundled `@openai/codex` CLI pinned at `0.137.0` or newer so successful probes write subscription rate-limit snapshots into session logs; refreshed probe auth JSON is written back to the credential's encrypted secret when Codex rotates it. If a Codex status probe reports refresh-token reuse, the standalone admin service quarantines the credential as unhealthy; the admin Reconnect action replaces the stored auth JSON in place and marks the same credential healthy again. If a Codex status probe reports that a specific model is unsupported for the credential's ChatGPT account, the credential remains available and that model is filtered from the credential's admin model list. Any assigned Codex row can be repaired to another healthy eligible Codex credential on the next request when its assigned credential becomes unhealthy, revoked, missing, permanently unavailable, or exhausted; the original assignment origin is preserved after repair, and legacy repairs without a stored model use the Codex catalog default. For `openai_compatible`, OpenCode uses the local Veslo server route `/ai-gateway/providers/openai_compatible/v1`; the upstream custom base URL and API key remain server-side in the configured managed-AI service's encrypted secret store.

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

## Skills Inventory

The Skills page builds an app-wide inventory from three sources:

- user skills from user-level OpenCode-compatible skill roots
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

- `${VESLO_DATA_DIR or ~/.veslo/veslo-server}/skill-removals/records/`
- `${VESLO_DATA_DIR or ~/.veslo/veslo-server}/skill-removals/snapshots/`

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

For inventory correctness, user skill roots and workspace skill roots are read
separately. Runtime-effective discovery may still include both scopes for active
workspace behavior, but the inventory must not expand user skills under every
workspace. Workspace rows represent only real workspace-local instances or
overrides.

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
- cached package archives under `${VESLO_DATA_DIR or ~/.veslo/veslo-server}/skill-package-cache/`, keyed by package SHA-256 and verified before use
- unpacked runtime skill directories controlled by the local Veslo server
- server-controlled workspace skill materializations under `.opencode/skills/veslo-managed/`, with a root manifest and per-skill ownership markers
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
- browser local storage keeps the active pending draft key so the app can restore the same unpublished draft on restart
- `Chat` is globally singleton while unpublished: reopening it returns to the existing private pending draft
- project pending drafts are keyed by workspace plus normalized directory
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
