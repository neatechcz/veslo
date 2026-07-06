---
title: Veslo Server Access Architecture Implementation Plan
date: 2026-07-06
status: draft
done: false
issue: unlinked
source_audit: docs/plans/2026-07-04-veslo-server-access-root-causes-and-architecture.md
vsa00_baseline_and_tracking_done: false
vsa01_persist_host_token_and_descriptor_done: true
vsa02_instance_identity_adoption_done: true
vsa03_cross_platform_orphan_cleanup_done: true
vsa04_secrets_files_not_argv_done: true
vsa05_ready_handshake_and_mutex_split_done: true
vsa06_serialized_desktop_state_machine_done: false
vsa07_frontend_single_descriptor_done: false
vsa08_single_auth_recovery_done: true
vsa09_acknowledged_workspace_registration_done: true
vsa10_server_owned_workspace_ids_done: false
vsa10a_workspace_id_golden_vectors_done: true
vsa10b_dual_id_mapping_migration_done: false
vsa10c_workspace_id_cutover_cleanup_done: false
vsa11_engine_config_hot_swap_done: false
vsa12_port_conflict_policy_done: false
vsa13_e2e_docs_and_release_gate_done: false
---

# Veslo Server Access Architecture Implementation Plan

## Goal

Make the desktop app able to answer one question reliably:

- Which local Veslo server instance belongs to this app run?
- Which URL and credentials does that instance accept right now?
- Which workspace ids does that server know about?

The target product behavior is:

- A local server is not reported as running until it has bound a port and
  published an identity-bearing runtime descriptor.
- Existing-server adoption is based on instance identity, not token/PID
  heuristics.
- Both client and host credentials survive app restarts for the same accepted
  instance.
- Workspace and engine changes do not rotate tokens or respawn the local
  server.
- The frontend consumes one pushed local descriptor and never guesses a local
  URL from an OpenCode data-plane URL.
- A 401, wrong instance, port conflict, or workspace registry miss has one
  attributed reason in state, logs, and UI.

## Source Audit Summary

This plan implements the architecture described in:

```text
docs/plans/2026-07-04-veslo-server-access-root-causes-and-architecture.md
```

Current root causes from that audit:

- Readiness is inferred after `spawn()`, before the server listens.
- `/health` has no durable per-boot identity, so stale or foreign servers on
  8787 can be adopted with the wrong token.
- `hostToken` is not restored from persisted state, so host-scoped workspace
  registry calls are skipped after restart.
- Secrets are passed on argv.
- Server respawns are triggered by workspace list and dynamic orchestrator URL
  changes.
- Workspace ids are derived independently from differently normalized paths.
- The app has multiple local/server URL and token stores, including a local
  fallback that can intentionally create unauthenticated requests.

## Implementation Status Contract

Every task starts as `done: false`.

Only mark a task `done: true` after code, focused tests, listed verification,
and any required docs updates for that task are complete in the original
worktree. Do not mark top-level `done: true` until VSA00 through VSA09, VSA10A
through VSA10C, and VSA11 through VSA13 are complete and verified.

If a task is partially implemented, append a dated note under that task and
leave its `done: false` line unchanged.

If an agent discovers that a task must be split, add new front matter flags
with `done: false` before implementing the split. Do not overload an existing
task with unrelated cleanup.

## Coordination Notes For Agents

Before implementing, verify this plan is visible to the worktree:

```powershell
git ls-files docs/plans/2026-07-06-veslo-server-access-implementation-plan.md
git status --short -- docs/plans/2026-07-06-veslo-server-access-implementation-plan.md
```

Expected current owners:

- Desktop server lifecycle:
  `packages/desktop/src-tauri/src/veslo_server/mod.rs`,
  `packages/desktop/src-tauri/src/veslo_server/manager.rs`,
  `packages/desktop/src-tauri/src/veslo_server/spawn.rs`,
  `packages/desktop/src-tauri/src/commands/veslo_server.rs`.
- Desktop workspace registry client:
  `packages/desktop/src-tauri/src/workspace/server_client.rs`.
- Server config, health, workspace registry:
  `packages/server/src/config.ts`,
  `packages/server/src/routes/health.ts`,
  `packages/server/src/workspaces.ts`,
  workspace CRUD routes in `packages/server/src/routes/`.
- Frontend connection state:
  `packages/app/src/app/context/veslo-server-connection.ts`,
  `packages/app/src/app/lib/veslo-server/connection.ts`,
  `packages/app/src/app/context/server.tsx`,
  `packages/app/src/app/context/global-sdk.tsx`,
  `packages/app/src/app/context/managed-ai-runtime-config.ts`.
- Pilot/runtime tests:
  `packages/e2e/specs/`,
  `packages/e2e/pilot-scenarios/`,
  `docs/testing/tauri-pilot/README.md`.

## KISS Boundary

Core for this plan:

- Establish one owner per local-server fact.
- Preserve the current desktop-managed local server product behavior.
- Replace heuristic adoption with instance identity.
- Make workspace registration acknowledged before later removing the launch
  workspace snapshot.
- Keep remote server mode working with settings-owned URL and token.
- Add tests around each migration seam before deleting old behavior.

Not core for this plan:

- Rebuilding the whole app settings page.
- Changing cloud sync semantics.
- Changing managed AI gateway routing except where local descriptor/auth
  ownership currently feeds it.
- Replacing OpenCode SDK integration.
- Changing business behavior of workspace CRUD beyond making server registry
  synchronization reliable.

## Rollout Slices

This document is the roadmap, not one monolithic PR. Keep each slice small
enough to verify and revert independently.

**First server-access slice:**

- VSA00 baseline.
- VSA02 instance identity.
- VSA01 host token restore gated by matching `instanceId`.
- Minimal VSA05 READY/readiness without losing stdout/stderr diagnostics.
- Minimal VSA07 removal of derived local URL fallback and tokenless local mode.
- VSA09 only if the active incident includes workspace registry drift.

**Near follow-ups:**

- VSA04 secrets files instead of desktop token argv.
- VSA03 cross-platform orphan cleanup after safety helpers/gates exist.
- VSA10A workspace-id golden vectors.

**Deferred architecture slices:**

