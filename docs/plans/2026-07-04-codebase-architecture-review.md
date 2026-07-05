# Veslo Codebase — Major Architectural Issues and Target Architecture

Date: 2026-07-04
Status: proposal (analysis pass, no code changed)
Companion: `docs/plans/2026-07-04-veslo-server-access-root-causes-and-architecture.md`
(the server-access analysis; several findings below generalize what that
document found in one subsystem).

## How this was measured

Numbers below come from direct scans of the repo at `dev_vaclav` (graphify
report `492c547d` plus fresh `rg`/`wc` sweeps). They are approximate but the
orders of magnitude are stable.

| Metric | Value |
|---|---|
| Source LOC (app / server / desktop / orchestrator / router) | ~186k / 72k / 24k / 18k / 6k |
| Tauri IPC commands | 90 |
| Veslo server HTTP routes | 171 |
| Distinct `VESLO_*` env vars | 245 |
| localStorage keys written by the app | 33 |
| JSON state files (desktop-side / server+orchestrator-side) | 16 / 17 |
| `setInterval` polling loops in the app | ~20 |
| Silent catches (`catch {}` / `// ignore`) app / server | 474 / 199 |
| Largest files | orchestrator `cli.ts` 6 558 · `app.tsx` 4 859 · `server.ts` 4 200 · `session.tsx` 4 127 |
| Hand-mirrored contract files | `lib/veslo-server/types.ts` 1 589 LOC · `lib/tauri.ts` 1 488 LOC |
| E2E: mandated `tauri-pilot` scenarios vs legacy WDIO specs | 2 vs 57 |
| App context modules | 73 |

## Part 1 — Findings

### 1. The product is a six-process distributed system, but it is built like a monolith with helpers

The desktop app actually runs: the webview app, the Tauri shell, and up to
five managed children (`veslo-server`, `veslo-orchestrator`, `veslo-code`
(OpenCode), `veslo-code-router`, `chrome-devtools-mcp`), plus per-workspace
engine processes under the orchestrator. Each pairwise link re-implements the
same concerns independently and differently:

- spawn + argv/env config snapshot (`veslo_server/spawn.rs`,
  `commands/engine.rs`, `opencode_router/`, `orchestrator/`),
- readiness guessing (health polls, warm-up sleep loops, 5 s retry loops),
- identity (token match here, PID match there, nothing elsewhere),
- auth (client token / host token / orchestrator lifecycle token / OpenCode
  basic auth — four schemes on four links),
- state files + reconcilers to patch the resulting drift.

The server-access document analyzed one of these links in depth; the same
pattern (optimistic readiness, argv-frozen config, heuristic adoption,
fire-and-forget sync) exists on **every** link. There is no shared
"managed child" abstraction — `process_supervisor.rs`/`supervised_process.rs`
cover spawn/collect only, not readiness, identity, or config delivery.

Consequence: any dynamic value (a daemon port, the active workspace, a token)
either forces a child respawn or silently drifts. This is the root pattern
behind most "the app lost its runtime" bugs, not just the veslo-server ones.

### 2. No domain concept has a single source of truth

Counting only what is written to disk or browser storage:

- **Workspace registry ×4**: `veslo-workspaces.json` (Tauri),
  `server.json` (veslo-server), orchestrator state, app signals/localStorage —
  synchronized by three overlapping best-effort reconcilers.
- **Conversation/run data ×3–4**: engine `opencode.db`, server
  `bindings.sqlite` (bindings + transcript mirror + run lifecycle/queue
  stores), orchestrator `run-store`, plus app-side session archives.
- **Tokens/URLs ×7** (documented in the companion doc).
- **Model/agent/config preferences** split across localStorage,
  `runtime-preferences.json`, workspace `veslo.json`, `opencode.json`, and
  cloud policy merges.

33 localStorage keys and 33 JSON state files exist because mirroring, not
ownership, is the integration strategy. Every mirror needs a reconciler;
every reconciler is fire-and-forget; every failure surfaces later as a 404,
401, or a hang somewhere else. This is a structural property, not a set of
bugs.

### 3. Contracts between layers are hand-mirrored with no drift detection

