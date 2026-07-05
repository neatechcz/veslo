# Veslo Server Access Failures — Root-Cause Inventory and Target Architecture

Date: 2026-07-04
Status: proposal (analysis pass, no code changed)
Scope: everything between the desktop app and its local `veslo-server` — process
lifecycle, tokens, URLs, workspace identity, and recovery. Cloud sync and the
managed AI gateway are out of scope except where they share the same plumbing.

## Why this document exists

Most user-visible failures ("Opening conversation…" hangs, `Invalid bearer
token`, disconnected/limited status, dead sends) reduce to one statement: the
app cannot reliably answer *"where is my server and which credential does it
accept right now?"*. The codebase answers that question in many places with
heuristics, and the heuristics disagree under restarts, races, and stale state.

The VSLO-86 / VSLO-171 / VSLO-250 comment trail across the code shows repeated
symptom-level patches to the same underlying design problem. Per the
systematic-debugging rule ("3+ fixes → question the architecture"), this is an
architecture problem, not a bug backlog.

## Part 1 — Root-cause inventory

### A. Process lifecycle and readiness

**A1. "Running" is declared before the server actually listens.**
`start_veslo_server` (`packages/desktop/src-tauri/src/veslo_server/mod.rs`)
sets `lifecycle_status = Running` and publishes `base_url` + tokens immediately
after `spawn()` returns. Bun still needs hundreds of ms to seconds to load and
bind. Everything downstream compensates:
- `reconcile_server_workspaces` (`workspace/server_client.rs`) polls `/health`
  for up to ~5 s before POSTing, with a comment admitting registration used to
  log "Connection refused" for every workspace,
- the frontend status-stability layer (`status-stability.ts`) exists largely to
  hide this boot window,
- `ensureLocalVesloServerRunning` (`veslo-server-connection.ts`) can see one
  failed health check on a *booting* server and immediately call
  `veslo_server_restart`, killing and respawning a healthy child.
There is no readiness handshake; every consumer invents its own.

**A2. Port resolution is check-then-spawn (TOCTOU) with a fixed port and no
occupant identification.** `bind_veslo_port` binds and immediately releases
8787, then spawns the child. If the child loses the race or the previous
listener needs >3 s to release (`resolve_veslo_port_after_restart` deadline),
the state becomes `Blocked/PortUnavailable` with no recovery path other than
user action.

**A3. Stale/orphaned servers are never killed on macOS/Linux.**
`terminate_stale_veslo_server_process` is a no-op on non-Windows. An orphan
`veslo-server` surviving an app crash therefore either (a) permanently blocks
port 8787 for every future app start, or (b) gets *adopted* through persisted
state with a token the app no longer holds correctly (see B1). This alone can
produce the exact chronic symptom reported: the app runs, the server runs, and
they cannot talk to each other.

**A4. The server is killed and respawned whenever the launch config changes.**
`launch_config_matches` compares workspace set, host, bridge host, sandbox
backend, opencode base URL, orchestrator URL and lifecycle token. The opencode
base URL embeds the *dynamic orchestrator daemon port* and the *active
workspace id*, so:
- every reboot produces a different URL → respawn,
- a veslo-server started before the orchestrator attaches (e.g. via
  `veslo_server_restart` with no engine) is respawned again minutes later when
  `engine_start` supplies the URL,
- adding a workspace changes the `--workspace` set → respawn.
Each respawn drops in-flight requests and SSE streams and re-opens the boot
window from A1. Token carry-over (VSLO-171) mitigates 401s but not the churn.

**A5. Four competing initiators can start/restart the server with no
serialization between them:** `engine_start` (two call sites in
`commands/engine.rs`), the `veslo_server_restart` command, and the frontend
`ensureLocalVesloServerRunning` effect. Single-flight exists only inside the
frontend; the Rust side serializes only via the state mutex, so interleaved
start requests with different configs cause kill/respawn ping-pong during boot.

### B. Server identity and adoption

**B1. The app cannot verify *which* server it is talking to.** `/health`
(`packages/server/src/routes/health.ts`) is anonymous and returns only
`{ok, version, uptimeMs, pid}` — no token (intentionally removed), no instance
identity. The adoption logic in `persisted_state_to_info_with_health` and
`sanitize_live_info_with_health` therefore falls back to heuristics: token
match if the (legacy) server returns one, PID match only for tokenless state,
otherwise *accept*. Consequences:
- a foreign or stale veslo-server answering on 8787 is adopted as "ours",
  with a persisted client token it does not recognize → every request 401s
  ("Invalid bearer token") while the UI shows a live server,