- VSA06/VSA08 state machine and centralized auth recovery.
- VSA10B/VSA10C workspace identity migration.
- VSA11 runtime config hot-swap.
- VSA12 full port policy and ephemeral fallback.

VSA13 applies per slice, with the full final gate only after the roadmap is
complete.

## Implementation Order

Use this order inside the rollout slices. Do not treat VSA00 through VSA13 as
one implementation batch.

1. VSA00 baseline and tracking.
2. VSA02 plus gated VSA01.
3. Minimal VSA05, then minimal VSA07.
4. VSA09 if registry drift is in scope.
5. VSA04 and VSA03 as security/process follow-ups.
6. VSA10A before any workspace-id migration.
7. VSA06/VSA08 only after the snapshot-based fixes prove insufficient or too
   noisy.
8. VSA10B/VSA10C after VSA09 and VSA10A.
9. VSA11 after workspace registration/identity is stable.
10. VSA12 after VSA02 and enough lifecycle state exists to report port-policy
   reasons.
11. VSA13 for each slice and once for the full roadmap.

VSA01 is not independently safe under the old token/PID adoption heuristic. It
may land in the same slice as VSA02, or it may persist `hostToken` earlier only
if restore/use of that host token is gated behind matching `instanceId`.

VSA03, VSA04, and the mutex part of VSA05 can be implemented by separate
agents if they coordinate on `VesloServerInfo` and persisted state schema
changes from VSA02.

## VSA00: Baseline And Tracking

done: false

Coordination note 2026-07-06: VSA00 was not completed before the first
implementation slice, so it intentionally remains `done: false` instead of
being retroactively claimed. Current branch when this note was added:
`local/sandbox-merge`, HEAD `5ef026f1`; this plan is tracked in git. Later
agents should treat this as baseline debt, not as a blocker for the already
verified VSA01-VSA05/VSA09 slice.

Goal:

Freeze the current behavior, known failing scenarios, and task ownership before
changing lifecycle code.

Implementation:

- Link the real issue in front matter if one exists.
- Add a short dated note under this task with:
  - current branch and commit,
  - whether this plan is tracked,
  - known current failing scenario names,
  - current local server tests that pass before the migration.
- Capture current process and auth behavior from:
  - `veslo_server::tests`,
  - `commands::veslo_server::tests`,
  - `packages/server/src/tests/workspaces.test.ts`,
  - `packages/app/src/app/tests/context/veslo-server-connection.test.ts`,
  - at least one pilot scenario that exercises local server startup if the
    pilot environment is healthy.
- Add missing regression tests only where they make later behavior measurable.
  Do not implement the migration in VSA00.

Acceptance:

- This plan identifies the issue and baseline commands used by later agents.
- There is a clear note for any skipped pilot validation, including the exact
  environment reason.
- No runtime behavior is changed except additive failing tests or harmless test
  scaffolding.

Verification:

```powershell
git status --short
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml veslo_server::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml veslo_server::spawn::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::veslo_server::tests --quiet
pnpm --filter veslo-server exec bun test src/tests/workspaces.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/veslo-server-connection.test.ts
```

Mark done when:

- `vsa00_baseline_and_tracking_done: true`.
- This task's `done: true`.

## VSA01: Persist Host Token And Descriptor

done: true

Implementation note 2026-07-06: desktop state now persists `hostToken` with
`instanceId`, and recovery restores it only after `/health.instanceId` matches
the persisted descriptor. Old state without instance identity is rejected.
The dev external-server fallback also adopts `VESLO_HOST_TOKEN` only when it is
explicitly present.

Goal:

Stop losing host scope after an app restart.

Implementation:

- Extend `PersistedVesloServerState` in
  `packages/desktop/src-tauri/src/veslo_server/mod.rs` to persist
  `hostToken`.
- Do not restore or use a persisted `hostToken` for any server accepted only by
  legacy token/PID heuristics. Restored owner scope is allowed only when the
  live server's `instanceId` matches persisted state, or when VSA01 and VSA02
  land in the same implementation slice.
- Update `persist_veslo_server_info` and plugin-state handling carefully:
  - main desktop state may persist `hostToken`;
  - plugin state must not expose host scope unless a plugin contract explicitly
    already allows it.
- Return restored `host_token` from `persisted_state_to_info_with_health` only
  after instance identity acceptance.
- Update `discover_external_veslo_server` only for dev/env cases where
  `VESLO_HOST_TOKEN` is explicitly present.
- Add tests that prove a recovered persisted server keeps host scope and that
  plugin state does not leak host token.
- Add tests proving legacy heuristic adoption never exposes restored
  `hostToken`.
- Keep this schema backward compatible with state files that do not yet contain
  `hostToken`.

Acceptance:

- After adopting a valid persisted local server, workspace registration, rename,
  and delete calls can still include host token.
- A server adopted without matching `instanceId` never receives a restored
  owner credential.
- Old state files without `hostToken` still parse and produce a clear
  `TokenMissing`/limited-host-scope reason where appropriate.
- No frontend localStorage token cache is introduced or relied on.

Verification:

```powershell
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml veslo_server::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::veslo_server::tests --quiet
rg -n "host_token: None|hostToken|PersistedVesloServerState|veslo-server-plugin-state" packages/desktop/src-tauri/src/veslo_server packages/desktop/src-tauri/src/commands
```

Mark done when:

- `vsa01_persist_host_token_and_descriptor_done: true`.
- This task's `done: true`.

## VSA02: Instance Identity Adoption

done: true

Implementation note 2026-07-06: the desktop generates a per-boot `instanceId`,
passes it to the managed server via `VESLO_INSTANCE_ID`, persists it, reads it
from `/health`, rejects persisted adoption without a matching `instanceId`, and
exposes `waiting_ready` while the spawned child has not proven readiness.
Live snapshots with an expected `instanceId` now treat a 200 `/health` response
without `instanceId` as an identity failure instead of a valid running server.

Goal:

Make local server adoption identity-based instead of token/PID heuristic-based.

Implementation:

- Add a per-boot `instanceId` generated by the desktop before spawning the
  server.
- Persist `instanceId` in the desktop local server state.
- Add `instanceId` to the server runtime/config surface:
  - read from a runtime descriptor or env during boot,
  - expose on `/health` as `{ ok, version, uptimeMs, pid, instanceId }`.