- `packages/app/src/app/lib/veslo-server/types.ts` (1 589 LOC) is a hand-kept
  mirror of the server's request/response shapes; `packages/app/src/app/lib/tauri.ts`
  (1 488 LOC) hand-mirrors 90 Rust command signatures. No codegen
  (OpenAPI/typebox on the server, `tauri-specta`/`ts-rs` on the shell), no
  contract tests, no versioning.
- The 171 server routes are registered through a 4 200-line `server.ts` that
  also owns middleware, CORS, auth, and proxying; route modules exist under
  `routes/` but the composition and cross-cutting logic remain centralized.
- Drift is discovered at runtime: e.g. the transport layer's special-case
  mapping of the orchestrator's `{"error":"workspace not found"}` 404 body
  into a synthetic `workspace_id_mismatch` code is a hand-built patch over an
  uncontracted error shape.

### 4. God modules at every layer

- `packages/orchestrator/src/cli.ts` — 6 558 LOC, ~139 top-level functions:
  CLI parsing, HTTP daemon, engine pool, run registry, sandbox resolution,
  WSL path rewriting, and proxying in one file. It is the highest-risk file
  in the repo: it owns execution correctness and has no internal boundaries.
- `packages/server/src/server.ts` — 4 200 LOC (see §3).
- `packages/app/src/app/app.tsx` — 4 859 LOC. The modularization plan
  (Fix 18/19) correctly made it a "composition root", but the complexity
  moved into its wiring: 85 signals, 154 imports, and ~160-field prop bags
  (`SessionViewProps` has ~160 members; `session.tsx` reads `props.` 419
  times). Prop-bag DI at this scale is a God object by another name — every
  workflow change touches the shell wiring anyway.
- 73 context modules mix three different kinds of things under one name:
  reactive state stores, service clients, and long-lived effect loops. There
  is no layering rule saying which context may depend on which; coupling is
  managed by convention and by the shell wiring order (`late-bound.ts` exists
  specifically to break init-order cycles — a symptom that the dependency
  graph among contexts is cyclic by design).

### 5. Polling is the integration mechanism; events are the exception

~20 `setInterval` loops in the app poll: server info (1–10 s), veslo health
(1–30 s adaptive), diagnostics (10 s), router info (10 s), orchestrator status
(10 s), engine list (30 s), plus per-feature refreshers. On the Rust side,
several Tauri commands do blocking HTTP probes (up to 1.2 s inside a held
mutex), synchronous PowerShell/WSL probes, and `thread::sleep` warm-up loops.
Tauri's event channel is used only for niche flows (debug log forwarding,
engine SSE proxy). Consequences: status is always seconds stale, boot windows
flap the UI, probe storms amplify exactly when things are unhealthy, and each
poller needs its own damping layer (`status-stability.ts`).

### 6. Silent failure is the default error policy

474 silent catch sites in the app and 199 in the server (plus the
fire-and-forget host mutations in the desktop shell). The repo compensates
with a custom `flow_log!` macro and a send-trace-id mechanism to reconstruct
what happened after the fact. The architecture doc's own rule ("store the
failure at the narrowest correct level") is violated pervasively because
there is no typed error channel across layers — errors either throw across a
seam that swallows them, or degrade into tri-state connection statuses.

### 7. Configuration sprawl

245 distinct `VESLO_*` environment variables, plus CLI flags, `server.json`,
`runtime-preferences.json`, workspace `veslo.json`, `opencode.json(c)`, cloud
policy, and — notably — an env→localStorage hydration step
(`hydrateVesloServerSettingsFromEnv`) that copies build-time env into
persistent browser storage, blurring build-time, install-time, and run-time
configuration. No process has a single typed config resolver with documented
precedence; several precedence decisions live inline at call sites.

### 8. Legacy surfaces are carried, not retired

- `openwork.*` localStorage keys, `openwork-workspaces.json`, and `owt_`
  token prefixes are still read/written (17 files reference the old brand).
- `packages/web` (~5 600 LOC incl. a 3 348-line `cloud-control.tsx`) is a
  parallel UI that policy explicitly forbids using as the runtime; it still
  costs maintenance and confuses agents/tooling.