- dev-watch PID vs worker PID mismatches forced the code to further weaken the
  PID check, widening the adoption hole.

**B2. `veslo_server_info` performs a blocking HTTP health probe (1.2 s ureq
timeout) while holding the manager mutex** (`commands/veslo_server.rs`). The
frontend polls this command every 10 s (every 1 s while "not running"). Any
lifecycle operation contends on the same mutex; on Windows the same poll can
also trigger synchronous `wsl.exe`/PowerShell probes. This turns the status
poll into a source of stalls exactly when the connection is already unhealthy.

### C. Token and auth sprawl

**C1. There are at least seven independent stores of "URL + token":**
1. Rust in-memory `VesloServerState`,
2. `veslo-server-state.json`,
3. `veslo-server-plugin-state.json`,
4. frontend localStorage (`veslo.server.token`, `veslo.server.urlOverride`,
   `veslo.server.port`, `veslo.server.list`, `veslo.server.active`, plus legacy
   `openwork.*` mirrors),
5. frontend reactive settings/signals,
6. server-side `tokens.json` (owner tokens) + `config.token` equality check,
7. env vars (`VESLO_DEV_SERVER_URL`, `VESLO_DEV_SERVER_TOKEN`, `VESLO_TOKEN`).
They are reconciled by ad-hoc pairwise copies (`reconnectVesloServer` copies
the live client token into settings; env hydration; invite params). Any drift
between any pair produces 401/limited.

**C2. The host token is lost across app restarts.** Recovery from persisted
state deliberately returns `host_token: None`, and `collect_server_state`
silently *skips all host-scoped mutations* (workspace registration, rename,
delete) when the host token is missing. Net effect after adopting a live
server: the workspace registry silently stops being synchronized → sidebar
clicks 404 on `/workspaces/:id/*` → 12–30 s activate timeouts → "Opening
conversation…" hangs. The failure is invisible because the client is
fire-and-forget by design.

**C3. Tokens travel on argv** (`--token`, `--host-token`,
`--orchestrator-lifecycle-token` in `spawn.rs`). This (a) leaks them to process
listings/logs, and (b) makes token rotation impossible without a respawn,
which is why the respawn/reuse logic must carry tokens so carefully.

**C4. The auth resolver has a designed-in unauthenticated path.**
`resolveVesloServerAuth` returns `{token: undefined}` when there is no live
host info but a derived local fallback URL exists — requests then run without
a bearer and the connection sits permanently in "limited".

**C5. Scope asymmetry is easy to violate.** The spawned client token maps to
`collaborator`; owner routes require the host token header or an `owner`
bearer from `tokens.json`. Whether the frontend sends the host token depends
solely on live in-memory info (C2), so the same UI action succeeds or fails
depending on process history.

### D. Workspace identity and registry drift

**D1. Workspace IDs are derived independently in three places from
*differently normalized* paths.** All three use `ws-` + sha1(path)[:12]
(`workspace/state.rs`, `packages/server/src/workspaces.ts`, orchestrator), and
the server-side comment itself warns "all three stores must agree … or
cross-system lookups silently 404". But Rust hashes the raw trimmed string
from `veslo-workspaces.json`, while the server hashes `resolve(cwd, path)`.
Trailing slashes, relative paths, symlinks (`/tmp` vs `/private/tmp` on
macOS), and Windows case differences produce divergent IDs. The transport
layer even ships a dedicated `workspace_id_mismatch` error code — a symptom
handler for this exact defect.