- Extend `HealthIdentity` and `server_health_identity` to read `instanceId`.
- Replace adoption logic in `persisted_state_to_info_with_health` and
  `sanitize_live_info_with_health`:
  - accept when health `instanceId` equals persisted/live `instanceId`;
  - reject mismatches with `IdentityMismatch`;
  - keep legacy token/PID compatibility only behind a short migration window
    test and a dated TODO, or remove it if all supported servers can emit
    `instanceId`.
- Add tests for:
  - matching instance accepted,
  - mismatched instance rejected and state file removed,
  - missing instance on a current persisted state rejected,
  - legacy state behavior if retained.

Acceptance:

- A stale or foreign server on the same port cannot be reported as "running"
  for this desktop descriptor unless its `instanceId` matches.
- `Invalid bearer token` from wrong-instance adoption is prevented at the
  lifecycle layer, not retried in random clients.
- `/health` still remains unauthenticated and does not expose bearer tokens.

Verification:

```powershell
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml veslo_server::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::veslo_server::tests --quiet
pnpm --filter veslo-server exec bun test src/tests/server.health-status-routes.test.ts
rg -n "token:.*health|instanceId|IdentityMismatch|HealthIdentity" packages/desktop/src-tauri/src packages/server/src
```

Mark done when:

- `vsa02_instance_identity_adoption_done: true`.
- This task's `done: true`.

## VSA03: Cross-Platform Orphan Cleanup

done: true

Implementation note 2026-07-06: Unix stale PID cleanup now reads process
metadata, accepts only Veslo server binaries or verified Bun dev-watch server
wrappers, rejects unrelated PIDs with `stale_process_owner`, and sends
`kill -TERM` only after predicate acceptance. Windows `taskkill` args remain
constrained to `IMAGENAME eq veslo-server.exe`. Safety predicates and command
construction are covered by cfg-free unit tests, so Windows CI exercises the
Unix ownership logic with synthetic metadata. Follow-up hardening accepts
real Tauri target-suffixed sidecar names such as
`veslo-server-aarch64-apple-darwin` and records stale cleanup failures through
bootstrap launch diagnostics instead of only printing to stderr. Bun dev-watch
ownership can resolve relative `src/cli.ts` wrappers on Linux through
`/proc/<pid>/cwd` and on macOS through `lsof -a -p <pid> -d cwd -Fn`, keeping
the cwd-based safety predicate instead of accepting arbitrary Bun watchers.

Goal:

Remove the Windows-only stale process cleanup gap.

Implementation:

- Replace the non-Windows no-op `terminate_stale_veslo_server_process` with a
  conservative Unix implementation.
- Before killing a PID on Unix:
  - verify the PID is alive,
  - verify the executable or command line belongs to Veslo server or the known
    dev-watch wrapper,
  - avoid killing arbitrary processes from a corrupted state file.
- Keep Windows `taskkill` behavior but align tests and diagnostics with the
  same safety contract.
- Add tests around command construction and safety predicates. Use unit-level
  helpers so tests do not kill real processes.
- Put process-ownership checks behind cfg-free helper functions so Windows CI
  can still compile and exercise Unix safety predicates with synthetic process
  metadata.
- Add a macOS/Linux CI or manual gate for the real signal path if the final
  implementation still has platform-specific `#[cfg(not(windows))]` code that
  cannot be covered from Windows.
- Emit a launch diagnostic when stale cleanup is skipped for safety.

Acceptance:

- A mismatched persisted instance can be terminated and replaced on macOS and
  Linux.
- A corrupted persisted PID cannot cause an unrelated process to be killed.
- Cleanup behavior is observable in diagnostics.
- The Unix stale-process path is either covered by cfg-free unit tests or by an
  explicit macOS/Linux verification gate recorded under this task.

Verification:

```powershell
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml veslo_server::tests --quiet
rg -n "terminate_stale_veslo_server_process|taskkill|kill -TERM|IdentityMismatch|stale persisted PID|stale_process_owner" packages/desktop/src-tauri/src/veslo_server
```

Mark done when:

- `vsa03_cross_platform_orphan_cleanup_done: true`.
- This task's `done: true`.

## VSA04: Secrets Files, Not Argv

done: true

Implementation note 2026-07-06: desktop spawn now writes a local
`veslo-server-secrets.json` with `clientToken`, `hostToken`, and optional
`orchestratorLifecycleToken`, passes only `VESLO_SECRETS_FILE` and runtime
descriptor path env vars to the server, and removes token-bearing desktop argv
flags. The server resolves config with precedence CLI > secrets-file > env >
config file > generated, keeps manual CLI `--token` compatibility, accepts the
new `VESLO_RUNTIME_FILE` alias, and records `secrets-file` as the token source.
Configured secrets files are fail-closed: unreadable, invalid, or incomplete
`VESLO_SECRETS_FILE` input fails server boot instead of falling back to env,
file, or generated tokens. Secrets files are removed on stale-state cleanup,
explicit persisted-state clear, and every desktop spawn failure after the
secrets file is written.

Goal:

Stop passing local bearer tokens and lifecycle tokens through process argv.

Implementation:

- Add a desktop-written secrets file with restrictive permissions:
  - `clientToken`,
  - `hostToken`,
  - `orchestratorLifecycleToken` when present.
- Pass only file paths through environment, for example:
  - `VESLO_RUNTIME_FILE`,
  - `VESLO_SECRETS_FILE`.
- Update `packages/server/src/config.ts` to read these files before falling
  back to env/file config.
- Remove `--token`, `--host-token`, and `--orchestrator-lifecycle-token` from
  desktop sidecar spawn args.
- Keep CLI support for manual/server use if required. `packages/server/src`
  may still parse and document `--token` for manual CLI compatibility; the
  forbidden path is desktop sidecar spawn argv.
- Add server config tests for runtime/secrets file precedence while preserving
  existing CLI parser tests.
- Update help text and tests to make the desktop-vs-manual distinction
  explicit.
- Clean up secrets files when the server is stopped or replaced where safe.

Acceptance:

- Desktop-spawned process listings do not contain local client token, host
  token, or orchestrator lifecycle token.