- A 1 812-line "toy UI" is embedded in the server binary.
- Two 2 500-line hand-synced locale files (`en.ts`, `cs.ts`) with a custom
  checker script instead of key extraction.
- 57 legacy WebdriverIO specs sit next to **2** `tauri-pilot` scenarios,
  while AGENTS.md mandates pilot-first validation — i.e. the mandated E2E
  harness barely exists and the forbidden one dominates the directory.

### 9. The test pyramid is inverted relative to the risk profile

Unit tests are plentiful and well-colocated (config parsing, stores, pure
logic — this is genuinely good). But the defects that reach users live at the
process seams: spawn/readiness, adoption, registry sync, token recovery,
run submission. Those seams are tested with in-process mocks
(`sanitize_live_info_with_health(|_| ...)`) and almost never end-to-end (2
pilot scenarios). Per the repo's own rules, desktop behavior counts only when
validated in the real Tauri runtime — by that standard, most of the
integration layer is unvalidated.

### 10. The local security model is implicit

CORS `*` on the local server, `--approval auto` from the desktop, tokens on
argv (visible in process listings), an anonymous `/health`, optional LAN/
0.0.0.0 binds, and invite links carrying bearer tokens as URL query params
(`veslo_token`). Each choice has a rationale (LAN clients, single-tenant
desktop), but the trust model is nowhere written down, so every new surface
(bridge host, engine URL publication, remote workspaces) re-derives it ad hoc.

## Part 2 — Target architecture

Same design rule as the companion doc, generalized: **one owner per fact, push
instead of poll, contracts as artifacts instead of conventions.**

### 2.1 A single "managed runtime" abstraction in the desktop shell

One supervisor component that all five sidecars use, with a uniform child
spec: binary, env, secrets file (never argv), readiness handshake (READY line
or instance-ID health), restart policy, and a per-child state machine
(`Stopped → Spawning → WaitingReady → Running ↔ Degraded / Blocked(reason)`).
All lifecycle transitions are pushed to the app as Tauri events carrying a
full descriptor. The companion doc's §2.2–2.3 becomes an instance of this,
not a veslo-server special case. Dynamic values (ports, endpoints, workspace
sets) are delivered to running children via authenticated APIs, never by
respawn.

### 2.2 Ownership map for state (and deletion of reconcilers)

Publish a table in `docs/dev/` and enforce it in review:

| Concept | Authority | Everyone else |
|---|---|---|
| Workspace registry + IDs | veslo-server (`server.json`) | acknowledged-API mirrors |
| Conversations, runs, transcripts | veslo-server (`bindings.sqlite`); engine DB is upstream source, orchestrator reports run events | projections |
| Local process descriptors (URLs, tokens, status) | desktop shell (pushed events) | in-memory consumers only |
| Remote-mode settings | user settings store | — |
| Model/agent preferences | one preferences store per scope (app/workspace) | — |