**D2. Registry synchronization is best-effort, fire-and-forget, and has three
overlapping reconcilers** (orchestrator reconcile, `reconcile_server_workspaces`
in Rust, and the frontend's own reconcile that per the code comment "races in
afterwards"). Failures never propagate; the local mutation always "succeeds"
for the user, and the mismatch surfaces later as a 404 in an unrelated flow.

**D3. The `--workspace` argv snapshot is a fourth registry.** VSLO-86 already
had to widen it to "all local workspaces" at spawn; anything created after
spawn depends on the fire-and-forget POSTs from D2.

### E. URL resolution guesswork in the app

**E1. The control-plane URL is guessed from the data-plane URL.**
`deriveLocalVesloServerUrlFromOpencodeBaseUrl` takes the OpenCode base URL
(orchestrator proxy, dynamic port) and rewrites the port to hard-coded 8787.
This breaks under `VESLO_DESKTOP_SERVER_PORT` overrides (E2E) and feeds the
token-less fallback path (C4).

**E2. Two parallel "server" models with separate health truths.**
`ServerProvider` (`context/server.tsx`) keeps an OpenCode server list in
localStorage — including dynamic-port daemon URLs that are dead after every
reboot — with its own health poll, while `veslo-server-connection.ts` keeps
the Veslo server status. The UI can show contradictory connectivity.

**E3. The base-URL/auth decision matrix is too wide to keep coherent.**
`resolveVesloServerBaseUrl`/`resolveVesloServerAuth` combine startup
preference (`local`/`server`/null) × live host info × derived fallback ×
settings override, and a separate effect computes the *display* URL preferring
`connectUrl`/`lanUrl` over `baseUrl`. URL and token can be picked from
different candidates, and the null-preference branches differ between the two
functions.

### F. Error attribution

**F1. Failures collapse into generic `disconnected`/`limited` states.** The
architecture doc (`docs/dev/opencode-workspace-runtime-architecture.md`)
already mandates layer-attributed failures (local server vs workspace attach
vs conversation vs run), but the connection layer itself reports only a
tri-state, so users and logs cannot distinguish "server booting" from "wrong
token" from "foreign server on our port" — which is why these all get
reported as the same "app has no access to its server" complaint.

## Part 2 — Target architecture

Design rule: **one owner per fact, push instead of poll, verify identity
instead of guessing it.**

### 2.1 Ownership

| Fact | Sole owner | Everyone else |
|---|---|---|
| Local server process + connection descriptor (URL, tokens, status, instanceId) | Desktop shell (Rust) | consume pushed events |
| Workspace registry + IDs | veslo-server (`server.json`) | mirror + cache |
| Execution routing (OpenCode/orchestrator endpoints) | orchestrator, delivered to a *running* server via API | — |
| Remote ("server" startup mode) URL + token | user settings | — |

### 2.2 Boot contract with readiness handshake

1. Rust generates `instanceId` (per-boot UUID) and writes a secrets file
   (0600) with client/host tokens; passes only `VESLO_RUNTIME_FILE` +
   `VESLO_SECRETS_FILE` via **env**, never argv.
2. Server binds its port, *then* atomically writes `runtime.json`
   `{instanceId, pid, port, baseUrl, startedAt}` and prints one `READY` line.
3. Rust flips to `Running` only on the READY signal (stdout watch with
   timeout, fallback: `/health` returning the expected `instanceId`).
4. `/health` returns `{ok, version, pid, instanceId}`. Adoption of any
   already-running server requires **instanceId equality** with persisted
   state — token/PID heuristics are deleted. Wrong instanceId → terminate (now
   implemented on Unix too) → spawn fresh.

This kills A1, A2 (child reports its own bind result), A3, B1, and C3, and
removes the need for the 5 s health-poll workaround and most of the
status-stability masking.

### 2.3 One connection state machine, event-pushed

A single Rust state machine:

```
Stopped → Spawning → WaitingReady → Running ↔ Degraded
                    ↘ Blocked(port_conflict | spawn_failed | identity_conflict)
```

- Every transition emits a Tauri event carrying the full descriptor
  `{status, reason, baseUrl, clientToken, hostToken, instanceId}`.
- The frontend keeps exactly one store fed by these events; the 1–10 s
  `veslo_server_info` polling loop becomes a low-frequency watchdog only.
- Health probing moves out of the command path into a background task that
  never holds the state mutex across I/O (fixes B2).
- All start/restart intents — from `engine_start`, the restart command, or the
  frontend "ensure" — go through **one serialized queue** with config
  coalescing (fixes A5; the frontend loses the right to kill the process
  directly, it only sends intent).

### 2.4 Decouple server lifetime from workspaces and engine wiring

- Spawn veslo-server **once per app run, with zero `--workspace` args**, cwd =
  app data dir (the architecture doc already requires ready-without-workspace).
- Workspaces are registered exclusively through the host-token API, and the
  call becomes **acknowledged**, not fire-and-forget: the desktop stores the
  server-assigned workspace id from the response (server becomes the id
  authority — D1/D2/D3 collapse into one flow; the three reconcilers reduce to
  one startup sync).
- OpenCode/orchestrator endpoints are delivered to the running server via an
  authenticated `POST /runtime/engine-config` instead of argv. Daemon port
  changes, active-workspace changes and workspace adds **no longer respawn the
  server** (fixes A4); respawn remains only for crash, port change, or binary
  update.
- Until the server-assigned-id migration lands, ship the interim fix: one
  shared canonicalization (realpath + trailing-separator strip + Windows
  case-fold) applied before sha1 in all three implementations, locked by a
  shared golden-vector test file consumed by Rust, server, and orchestrator
  tests.

### 2.5 Auth model

- Persist **both** tokens (0600, keyed by instanceId) so recovery after an app
  restart keeps owner scope (fixes C2).
- Delete the localStorage token cache for local mode; local credentials exist
  only in the pushed descriptor. `veslo.server.token` remains only for the
  explicit remote "server" startup mode (fixes most of C1).
- One 401-recovery routine in one module: refresh descriptor → retry the
  idempotent request once → otherwise emit `auth_desync`, which the state
  machine handles (managed restart with token reuse). No other code path may
  react to 401 (implements the doc's "Invalid bearer token is a connection
  failure" rule in exactly one place).
- Remove the unauthenticated fallback client (C4): if there is no descriptor
  and no settings entry, the state is `Stopped`, not "limited".

### 2.6 Port strategy

Keep 8787 as the default for LAN invite ergonomics, but on bind conflict:
1. probe `/health` → our instanceId? adopt.
2. foreign but matches our persisted state file's pid? terminate and retake.
3. genuinely foreign → fall back to an ephemeral port recorded in
   `runtime.json` (invites and connect URLs read the real port from the
   descriptor), and surface `Blocked(port_conflict)` details in Settings.

### 2.7 Frontend simplification

- Delete `deriveLocalVesloServerUrlFromOpencodeBaseUrl` and the derived
  fallback URL concept (E1).
- Stop persisting dynamic-port OpenCode URLs in `veslo.server.list`; the
  ServerProvider list becomes remote-only, and local OpenCode routing reads
  the descriptor + engine info (E2).
- Reduce `resolveVesloServerBaseUrl`/`Auth` to two branches: **local** =
  descriptor only; **server** = settings only. URL and token always come from
  the same candidate (E3).
- Connection status becomes an enum with a reason
  (`booting`, `connected`, `auth_desync`, `port_conflict`, `stopped`, …) so UI
  and logs attribute the layer (F1).

### 2.8 Validation plan (per repo testing rules)

Server tests: instanceId adoption/rejection, acknowledged workspace
registration, engine-config hot-swap without restart.
Tauri-pilot E2E (primary, per testing playbook):
1. cold boot on a fresh profile → READY handshake → first message flow,
2. app restart with a live previous server → adoption by instanceId, host
   scope preserved, workspace registration still works,
3. orphaned server with mismatched instanceId → terminated and replaced,
4. foreign process occupying 8787 → ephemeral-port fallback, UI shows reason,
5. add a workspace mid-session → no server respawn, no token rotation, no SSE
   drop,
6. engine restart / daemon port change → same server process, config swap via
   API.

### 2.9 Phasing

**Phase 1 — stop the bleeding (small, independent, high yield):**
persist the host token; add `instanceId` to `/health` + persisted state and
replace adoption heuristics; implement Unix stale-process termination; move
tokens from argv to env/secrets file; move the health probe out of the
`veslo_server_info` mutex.

**Phase 2 — one state machine:** READY handshake, event-pushed descriptor,
serialized start queue, frontend store + auth-recovery consolidation, delete
localStorage local-token cache and derived-URL fallback.

**Phase 3 — decouple lifecycle:** zero-workspace spawn, acknowledged
registration with server-assigned IDs (plus interim canonicalization fix),
engine-config over API, respawn only on crash/port/binary change.

Each phase ends with the Tauri-pilot scenarios above; `docs/dev/`
(`opencode-workspace-runtime-architecture.md`, `state-and-config-reference.md`,
`veslo-server-app-contract.md`) must be updated when the behavior lands.