- Server config resolution remains backward compatible for manual CLI use.
- Server tests prove secrets-file values are loaded and CLI `--token` remains
  a manual compatibility path, not the desktop path.
- Secrets file permissions are `0600` or platform equivalent where supported.

Verification:

```powershell
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml veslo_server::spawn::tests --quiet
pnpm --filter veslo-server exec bun test src/tests/config.bridge-host.test.ts src/tests/config.debug-logs.test.ts src/tests/config.den-api-base.test.ts src/tests/config.workspace-id.test.ts src/tests/config.runtime-files.test.ts
rg -n "\"--token\"|\"--host-token\"|\"--orchestrator-lifecycle-token\"" packages/desktop/src-tauri/src/veslo_server packages/desktop/src-tauri/src/commands/veslo_server.rs
rg -n "VESLO_SECRETS_FILE|VESLO_RUNTIME_FILE|--token" packages/server/src/config.ts packages/server/src/tests
```

Mark done when:

- `vsa04_secrets_files_not_argv_done: true`.
- This task's `done: true`.

## VSA05: READY Handshake And Mutex Split

done: true

Implementation note 2026-07-06: the server now writes an optional runtime
descriptor atomically and prints `VESLO_SERVER_READY {json}` only after
`Bun.serve` has bound. The desktop output collector remains the only consumer
of the process event stream, preserves stdout/stderr, and observes READY from
that same stream before promoting `waiting_ready` to `running`. `veslo_server_info`
takes a snapshot under the manager mutex, releases it for `/health`, and only
re-locks to apply state updates. The old workspace reconciliation `/health`
sleep-poll was removed; registration now depends on the start/READY contract.
Follow-up note 2026-07-06: snapshots now report `running: false` unless the
child process has reached lifecycle `Running`, so `WaitingReady` and `Blocked`
cannot enter frontend active-host resolution. `veslo_server_info` no longer
performs synchronous `/health` or persisted recovery I/O in the UI poll path.

Goal:

Report the local server as running only after it is actually listening, and
stop blocking lifecycle operations on health I/O inside the manager mutex.

Implementation:

- Add server boot behavior:
  - bind/listen first,
  - atomically write runtime descriptor,
  - print one machine-readable READY line after the port is listening.
- Add desktop `WaitingReady` lifecycle status or equivalent reasoned state.
- Update `start_veslo_server` to wait for READY with a bounded timeout before
  publishing `Running`.
- The READY reader must own the `Receiver<CommandEvent>` stream and tee or
  hand it off to `spawn_output_collector_with_forwarder`; no stdout/stderr
  event may be consumed only by readiness waiting. Diagnostics after READY and
  before READY must still reach `last_stdout`, `last_stderr`, and debug log
  forwarding.
- Use `/health` with expected `instanceId` as fallback only when stdout READY
  is not available.
- Move health probing out of `veslo_server_info` while holding
  `VesloServerManager.inner`.
- Keep `veslo_server_info` a fast snapshot command; background/watchdog probes
  may update state separately.
- Remove or shrink readiness polling in `reconcile_server_workspaces` once the
  start contract guarantees readiness.

Acceptance:

- A server that is still booting cannot be killed by the frontend ensure path
  solely because one immediate health request failed.
- `veslo_server_info` does not hold the manager mutex across ureq/fetch or WSL
  probe I/O.
- Workspace registration can depend on the desktop READY result instead of
  sleeping and polling `/health` in every caller.
- stdout/stderr diagnostics are preserved when READY is observed from the same
  process event stream that feeds the normal output collector.

Verification:

```powershell
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml veslo_server::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::veslo_server::tests --quiet
pnpm --filter veslo-server exec bun test src/tests/server.health-status-routes.test.ts
rg -n "WaitingReady|READY|server_health_identity|CommandEvent|spawn_output_collector_with_forwarder|reconcile_server_workspaces" packages/desktop/src-tauri/src packages/server/src
```

Mark done when:

- `vsa05_ready_handshake_and_mutex_split_done: true`.
- This task's `done: true`.

## VSA06: Serialized Desktop State Machine

done: false

Goal:

Make the desktop shell the only owner of local server start, restart, adoption,
and descriptor publication. This is a state/frontend cleanup follow-up, not a
prerequisite for the first server-access slice.

Implementation:

- First prefer extending the existing `veslo_server_info` snapshot and Rust
  lifecycle reasons. Start this task only if snapshot-based ownership still
  leaves duplicated restart decisions or unclear state transitions.
- Introduce a single serialized start/restart queue in the desktop layer.
- Route all start intents through that queue:
  - `engine_start`,
  - `veslo_server_restart`,
  - frontend local ensure command,
  - recovery paths after auth/identity failures.
- Coalesce compatible start intents instead of kill/respawn ping-pong.
- Model lifecycle states explicitly:
  - `Stopped`,
  - `Spawning`,
  - `WaitingReady`,
  - `Running`,
  - `Degraded`,
  - `Blocked(reason)`.
- Emit a Tauri event on every descriptor/state transition. Payload should
  include status, reason, URLs, tokens, `instanceId`, PID, and timestamps.
- Treat descriptor credentials as secret state:
  - `clientToken` may be carried only in the trusted desktop local descriptor;
  - `hostToken` may be exposed to the renderer only for local Tauri mode and
    only as in-memory descriptor state needed by owner-scoped calls;
  - `hostToken` must never be written to localStorage, settings, invite URLs,
    bootstrap diagnostics, debug logs, or generic status logs;
  - state events and snapshots that do not need owner scope must omit or redact
    `hostToken`.
- Keep `veslo_server_info` as a snapshot/read model for watchdog and legacy
  tests, not as the primary frontend transport.

Acceptance:

- No frontend code directly decides to kill and respawn the local server.
- Concurrent start requests cannot interleave with different configs and cause
  repeated respawns.
- UI and logs can distinguish booting, stopped, auth desync, port conflict,
  identity conflict, and degraded health.
- No event/log path leaks `hostToken` outside the in-memory trusted desktop
  renderer path.

Verification:

```powershell
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml veslo_server::manager::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::engine::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::veslo_server::tests --quiet
rg -n "veslo_server_restart|start_veslo_server|emit_all|VesloServerLifecycleStatus|Blocked|Degraded|WaitingReady" packages/desktop/src-tauri/src packages/app/src/app
```