Rules: mirrors are acknowledged and idempotent (client sends, authority
returns canonical record, client stores authority's version); reconcilers are
replaced by a startup sync + change events; nothing writes another layer's
file. Target: cut the 33 JSON state files and 33 localStorage keys roughly in
half in phase 2, with each survivor assigned an owner.

### 2.3 Contracts as generated artifacts

- Server: define route schemas (zod/typebox), generate OpenAPI + the TS
  client used by the app. Delete the 1 589-line hand mirror.
- Desktop: adopt `tauri-specta` (or `ts-rs`) to generate the TS bindings for
  the 90 commands. Delete the 1 488-line hand mirror.
- Error shape: one typed error envelope `{status, code, layer, message,
  retryable}` across server routes and the orchestrator proxy, so the app
  stops pattern-matching 404 bodies.
- CI gate: regenerate and diff — contract drift fails the build.

### 2.4 Event spine instead of polling

One multiplexed SSE/WebSocket channel from veslo-server (status, capability
changes, run/conversation events, registry changes) plus Tauri lifecycle
events from the shell. The app keeps a single connection store fed by these;
the ~20 interval loops reduce to one low-frequency watchdog. Rust command
handlers become non-blocking snapshot reads (no I/O under mutexes — already
specified in the companion doc).

### 2.5 App-shell layering

Keep `app.tsx` as composition root (policy already set), but:

- introduce explicit layers for the 73 contexts — `stores/` (reactive state,
  no I/O), `services/` (I/O clients, no signals), `workflows/` (effects and
  orchestration) — with an import-direction rule (workflows → services →
  stores) enforced by dependency-cruiser; the existence of `late-bound.ts`
  cycles marks exactly the modules to split first;
- replace the ~160-field prop bags with scoped providers/stores so pages
  subscribe to the slices they need; target: `SessionViewProps` under 30
  fields, `app.tsx` under 1 500 LOC without moving complexity into a new
  God wiring file.

### 2.6 Decompose the two backend monoliths along existing seams

- `orchestrator/cli.ts` → `args.ts`, `daemon.ts` (HTTP surface),
  `engine-pool` (exists), `run-registry` (exists), `proxy.ts`, `sandbox/`
  (exists) — the modules mostly exist; the monolith is the glue file, so this
  is mechanical extraction with characterization tests first.
- `server/src/server.ts` → keep `routes/*` but move auth/CORS/proxy
  middleware and route registration into composable routers; `server.ts`
  becomes bootstrap only.

### 2.7 Configuration model

One typed config resolver per process with documented precedence
(defaults < file < env < flags), a generated reference doc for the supported
env vars, deprecation of the rest of the 245 (most are point fixes that can
become file config), and removal of env→localStorage hydration (build-time
config stays build-time).

### 2.8 Error policy

Lint-enforced ban on empty catches in new/changed code (allowlist with
justification comments for the genuine fire-and-forget cases); typed error
envelope end-to-end (§2.3); `flow_log!`/send-trace unified into structured
tracing with the trace id propagated across all four processes.

### 2.9 Legacy retirement plan (dated, not aspirational)

1. `openwork.*` keys/files: one-time migration on next minor, delete readers
   the release after.
2. `packages/web`: decide archive vs. thin remote client; either way remove
   it from the default workspace build graph.
3. Toy UI: build-flag it out of production server binaries.
4. WDIO specs: triage the 57 into "convert to pilot" (the ~10 that cover the
   riskiest flows) and delete the rest; the testing playbook already declares
   them unusable.
5. Locales: adopt key extraction + completeness check in CI, drop the custom
   script.

### 2.10 Testing strategy matched to the risk profile

- Grow `tauri-pilot` from 2 to ~12 scenarios covering the seams: cold boot,
  restart/adoption, workspace add/switch, first message flow, run abort,
  engine crash recovery, token recovery, sandbox fallback, two concurrent
  workspaces, updater smoke (several are already mandated by
  `opencode-workspace-runtime-architecture.md` §Validation).
- Contract tests generated from the schemas in §2.3.
- Keep the unit-test discipline as is.

### 2.11 Local trust model, written down

One page in `docs/dev/`: what the client token, host token, lifecycle token,
and OpenCode basic auth each protect; when LAN exposure is allowed; why CORS
`*`/auto-approval are acceptable and under which binds they are not; tokens
move off argv and out of invite URL query params (short-lived invite codes
exchanged for tokens instead).

### 2.12 Phasing

**Phase 0 — guardrails (cheap, immediate):** dependency-direction lint for
app contexts; empty-catch lint; contract-drift CI check (even against the
hand mirrors, before codegen lands); pick the 12 pilot scenarios and wire the
harness into CI on one platform.

**Phase 1 — runtime spine:** unified child supervisor + readiness handshake +
event push (subsumes companion-doc Phases 1–2); app connection store; delete
poll loops.

**Phase 2 — ownership and contracts:** acknowledged workspace/run APIs with
server-assigned IDs; generated TS clients for server and Tauri; state-file
and localStorage cull; config resolvers.

**Phase 3 — decomposition and retirement:** orchestrator + server bootstrap
split; app store/service/workflow layering and prop-bag reduction; legacy
deletions per §2.9.

Each phase gates on the pilot scenarios; canonical docs in `docs/dev/`
(`app-map.md`, `state-and-config-reference.md`, `veslo-server-app-contract.md`,
`opencode-workspace-runtime-architecture.md`) are updated as behavior lands.