Mark done when:

- `vsa06_serialized_desktop_state_machine_done: true`.
- This task's `done: true`.

## VSA07: Frontend Single Descriptor

done: false

Partial implementation note 2026-07-06: the frontend connection flow no longer
derives a local Veslo URL from the OpenCode URL and no longer creates a
tokenless local fallback auth path. The `deriveLocalVesloServerUrlFromOpencodeBaseUrl`
helper and the active `localFallbackUrl` resolver contract were removed, and
managed-AI provider routing now uses only `activeVesloServerRoutingInfo()` for
local server base URL and tokens. The broader event-fed single descriptor store
is still open, so this task remains `done: false`.

Partial implementation note 2026-07-06: `global-sdk.tsx` and `server.tsx` no
longer read `veslo.server.token` directly from localStorage. Remote OpenCode
proxy auth now goes through `resolveOpencodeProxyAuthHeaders`, which allows the
stored remote settings token for non-local `/opencode` proxy URLs but refuses
to apply that settings token to Tauri loopback `/opencode` URLs. The remote
settings token remains in localStorage for explicit remote-server mode; no
host token is stored there.

Goal:

Make the frontend consume the desktop-pushed local descriptor and stop guessing
local server URLs.

Implementation:

- First slice: remove the derived local URL fallback and tokenless local mode
  using the current trusted desktop snapshot.
- Follow-up: add one app-side local server descriptor store fed by Tauri events
  from VSA06 and seeded by one snapshot on startup.
- Reduce local-mode URL/auth resolution:
  - local mode uses descriptor URL and descriptor `clientToken` only for normal
    bearer requests;
  - local owner operations may use descriptor `hostToken`, but only through
    owner-scoped client wrappers;
  - remote server mode uses settings URL and settings token only.
- Delete `deriveLocalVesloServerUrlFromOpencodeBaseUrl` from local connection
  resolution.
- Remove the branch in `resolveVesloServerAuth` that returns no token for a
  derived local fallback URL.
- Keep remote invite/settings flows intact.
- Update `managed-ai-runtime-config.ts`, `global-sdk.tsx`, and
  `server.tsx` so they no longer create a second local truth from localStorage
  or OpenCode base URLs.
- Keep dynamic OpenCode daemon URLs out of `veslo.server.list`; that list is
  remote-server configuration only.

Acceptance:

- With no descriptor and no remote settings entry, state is `Stopped` or
  `Blocked(reason)`, not `limited` through an unauthenticated local client.
- URL and token always come from the same candidate.
- `hostToken` never enters localStorage, remote server settings, diagnostics,
  or non-owner request clients.
- `deriveLocalVesloServerUrlFromOpencodeBaseUrl` is deleted or isolated only
  for tests that are removed in the same slice.

Verification:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/veslo-server-connection.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/app-managed-ai-bootstrap-gate.test.ts
rg -n "deriveLocalVesloServerUrlFromOpencodeBaseUrl|localFallbackUrl|vesloServerLocalFallbackBaseUrl" packages/app/src/app/context packages/app/src/app/lib -g "*.ts" -g "*.tsx"
rg -n "veslo.server.token|openwork.server.token|resolveVesloServerAuth|resolveVesloServerBaseUrl|limited" packages/app/src/app/context packages/app/src/app/lib -g "*.ts" -g "*.tsx"
```

Mark done when:

- `vsa07_frontend_single_descriptor_done: true`.
- This task's `done: true`.

## VSA08: Single Auth Recovery

done: true

Implementation note 2026-07-06: app-side Veslo server probes now classify
401/403 through one helper, `resolveVesloServerAuthFailureStatus`. A probe with
no credential still reports `limited`, preserving explicit remote/no-token
semantics, but a probe with a client or host credential reports
`auth_desync`. Status stability surfaces `auth_desync` immediately instead of
holding a recent connected/limited status through transient-failure grace. The
local `ensureLocalVesloServerRunning` path treats `auth_desync` as non-usable
and returns false without calling `vesloServerRestart`, so a wrong bearer token
does not independently restart the local server. UI status labels now show the
existing authentication-failed text for `auth_desync`. Remaining `401`/restart
grep hits after this slice are remote DEN/remote-server handling, session-error
classification, explicit user restart controls, or tests; they are not local
server 401 recovery paths.

Goal:

Handle local-server 401s in one place as connection-state failures, not as
independent client retries or silent limited states. This is a follow-up after
VSA01, VSA02, and the minimal VSA07 cleanup have removed the main 401 causes.

Implementation:

- Re-audit remaining 401 paths after VSA01/VSA02/VSA07 before adding this
  abstraction. If wrong-instance adoption and tokenless fallback were the only
  causes, keep this task `done: false` and record that no central recovery was
  needed yet.
- Add one auth recovery routine owned by the frontend connection layer or a
  small local server transport owner:
  - refresh descriptor,
  - retry idempotent request once when descriptor changed,
  - otherwise emit/report `auth_desync`.
- Ensure all local Veslo server clients route 401 handling through that routine.
- Remove scattered 401 restart/reconnect behavior in call sites.
- Teach the desktop state machine from VSA06 how to handle `auth_desync`:
  - prefer descriptor refresh/adoption when `instanceId` matches,
  - managed restart only through the serialized queue.
- Update status stability so `auth_desync` is not collapsed into generic
  disconnected/limited.

Acceptance:

- A wrong bearer token produces one attributed `auth_desync` path.
- No call site independently restarts the local server on a 401.
- Local mode never stores a repaired local token in localStorage; remote mode
  settings token remains user-owned.

Verification:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/veslo-server-connection.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server-status-stability.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts
rg -n "401|auth_desync|Invalid bearer token|veslo.server.token|writeVesloServerSettings|reconnectVesloServer|resolveVesloServerAuthFailureStatus" packages/app/src/app packages/desktop/src-tauri/src
```

Mark done when:

- `vsa08_single_auth_recovery_done: true`.
- This task's `done: true`.

## VSA09: Acknowledged Workspace Registration

done: true

Implementation note 2026-07-06: desktop workspace server-client mutations now
return `WorkspaceServerSyncResult` instead of `void`, classify accepted,
duplicate, skipped, HTTP error, and transport outcomes, and write
`workspace_registry_unsynced` into the server manager's visible diagnostics
stream (`last_stderr`) when sync is skipped or fails. Reconcile now returns
attempted/accepted/skipped/failed counts. Workspace create, rename, and forget
calls log the structured sync result instead of dropping it. `POST
/workspaces/local` responses include the acknowledged `workspace` object with
server workspace id/path/name data while preserving the existing `activeId`,
`items`, and `persisted` fields. Duplicate local registration is accepted only
for an explicit `workspace_exists` conflict with returned id/path evidence.
Frontend host-workspace activation now rejects quickly with
`workspace_registry_unsynced:*` when server registration fails or remains
invisible after refresh, so callers do not need to wait for the outer 30s
activation timeout to learn that the server registry is out of sync. Local
activation surfaces that reason through the UI error path. The old frontend
boot reconcile path is now read-only: it lists server workspaces and logs
`reconcileVesloServerWorkspaces:workspace_registry_unsynced` for missing local
entries, but does not call `POST /workspaces/local`.

Goal:

Stop treating server workspace synchronization as fire-and-forget.

Implementation:

- Change desktop workspace server client calls in
  `packages/desktop/src-tauri/src/workspace/server_client.rs` to return
  structured results.
- Add unit tests in `packages/desktop/src-tauri/src/workspace/server_client.rs`
  before changing call-site behavior; that file currently has no local test
  module.
- Make `POST /workspaces/local` response include the server workspace id and
  enough normalized path/name data for the desktop to reconcile.
- Update desktop workspace creation/reconcile flows so registration failure is
  visible to lifecycle/diagnostics instead of silently skipped.
- Keep local workspace mutations user-friendly, but surface a distinct
  `workspace_registry_unsynced` or equivalent reason when the server registry
  is not updated.
- Remove duplicate frontend workspace reconcile if desktop becomes the owner,
  or gate it as a temporary read-only verification path with tests.
- Preserve current IDs until VSA10B/VSA10C change authority.

Acceptance:

- Workspace add/rename/delete knows whether the server accepted the mutation.
- Missing host token cannot silently skip server registry sync.
- Sidebar activation cannot wait 12 to 30 seconds before revealing that the
  server registry does not know the workspace.

Verification:

```powershell
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml workspace::server_client --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::workspace::tests --quiet
pnpm --filter veslo-server exec bun test src/tests/workspaces.test.ts src/tests/server.workspaces-crud.test.ts src/tests/server.workspace-management-routes.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-server-registry.test.ts src/app/tests/context/workspace-server-registry-source.test.ts src/app/tests/context/workspace-activation-local-source.test.ts
rg -n "fire-and-forget|post_local_workspace|reconcile_server_workspaces|workspace_registry_unsynced|workspaces/local" packages/desktop/src-tauri/src packages/server/src packages/app/src/app
```

Mark done when:

- `vsa09_acknowledged_workspace_registration_done: true`.
- This task's `done: true`.

## VSA10A: Workspace ID Golden-Vector Canonicalization

done: true

Implementation note 2026-07-06: added the shared fixture
`docs/fixtures/workspace-id-golden-vectors.json` and wired it into desktop
`stable_workspace_id`, server `workspaceIdForPath`, and orchestrator
`workspaceIdForLocal` tests. Orchestrator workspace-id logic now lives in
`packages/orchestrator/src/workspace-id.ts` so tests call the runtime helper
without importing the full CLI. The fixture intentionally records current
platform-specific and normalization drift; VSA10A does not change persisted
ids or make server-owned id authority changes.

Goal:

Make the current three workspace-id derivations measurable before changing
authority.

Implementation:

- Add a shared golden-vector fixture for local workspace path identity.
- Cover at least:
  - already-absolute path,
  - relative path resolved from a config dir,
  - trailing separators,
  - Windows drive-letter case,
  - separator normalization,
  - symlink-equivalent paths where the platform can test them.
- Update or wrap current derivation points to consume the same fixture in tests:
  - desktop `stable_workspace_id` in
    `packages/desktop/src-tauri/src/workspace/state.rs`,
  - server `workspaceIdForPath` in `packages/server/src/workspaces.ts`,
  - orchestrator `workspaceIdForLocal` in
    `packages/orchestrator/src/cli.ts`.
- Add a targeted orchestrator test, for example
  `packages/orchestrator/src/tests/workspace-id-golden.test.ts`, that reads
  the same fixture and fails on hash/canonicalization drift.
- Do not change persisted workspace ids in this task unless the migration in
  VSA10B is implemented in the same slice.

Acceptance:

- The repo has one visible test fixture that defines path-to-workspace-id
  compatibility.
- Desktop, server, and orchestrator tests fail on the same normalization drift.
- Existing runtime behavior remains unchanged except for tests and narrowly
  shared canonicalization helpers.

Verification:

```powershell
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml workspace::state::tests --quiet
pnpm --filter veslo-server exec bun test src/tests/workspaces.test.ts
pnpm --filter veslo-orchestrator exec bun test src/tests/workspace-id-golden.test.ts
pnpm --filter veslo-orchestrator typecheck
rg -n "stable_workspace_id|workspaceIdForPath|workspaceIdForLocal|workspace-id|golden" packages/desktop/src-tauri/src packages/server/src packages/orchestrator/src
```

Mark done when:

- `vsa10a_workspace_id_golden_vectors_done: true`.
- This task's `done: true`.

## VSA10B: Dual-ID Mapping And Migration

done: false

Partial implementation note 2026-07-06: acknowledged local workspace
registration now persists the server-confirmed workspace id into the desktop
workspace row's `vesloWorkspaceId` field when the server response includes a
matching path. Desktop rename/delete server calls prefer this mapped id with a
fallback to the existing app-local id, and create-local reloads state after an
accepted registration so the returned workspace list includes the mapping.
The app's active local `vesloServerWorkspaceId` signal now also prefers
`vesloWorkspaceId` with the existing app-local id as fallback, so server-bound
callers that consume that signal move to the mapping without changing UI
identity. This is only the first dual-id mapping step: the remaining app route
builders, orchestrator runtime identity, compatibility migration coverage, and
cutover safety remain open, so VSA10B stays `done: false`.

Goal:

Introduce a durable mapping between the app's local workspace identity and the
server-assigned Veslo workspace id without breaking existing rows, drafts, or
session references. This is a separate workspace identity migration, not part
of the first server-access slice.

Implementation:

- On acknowledged registration from VSA09, persist the server id in
  `veslo_workspace_id` or the chosen canonical mapping field.
- Preserve the existing app workspace id for UI identity and old local state
  references unless a migration proves a full replacement is safe.
- Update server-bound clients and route builders to prefer the mapped server
  id for local Veslo server API calls.
- Add migration tests for existing `veslo-workspaces.json` entries with and
  without `veslo_workspace_id`.
- Add compatibility tests for pending drafts, sidebar activation, attachment
  staging, and session routing where they currently key by app workspace id.
- Add orchestrator dual-id mapping for runtime-owned identity:
  - opencode config dirs under `opencode-config`,
  - engine pool workspace entries,
  - run lifecycle/register/status keys,
  - run-store and run-registry history.
- Preserve or migrate existing orchestrator directories and run records so a
  server-owned id cutover does not split active engine state from previous run
  history.
- Keep `workspace_id_mismatch` recovery in place during this task as a safety
  net, but add diagnostics that show when dual-id mapping prevented it.

Acceptance:

- Existing workspace state migrates without losing user-visible workspace rows.
- Server API calls can use server-assigned ids while app-local identity remains
  stable.
- Orchestrator config dir, engine ownership, and run lifecycle identity remain
  stable across the dual-id migration.
- A missing server-id mapping is a visible sync problem, not a silent 404 later
  in conversation activation.

Verification:

```powershell
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml workspace::state::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml workspace::server_client::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::workspace::tests --quiet
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/app-managed-ai-config-sync-contract.test.ts src/app/tests/app-veslo-server-state-stability.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/send-runtime-readiness.test.ts src/app/tests/lib/veslo-server.test.ts
pnpm --filter veslo-server exec bun test src/tests/workspaces.test.ts
pnpm --filter veslo-orchestrator exec bun test src/tests/workspace-id-golden.test.ts src/tests/workspace-id-mapping.test.ts
rg -n "veslo_workspace_id|workspace_id_mismatch|workspaceIdForPath|stable_workspace_id_for_veslo|workspaceIdForLocal|opencode-config|run-store|server workspace id" packages/desktop/src-tauri/src packages/app/src/app packages/server/src packages/orchestrator/src
```

Mark done when:

- `vsa10b_dual_id_mapping_migration_done: true`.
- This task's `done: true`.

## VSA10C: Server-Owned ID Cutover And Mismatch Cleanup

done: false

Goal:

Complete the workspace-id authority migration and remove symptom-level
workspace-id mismatch recovery where it is no longer needed. Do this only
after VSA10B proves dual-id compatibility in app, server, and orchestrator.

Implementation:

- Make veslo-server the workspace id authority for local server registry after
  VSA09 and VSA10B are complete.
- Ensure all local-server API routes and frontend clients use server-assigned
  ids for server calls.
- Ensure orchestrator runtime identity uses the migrated server-owned id or an
  explicit compatibility mapping for config dirs, engine pools, run lifecycle
  calls, and run-store lookups.
- Remove or downgrade `workspace_id_mismatch` recovery only after tests prove
  dual-id mapping covers the previous failure cases.
- Update docs that describe workspace id ownership and migration semantics.
- Set umbrella `vsa10_server_owned_workspace_ids_done: true` only after VSA10A,
  VSA10B, and VSA10C are true.

Acceptance:

- Server API calls use ids assigned or acknowledged by the server.
- A path normalization difference cannot silently produce a different server
  workspace id for the same registered workspace.
- Engine state, opencode config directories, and run history are not forked
  when workspace ids move to server ownership.
- `workspace_id_mismatch` is no longer a normal recovery path for correctly
  registered local workspaces.

Verification:

```powershell
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml workspace::state::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::workspace::tests --quiet
pnpm --filter veslo-server exec bun test src/tests/workspaces.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/send-runtime-readiness.test.ts src/app/tests/lib/veslo-server.test.ts
pnpm --filter veslo-orchestrator exec bun test src/tests/workspace-id-golden.test.ts src/tests/workspace-id-mapping.test.ts
pnpm --filter veslo-orchestrator typecheck
rg -n "stable_workspace_id|workspaceIdForPath|workspaceIdForLocal|workspace_id_mismatch|veslo_workspace_id" packages/desktop/src-tauri/src packages/server/src packages/orchestrator/src packages/app/src/app
```

Mark done when:

- `vsa10a_workspace_id_golden_vectors_done: true`.
- `vsa10b_dual_id_mapping_migration_done: true`.
- `vsa10c_workspace_id_cutover_cleanup_done: true`.
- `vsa10_server_owned_workspace_ids_done: true`.
- This task's `done: true`.

## VSA11: Engine Config Hot Swap

done: false

Goal:

Decouple server lifetime from workspace list, active workspace, and dynamic
orchestrator daemon URL. Treat this as a runtime hot-swap project, not as part
of the first server-access recovery slice.

Implementation:

- A smaller preceding fix may only prevent respawn on workspace-list changes if
  that can be done without a new runtime-config API. Keep the full hot-swap API
  in this task.
- Spawn veslo-server once per app run with zero launch `--workspace` args after
  VSA09 and VSA10B are reliable.
- Add authenticated server API for runtime/engine config, for example
  `POST /runtime/engine-config`.
- Deliver the current OpenCode/orchestrator endpoints and credentials to the
  running server through that API.
- Inventory server dependencies that are currently frozen from startup
  `ServerConfig` or route-registration closures, then route them through one
  runtime-config owner before enabling hot-swap. This includes at minimum:
  - orchestrator daemon URL and lifecycle token,
  - `OrchestratorLifecycleClient`,
  - conversation-run lifecycle controller ownership,
  - status/runtime-chain health,
  - workspace route helpers that build OpenCode proxy URLs.
- Hot-swap must update or rebuild those dependent clients atomically; a new
  daemon URL or lifecycle token must not leave old lifecycle-client instances
  handling run registration/status/abort calls.
- Update `launch_config_matches` so dynamic workspace list,
  `opencode_base_url`, active workspace id, daemon URL, and lifecycle token no
  longer force respawn.
- Keep respawn only for:
  - crash/child exit,
  - binary update,
  - port/listener change that cannot hot-swap,
  - explicit user restart.
- Update engine start and restart commands to publish config through the new
  API after READY.
- Add tests proving workspace add and engine daemon port change do not rotate
  tokens or replace PID.

Acceptance:

- Adding a workspace mid-session does not drop SSE streams or rotate tokens.
- Engine restart or daemon port change updates server routing without
  respawning veslo-server.
- Lifecycle register/status/abort calls use the new orchestrator daemon URL and
  lifecycle token after hot-swap without a server process restart.
- `--workspace` remains supported only for manual/server CLI compatibility, not
  desktop lifecycle ownership.

Verification:

```powershell
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml veslo_server::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::engine::tests --quiet
pnpm --filter veslo-server exec bun test src/tests/server.health-status-routes.test.ts src/tests/server-conversations.test.ts src/tests/orchestrator-lifecycle-client.test.ts src/tests/workspaces.test.ts
rg -n -- "--workspace|launch_config_matches|opencode_base_url|orchestrator_daemon_url|engine-config|runtime/engine|OrchestratorLifecycleClient|lifecycleClient" packages/desktop/src-tauri/src packages/server/src
```

Mark done when:

- `vsa11_engine_config_hot_swap_done: true`.
- This task's `done: true`.

## VSA12: Port Conflict Policy

done: false

Partial implementation note 2026-07-06: desktop port resolution now returns a
typed `VesloPortConflict` for listener contention and preserves the existing
`Blocked(PortUnavailable)` behavior with a stable `port_conflict` message,
host, port, default-port flag, and `fallbackPolicy: "disabled"` in launch
diagnostics. This makes the current policy explicit and testable without
claiming the later ephemeral-port fallback. VSA12 remains `done: false` until
the desktop stops pre-building URLs from the requested port and publishes only
the READY/runtime-descriptor bound port.

Goal:

Handle 8787 contention by identity and explicit fallback, not by generic
blocked state or accidental foreign adoption. The first server-access slice may
stop at identity-safe rejection and clear `port_conflict` diagnostics; automatic
ephemeral fallback is a later policy decision.

Implementation:

- On default-port conflict:
  - probe `/health`;
  - adopt only if `instanceId` matches;
  - terminate only if identity/persisted PID safety checks prove it is our stale
    process;
  - otherwise choose an ephemeral port and publish it in the runtime descriptor.
- Ephemeral fallback must stop pre-building `baseUrl`, `connectUrl`, `lanUrl`,
  and `engineUrl` from a desktop-selected requested port. The desktop should
  pass a bind request, then publish URLs only from the port reported by READY
  or `runtime.json` after the server has bound.
- If port `0` or equivalent ephemeral bind is introduced, update
  `VESLO_DESKTOP_SERVER_PORT` validation so "requested ephemeral" is distinct
  from an invalid persisted/user configured port.
- Ensure invite/connect URLs read the actual descriptor port.
- Surface `Blocked(port_conflict)` only when fallback is disabled or fails, and
  include occupant details that are safe to expose.
- Add settings diagnostics for actual port, default port, conflict owner status,
  and fallback reason.
- Update tests and pilot scenarios that assumed a hard failure on port
  contention.

Acceptance:

- A foreign process on 8787 does not cause wrong-instance adoption.
- A foreign process on 8787 does not permanently prevent local mode when an
  ephemeral fallback is available.
- The published descriptor port is the actual bound server port, not the
  desktop's pre-bind guess.
- UI shows a concrete port-conflict reason when fallback cannot proceed.

Verification:

```powershell
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml veslo_server::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::veslo_server::tests --quiet
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/veslo-server-connection.test.ts
rg -n "PortUnavailable|port_conflict|resolve_veslo_port_after_restart|DEFAULT_VESLO_SERVER_PORT|VESLO_DESKTOP_SERVER_PORT|runtime.json|connect_url|lan_url|mdns_url" packages/desktop/src-tauri/src packages/app/src/app packages/server/src
```

Mark done when:

- `vsa12_port_conflict_policy_done: true`.
- This task's `done: true`.

## VSA13: E2E, Docs, And Release Gate

done: false

Goal:

Prove the full architecture in the installed desktop runtime and update durable
docs after behavior lands.

Implementation:

- Add or update Tauri-pilot scenarios:
  - fresh-profile cold boot reaches READY then first message works,
  - app restart with live previous server adopts by matching `instanceId`,
  - app restart with mismatched orphan terminates/replaces safely,
  - foreign 8787 occupant falls back to ephemeral port or shows
    `port_conflict`,
  - add workspace mid-session does not respawn server or rotate tokens,
  - engine daemon port change hot-swaps config without replacing server PID,
  - local 401 produces `auth_desync` and one managed recovery path.
- Update durable docs:
  - `docs/dev/opencode-workspace-runtime-architecture.md`,
  - `docs/dev/state-and-config-reference.md`,
  - `docs/dev/veslo-server-app-contract.md`,
  - testing playbook docs if pilot invocation changed.
- Add a short `docs/fixes/` note only after implementation is complete or a
  linked issue requires a checkpoint.
- Run final hygiene checks.

Acceptance:

- The previous chronic failure family is covered by installed-runtime or
  pilot-level validation, not only unit tests.
- Docs describe the new source of truth for descriptor, tokens, instance id,
  workspace ids, and remote-server settings.
- Top-level front matter is changed to `status: completed` and `done: true`
  only after VSA00 through VSA09, VSA10A through VSA10C, and VSA11 through
  VSA13 are true.

Verification:

```powershell
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml veslo_server::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::veslo_server::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::engine::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::workspace::tests --quiet
pnpm --filter veslo-server test
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/veslo-server-connection.test.ts src/app/tests/lib/veslo-server.test.ts
pnpm --filter @neatech/veslo-e2e test
git diff --check
git diff --cached --check
```

Mark done when:

- `vsa13_e2e_docs_and_release_gate_done: true`.
- Top-level `status: completed`.
- Top-level `done: true`.
- This task's `done: true`.
