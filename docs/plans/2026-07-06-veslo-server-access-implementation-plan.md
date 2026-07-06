---
title: Veslo Server Access Architecture Implementation Plan
date: 2026-07-06
status: completed
done: true
issue: unlinked
source_audit: docs/plans/2026-07-04-veslo-server-access-root-causes-and-architecture.md
vsa00_baseline_and_tracking_done: true
vsa01_persist_host_token_and_descriptor_done: true
vsa02_instance_identity_adoption_done: true
vsa03_cross_platform_orphan_cleanup_done: true
vsa04_secrets_files_not_argv_done: true
vsa05_ready_handshake_and_mutex_split_done: true
vsa06_serialized_desktop_state_machine_done: true
vsa07_frontend_single_descriptor_done: true
vsa08_single_auth_recovery_done: true
vsa09_acknowledged_workspace_registration_done: true
vsa10_server_owned_workspace_ids_done: true
vsa10a_workspace_id_golden_vectors_done: true
vsa10b_dual_id_mapping_migration_done: true
vsa10c_workspace_id_cutover_cleanup_done: true
vsa11_engine_config_hot_swap_done: false
vsa11_engine_config_hot_swap_deferred: true
vsa11a_respawn_and_blackbox_diagnostics_done: true
vsa12_port_conflict_policy_done: true
vsa13_e2e_docs_and_release_gate_done: false
vsa13_e2e_docs_and_release_gate_skipped: true
vsa13a_unit_contract_docs_gate_done: true
vsa13b_installed_runtime_smoke_done: false
vsa13b_installed_runtime_smoke_skipped: true
vsa13c_full_release_gate_done: true
vsa13_codebase_release_gate_done: true
vsa13c_full_release_gate_skipped_e2e: true
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
through VSA10C, VSA11A, VSA11 or its recorded deferral, VSA12, VSA13A, and the
codebase-only VSA13C gate are complete and verified. VSA13B is explicitly
skipped for this rollout and must not be used as acceptance evidence.

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

- VSA06/VSA07 are intentionally satisfied through the existing
  `VesloServerInfo`/lifecycle snapshot plus the `veslo://server-state` event
  bridge. Do not introduce a second parallel frontend state-machine model.
- VSA10B/VSA10C workspace identity migration.
- VSA11A respawn and blackbox diagnostics before any full VSA11 runtime-config
  API. The hot-swap API is conditional, not the default next refactor.
- VSA12 full port policy and ephemeral fallback.

VSA13 is split into per-slice gates: unit/contract/docs first, optional
installed-runtime smoke second, and the codebase-only release gate after the
roadmap is complete. For this rollout the installed-runtime/E2E gate is
explicitly skipped; evaluate completion against code, focused tests, contract
tests, source grep, and docs.

## Implementation Order

Use this order inside the rollout slices. Do not treat VSA00 through VSA13 as
one implementation batch.

1. VSA00 post-hoc ledger for the already-landed slice.
2. Keep VSA06/VSA07 closed around the existing descriptor event bridge unless a
   concrete bug proves the bridge insufficient.
3. Add VSA11A respawn and blackbox diagnostics using existing send/run trace
   infrastructure.
4. Decide whether full VSA11 hot-swap is still required from VSA11A evidence.
5. If required, implement the smallest runtime-config owner/API that updates the
   stale server dependencies proven by diagnostics.
6. Run VSA13A unit/contract/docs gate after each completed slice.
7. Skip VSA13B installed-runtime smoke for this rollout unless E2E acceptance
   is re-enabled.
8. Run VSA13C as a codebase-only release gate after VSA11 is completed or
   explicitly deferred with evidence.

VSA01 is not independently safe under the old token/PID adoption heuristic. It
may land in the same slice as VSA02, or it may persist `hostToken` earlier only
if restore/use of that host token is gated behind matching `instanceId`.

VSA03, VSA04, and the mutex part of VSA05 can be implemented by separate
agents if they coordinate on `VesloServerInfo` and persisted state schema
changes from VSA02.

## VSA00: Baseline And Tracking

done: true

Coordination note 2026-07-06: VSA00 was not completed before the first
implementation slice, so it was intentionally left `done: false` until a
post-hoc ledger could be recorded. Current branch when this note was added:
`local/sandbox-merge`, HEAD `5ef026f1`; this plan is tracked in git. Later
agents should treat this as baseline debt, not as a blocker for the already
verified VSA01-VSA05/VSA09 slice.

Completion ledger 2026-07-06: VSA00 is now closed as a post-hoc ledger, not as
pre-implementation evidence. Current branch is `local/sandbox-merge`, HEAD
`50110d03`, and this plan is tracked in git. Dirty/untracked worktree entries
seen while closing this ledger are outside the server-access slice:
`opencode.jsonc`, `packages/server/src/platform-managed-plugins.ts`, plugin
policy/materializer/route tests, `docs/dev/2026-07-06-app-server-flow-delay-blackbox-audit.md`,
and `docs/plans/2026-07-06-opencode-sdk-plugins-mcp-implementation-plan.md`.
Verified unit/contract coverage includes desktop server lifecycle/spawn,
desktop server/workspace commands, server workspace/health/conversation routes,
app connection/auth/runtime-readiness/SSE contracts, and orchestrator workspace
ID golden/mapping tests. Installed runtime/pilot smoke was not run in this
ledger pass; it remains explicitly tracked by VSA13B.

Goal:

Create a post-hoc verification ledger for the server-access work that already
landed before VSA00 was completed. This is baseline debt, not a reason to
reopen completed slices or invent new architecture.

Implementation:

- Link the real issue in front matter if one exists.
- Add a short dated note under this task with the current live checkout facts:
  - current branch and commit,
  - whether this plan is tracked,
  - dirty/untracked files relevant to this roadmap,
  - known current failing scenario names,
  - tests that passed for the already-landed VSA01-VSA10/VSA12 slices.
- Capture current process, auth, descriptor, and workspace-id behavior from:
  - `veslo_server::tests`,
  - `commands::veslo_server::tests`,
  - `packages/server/src/tests/workspaces.test.ts`,
  - `packages/app/src/app/tests/context/veslo-server-connection.test.ts`,
  - at least one pilot scenario that exercises local server startup if the
    pilot environment is healthy.
- Record any skipped pilot validation with the exact environment reason.
- Do not add new runtime behavior in VSA00. Missing coverage can be listed as
  follow-up test debt unless the absence blocks a later slice.

Acceptance:

- The plan contains a dated current-state ledger that later agents can trust.
- The ledger separates verified behavior, unverified/pilot-skipped behavior,
  and known dirty worktree state.
- No runtime behavior is changed by VSA00.

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

done: true

Implementation note 2026-07-06: desktop server start/restart ownership is now
serialized by `VesloServerManager::start_queue`, and all `start_veslo_server`
callers run through that queue. Compatible parallel start intents preserve the
live client token instead of treating a newly generated request token as a
respawn trigger. The desktop emits `veslo://server-state` on adoption, reuse,
starting, waiting-ready, blocked, and running transitions; the event payload
keeps the client token for the trusted local descriptor path but redacts
`hostToken`, stdout, and stderr. `veslo_server_info` remains the legacy
snapshot/read model for existing callers.

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
  - `Starting`,
  - `WaitingReady`,
  - `Running`,
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
  identity conflict, and blocked readiness/health.
- No event/log path leaks `hostToken` outside the in-memory trusted desktop
  renderer path.

Verification:

```powershell
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml veslo_server::manager::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::engine::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::veslo_server::tests --quiet
rg -n "veslo_server_restart|start_veslo_server|emit_all|VesloServerLifecycleStatus|Blocked|WaitingReady" packages/desktop/src-tauri/src packages/app/src/app
```

Mark done when:

- `vsa06_serialized_desktop_state_machine_done: true`.
- This task's `done: true`.

## VSA07: Frontend Single Descriptor

done: true

Partial implementation note 2026-07-06: the frontend connection flow no longer
derives a local Veslo URL from the OpenCode URL and no longer creates a
tokenless local fallback auth path. The `deriveLocalVesloServerUrlFromOpencodeBaseUrl`
helper and the active `localFallbackUrl` resolver contract were removed, and
managed-AI provider routing now uses only `activeVesloServerRoutingInfo()` for
local server base URL and tokens. The broader event-fed single descriptor store
was completed later in this task.

Partial implementation note 2026-07-06: `global-sdk.tsx` and `server.tsx` no
longer read `veslo.server.token` directly from localStorage. Remote OpenCode
proxy auth now goes through `resolveOpencodeProxyAuthHeaders`, which allows the
stored remote settings token for non-local `/opencode` proxy URLs but refuses
to apply that settings token to Tauri loopback `/opencode` URLs. The remote
settings token remains in localStorage for explicit remote-server mode; no
host token is stored there.

Implementation note 2026-07-06: `createVesloServerConnection` now seeds the
local descriptor from one `veslo_server_info` snapshot, then consumes
`veslo://server-state` Tauri events as the primary local descriptor feed. A
slow snapshot watchdog remains for lost events and child-exit detection. Event
payloads are merged with the existing in-memory descriptor so redacted events
do not erase the trusted `hostToken` or captured logs for the same
instance. Events without identity, or from a new instance on the same base URL,
never inherit the previous host token.

Goal:

Make the frontend consume the desktop-pushed local descriptor and stop guessing
local server URLs.

Implementation:

- First slice: remove the derived local URL fallback and tokenless local mode
  using the current trusted desktop snapshot.
- Add one app-side local server descriptor store fed by Tauri events from VSA06
  and seeded by one snapshot on startup.
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

done: true

Partial implementation note 2026-07-06: acknowledged local workspace
registration now persists the server-confirmed workspace id into the desktop
workspace row's `vesloWorkspaceId` field when the server response includes a
matching path. Desktop rename/delete server calls prefer this mapped id with a
fallback to the existing app-local id, and create-local reloads state after an
accepted registration so the returned workspace list includes the mapping.
The app's active local `vesloServerWorkspaceId` signal now uses only the
acknowledged `vesloWorkspaceId` mapping. It no longer publishes the app-local
workspace id as a server workspace id, so unmapped local workspaces fail closed
instead of silently routing server-bound calls through UI identity.

Partial implementation note 2026-07-06: `conversation-service` now has a
dual-id compatibility regression test proving that a local app workspace keeps
its app-local `workspaceId` in remembered conversation scopes while
server-bound conversation creation uses the mapped `vesloWorkspaceId` and does
not re-register a registry row that already matches the mapping.

Partial implementation note 2026-07-06: orchestrator now has a
`resolveWorkspaceRuntimeIdentity` mapping primitive and
`workspace-id-mapping.test.ts`. Desktop orchestrator registration payloads now
send both the app-local id and the mapped Veslo server id, and the orchestrator
stores app-local/path-derived ids as legacy aliases so activation, dispose, and
lookup by old ids can resolve to the same local workspace row. Conflicting
orchestrator run histories are not merged; they are traced and left for manual
inspection rather than silently rewriting active history.

Partial implementation note 2026-07-06: desktop workspace-state tests now cover
existing local rows with and without `vesloWorkspaceId` through the legacy
local-id remap path, proving app-local identity remaps do not drop a persisted
server-owned mapping and do not invent one when sync has not happened yet.
Orchestrator runtime config dirs now have a narrow dual-id migration helper:
when `opencode-config/<server-id>` is missing and a legacy alias config dir
exists, the alias dir is copied before workspace config synchronization. This
keeps the common app-id to server-id migration from splitting engine config
state.

Partial implementation note 2026-07-06: orchestrator run-store now has a
safe `migrateWorkspaceId` operation. During local `/workspaces` registration,
legacy alias run records move to the server-owned workspace id only when the
target workspace id has no existing run history; otherwise the migration is
skipped and traced. This preserves old run history for the common app-id to
server-id migration without merging conflicting histories.

Partial implementation note 2026-07-06: app-side workspace route builders now
have broader dual-id coverage. Automation and Soul workspace maps use explicit
`vesloWorkspaceId` mappings only after the connected server lists that id; they
do not infer server workspace ids from path or directory matches. Attachment
staging uses the same explicit-id validation and no longer chooses a server
workspace from path matching, `activeId`, or a singleton workspace list.
Existing app-local ids remain the UI identity.

Implementation note 2026-07-06: VSA10B is complete after the listed
verification passed. Final server-owned ID authority cutover,
`workspace_id_mismatch` cleanup, and any further downgrade/removal of legacy
fallback behavior remain scoped to VSA10C.

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
  server-acknowledged id cutover does not split active engine state from
  previous run history.
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
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::orchestrator::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::engine::tests --quiet
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/app-managed-ai-config-sync-contract.test.ts src/app/tests/app-veslo-server-state-stability.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/conversation-service.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/automation-workspace-map.test.ts src/app/tests/lib/soul-workspace-map.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-attachment-staging.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/send-runtime-readiness.test.ts src/app/tests/lib/veslo-server.test.ts
pnpm --filter veslo-server exec bun test src/tests/workspaces.test.ts
pnpm --filter veslo-orchestrator exec bun test src/tests/run-store.test.ts src/tests/workspace-id-golden.test.ts src/tests/workspace-id-mapping.test.ts src/tests/workspace-runtime-migration.test.ts
rg -n "veslo_workspace_id|workspace_id_mismatch|workspaceIdForPath|stable_workspace_id_for_veslo|workspaceIdForLocal|opencode-config|run-store|server workspace id" packages/desktop/src-tauri/src packages/app/src/app packages/server/src packages/orchestrator/src
```

Mark done when:

- `vsa10b_dual_id_mapping_migration_done: true`.
- This task's `done: true`.

## VSA10C: Server-Acknowledged ID Cutover And Mismatch Cleanup

done: true

Goal:

Complete the server-bound workspace-id migration and remove symptom-level
workspace-id mismatch recovery where it is no longer needed. Do this only after
VSA10B proves dual-id compatibility in app, server, and orchestrator.

Implementation:

- Make the veslo-server registration response the authority for server-bound
  local workspace ids after VSA09 and VSA10B are complete.
- Ensure all local-server API routes and frontend clients use
  server-acknowledged ids for server calls.
- Ensure orchestrator runtime identity uses the migrated server-acknowledged id
  or an explicit compatibility mapping for config dirs, engine pools, run
  lifecycle calls, and run-store lookups.
- Remove or downgrade `workspace_id_mismatch` recovery only after tests prove
  dual-id mapping covers the previous failure cases.
- Update docs that describe workspace id ownership and migration semantics.
- Set umbrella `vsa10_server_owned_workspace_ids_done: true` only after VSA10A,
  VSA10B, and VSA10C are true.

Implementation status:

- Normal frontend transport no longer synthesizes `workspace_id_mismatch` from
  orchestrator proxy `{"error":"workspace not found"}` responses. That path now
  reports `workspace_registry_unsynced`, matching the acknowledged-registration
  diagnostics from VSA09.
- The readiness recovery helper still accepts legacy `workspace_id_mismatch`
  strings as a backward-compatible input, but correctly registered local
  workspaces no longer depend on it as the normal recovery signal.
- VSA10A golden vectors and VSA10B dual-id mapping cover the desktop, app,
  server, and orchestrator compatibility paths before this cleanup.
- The current `/workspaces/local` server id remains deterministic from the
  resolved path. This task is therefore a server-acknowledged server-call
  authority cutover, not a new opaque id-generator cutover.
- The app no longer publishes local app workspace ids as Veslo server workspace
  ids. Local server-bound calls use an acknowledged `vesloWorkspaceId` mapping
  or fail closed with visible unsynced/unavailable state.
- Frontend automation, Soul, attachment staging, MCP, plugin, workspace share,
  and managed-AI paths no longer adopt a server workspace by path/directory
  match, `activeId`, or "first listed workspace" fallback.

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
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/conversation-service.test.ts src/app/tests/app-managed-ai-config-sync-contract.test.ts src/app/tests/context/extensions-plugin-policy.test.ts src/app/tests/context/mcp-connection-workflow.test.ts src/app/pages/scheduled-automations.test.ts src/app/tests/components/session/composer-docx-delegation.test.ts src/app/tests/components/session/composer-screenshot-staging-regression.test.ts src/app/tests/pages/scheduled-automation-store.test.ts src/app/tests/pages/session-attachment-staging.test.ts src/app/tests/pages/workspace-share-controller.test.ts src/app/tests/pages/soul-data-store.test.ts src/app/tests/lib/automation-workspace-map.test.ts src/app/tests/lib/soul-workspace-map.test.ts
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

## VSA11A: Respawn And Blackbox Diagnostics Gate

done: true

Implementation note 2026-07-06: desktop `start_veslo_server` now emits
bootstrap diagnostics for persisted adoption, idempotent reuse, accepted starts,
and respawns, including previous PID/instance, lifecycle status/reason, and
named non-secret config/status reasons. App SSE paths now record Rust proxy vs.
SDK fallback transport in send-workflow trace, and local runtime health visible
timeouts record that the underlying request may still be running. Server
conversation-run tests already cover the existing resolve-target,
lifecycle-active-peek/register, OpenCode submit, and provider-start trace events.
No runtime-config hot-swap API was added in this slice.

Goal:

Measure the remaining user-visible delay and respawn causes before building a
full runtime-config hot-swap API. This is the KISS guardrail for VSA11.

Implementation:

- Extend existing tracing instead of adding a new diagnostics subsystem:
  - `sendTraceStep` / `recordSendTrace` in app send flows,
  - `recordSendWorkflowTrace` in server OpenCode/run paths,
  - desktop launch diagnostics for `start_veslo_server`.
- Record why each local server start intent was accepted, coalesced, reused, or
  respawned:
  - caller/source,
  - previous PID and instance id,
  - lifecycle status/reason,
  - config field that forced respawn, if any.
- Add one high-signal desktop log/event when the app falls back to SDK SSE in
  Tauri instead of Rust `engineSseSubscribe`.
- Split the send critical path timing into existing trace events for:
  - workspace-active,
  - skill-resolution,
  - runtime-health and engine-info,
  - managed-ai-bootstrap,
  - conversation-create,
  - workspace attach/registry,
  - conversation-run.
- Split server `/runs` timing through existing run trace events for:
  - target resolution,
  - lifecycle active peek,
  - lifecycle register,
  - OpenCode submit,
  - provider-start watch,
  - response serialization.
- Make `withLocalRuntimeHealthTimeout` either abort the losing health request or
  emit enough trace to prove the underlying request continues after the visible
  timeout.
- Do not implement `POST /runtime/engine-config` in this slice.

Acceptance:

- A slow first send can be attributed to a named gate without reading raw
  stdout/stderr.
- A veslo-server respawn can be attributed to one config/status reason, or to an
  explicit user restart.
- Desktop SDK SSE fallback is visible as degraded transport, not silent normal
  behavior.
- VSA11 full hot-swap is either justified by captured evidence or explicitly
  deferred with the observed remaining respawn reasons.

Verification:

```powershell
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml veslo_server::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::engine::tests --quiet
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/send-runtime-readiness.test.ts src/app/tests/context/veslo-server-connection.test.ts
pnpm --filter veslo-server exec bun test src/tests/server-conversations.test.ts
rg -n "sendTraceStep|recordSendWorkflowTrace|engineSseSubscribe|event.subscribe|launch_config_matches|start_veslo_server|provider-start|lifecycle-register" packages/app/src/app packages/server/src packages/desktop/src-tauri/src
```

Mark done when:

- `vsa11a_respawn_and_blackbox_diagnostics_done: true`.
- This task's `done: true`.

## VSA11: Engine Config Hot Swap

done: false

Partial implementation note 2026-07-06: `launch_config_matches` no longer
treats workspace-list drift as a respawn trigger. After VSA09/VSA10, workspace
add/rename/delete registration is acknowledged through server APIs, so a
sidebar workspace-list change can reuse the existing veslo-server process
without rotating tokens or dropping streams. VSA11 remains `done: false`
because dynamic OpenCode/orchestrator URL and lifecycle-token hot-swap still
require a real runtime-config owner/API.

Deferral note 2026-07-06: VSA11A diagnostics are now the guardrail for this
full hot-swap project. Targeted installed-runtime smoke for server startup,
matching-instance relaunch adoption, and port-contention fallback did not show
a remaining server-access respawn blocker that justifies adding
`POST /runtime/engine-config` in this slice. Keep
`vsa11_engine_config_hot_swap_done: false` because no hot-swap API shipped, but
`vsa11_engine_config_hot_swap_deferred: true` records the current rollout
decision. Reopen VSA11 only if launch diagnostics show a user-visible
`start-respawn` caused by `opencode_base_url`, `orchestrator_daemon_url`, or
`orchestrator_lifecycle_token`.

Goal:

Decouple server lifetime from workspace list, active workspace, and dynamic
orchestrator daemon URL only if VSA11A proves this is still a material source of
respawns or user-visible delay. Treat this as a runtime hot-swap project, not as
part of the first server-access recovery slice.

Implementation:

- Do not start this full API slice until VSA11A is complete or an active
  incident proves the specific hot-swap gap.
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

- `vsa11a_respawn_and_blackbox_diagnostics_done: true`, or the VSA11A evidence
  is explicitly recorded as not required for an incident-driven hot-swap fix.
- `vsa11_engine_config_hot_swap_done: true`.
- This task's `done: true`.

## VSA12: Port Conflict Policy

done: true

Implementation note 2026-07-06: desktop port resolution now treats the default
8787 listener as an identity-safe preferred port, not a hard dependency. If the
default port remains occupied after restart grace, the desktop spawns
veslo-server with `--port 0`, records `port-conflict-fallback` diagnostics, and
publishes `baseUrl`, `connectUrl`, `lanUrl`, and `engineUrl` from the actual
port reported by the READY/runtime descriptor. Explicit
`VESLO_DESKTOP_SERVER_PORT` values still fail closed on contention, while
`VESLO_DESKTOP_SERVER_PORT=0` is accepted as an explicit ephemeral bind request.

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

## VSA13A: Unit, Contract, And Docs Gate

done: true

Implementation note 2026-07-06: focused unit and source-contract gates passed
for the implemented server-access architecture. The current source of truth is
documented in this plan's implementation notes for descriptor ownership, token
persistence/redaction, instance-ID adoption, workspace ID ownership/migration,
remote settings credentials, VSA11A diagnostics, and the explicit VSA11
hot-swap deferral. Installed-runtime validation remains outside this gate and
is still tracked by VSA13B.

Goal:

Close the current implemented server-access contract with cheap, repeatable
tests and durable docs before waiting on installed-runtime pilot coverage.

Implementation:

- Run the focused desktop, app, server, and orchestrator tests that cover the
  completed VSA01-VSA10/VSA12 behavior.
- Update durable docs for the implemented contract only:
  - descriptor ownership,
  - token persistence and redaction,
  - instance-id adoption,
  - workspace id ownership/mapping,
  - remote-server settings vs local descriptor credentials.
- Record any VSA11 full hot-swap deferral from VSA11A evidence.
- Keep pilot-only scenarios out of this gate unless the pilot environment is
  already healthy.

Acceptance:

- Docs describe the current shipped source of truth without promising unbuilt
  VSA11 hot-swap behavior.
- Unit and contract tests pass for the current architecture.
- Known skipped pilot/runtime validation is called out separately instead of
  blocking this gate.

Verification:

```powershell
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml veslo_server::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::veslo_server::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::workspace::tests --quiet
pnpm --filter veslo-server exec bun test src/tests/workspaces.test.ts src/tests/server.health-status-routes.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/veslo-server-connection.test.ts src/app/tests/lib/veslo-server.test.ts
pnpm --filter veslo-orchestrator exec bun test src/tests/workspace-id-golden.test.ts src/tests/workspace-id-mapping.test.ts
git diff --check
```

Mark done when:

- `vsa13a_unit_contract_docs_gate_done: true`.
- This task's `done: true`.

## VSA13B: Installed Runtime Smoke Gate

done: false

Skipped verification note 2026-07-06: this gate is deliberately excluded from
completion acceptance for this rollout. Keep the captured attempts below as
diagnostic context only; evaluate the plan against codebase evidence instead.

- `pnpm --filter @neatech/veslo-e2e test` did not pass the current gate:
  `smoke.toml` passed, but `navigation.toml` failed at `settings route active`
  because the app stayed at `http://tauri.localhost/#/onboarding` instead of
  `/dashboard/settings`.
- `pnpm --filter @neatech/veslo-e2e test:pilot -- --scenario veslo-server-startup`
  passed and proved `veslo_server_info` reports `running`, `baseUrl`, and
  `clientToken` in an isolated app profile.
- `pnpm --filter @neatech/veslo-e2e test:pilot -- --scenario vslo-270-relaunch-reconnect`
  passed and proved local host reconnect after relaunch.
- `pnpm --filter @neatech/veslo-e2e test:pilot -- --scenario vslo-235-local-host-port-contention`
  passed and proved explicit port contention reports the structured
  `port_unavailable` blocked state.
- `pnpm --filter @neatech/veslo-e2e test:pilot -- --scenario runtime-cold-start-session-handoff`
  failed with `Boot warmup did not complete before send`; the workflow trace
  reached repeated `ensure-engine:skills-ready` entries with
  `skillsReady: false`, after descriptor-provided local server URL and managed
  gateway routing were already visible.

Goal:

Validate the implemented local-server contract in an installed or pilot desktop
runtime without expanding scope to every final release scenario.

Implementation:

- Run or add the smallest healthy pilot/runtime smoke for:
  - fresh-profile cold boot reaches READY,
  - first message works against the descriptor-provided local server,
  - app restart adopts a matching live server by `instanceId`,
  - foreign 8787 occupant falls back to an actual descriptor port or reports a
    concrete `port_conflict`.
- If the pilot environment is unhealthy or the owner decides to evaluate
  codebase-only, record `vsa13b_installed_runtime_smoke_skipped: true` and keep
  this gate `done: false`.

Acceptance:

- This gate is optional for this rollout.
- Failures are reported as pilot/runtime diagnostics, not folded into code
  correctness unless code evidence points there.

Verification:

```powershell
git diff --check
```

Mark done when:

- `vsa13b_installed_runtime_smoke_done: true`, only if E2E acceptance is
  re-enabled.
- Otherwise keep this task's `done: false` and
  `vsa13b_installed_runtime_smoke_skipped: true`.

## VSA13C: Full Release Gate

done: true

Codebase-only note 2026-07-06: E2E/pilot validation is skipped for this
rollout. Close this gate from focused desktop/app/server/orchestrator tests,
source-contract grep, docs state, and git hygiene only.

Completion note 2026-07-06: codebase-only verification passed:

- `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml veslo_server::tests --quiet`
  passed 52/52.
- `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::veslo_server::tests --quiet`
  passed 18/18.
- `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::engine::tests --quiet`
  passed 10/10.
- `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::workspace::tests --quiet`
  passed 14/14.
- `pnpm --filter veslo-server test` passed 899 tests with 13 skipped and 0
  failures.
- `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/veslo-server-connection.test.ts src/app/tests/lib/veslo-server.test.ts`
  passed 68/68.
- `pnpm --filter veslo-orchestrator exec bun test src/tests/workspace-id-golden.test.ts src/tests/workspace-id-mapping.test.ts src/tests/workspace-runtime-migration.test.ts src/tests/run-store.test.ts`
  passed 15/15.
- `git diff --check` and `git diff --cached --check` completed without
  whitespace errors; Git reported only LF/CRLF working-copy warnings.

Goal:

Run the codebase-only release-level validation after VSA11 is complete or
explicitly deferred from VSA11A evidence.

Implementation:

- Include VSA13A results and the explicit VSA13B skip decision.
- Add hot-swap-specific runtime scenarios only if VSA11 was implemented.
- If VSA11 was deferred, document the evidence and remaining trigger that would
  reopen it.
- Run final hygiene checks and add a concise `docs/fixes/` checkpoint if the
  linked issue or release process requires it.

Acceptance:

- The roadmap can be marked complete without mixing implemented behavior,
  deferred behavior, and skipped pilot diagnostics.
- The final plan status reflects whether VSA11 shipped or was deliberately
  deferred with evidence.

Verification:

```powershell
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml veslo_server::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::veslo_server::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::engine::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::workspace::tests --quiet
pnpm --filter veslo-server test
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/veslo-server-connection.test.ts src/app/tests/lib/veslo-server.test.ts
git diff --check
git diff --cached --check
```

Mark done when:

- `vsa13a_unit_contract_docs_gate_done: true`.
- `vsa13b_installed_runtime_smoke_skipped: true`, unless E2E acceptance is
  re-enabled.
- `vsa13c_full_release_gate_done: true`.
- `vsa13_codebase_release_gate_done: true`.
- `vsa13_e2e_docs_and_release_gate_skipped: true`, unless E2E acceptance is
  re-enabled and completed in a separate installed-runtime gate.
- This task's `done: true`.

## VSA13: E2E, Docs, And Release Gate

done: true

Status note 2026-07-06: VSA13A is complete, VSA11 full hot-swap is explicitly
deferred from VSA11A evidence, and VSA13B installed-runtime/E2E validation is
skipped for this rollout. VSA13C codebase-only verification passed, so the
roadmap is complete without claiming installed-runtime validation.

Goal:

Umbrella task for VSA13A through VSA13C. Prove the implemented architecture in
the right validation layer without making unit/docs progress depend on the full
installed-runtime release gate.

Implementation:

- Complete VSA13A before treating docs and contract coverage as current.
- Skip VSA13B unless E2E acceptance is re-enabled; do not claim
  installed-runtime validation when it is skipped.
- Complete VSA13C codebase-only verification before marking the roadmap
  complete.
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

- The previous chronic failure family is covered by codebase-level unit,
  contract, source-grep, and documentation evidence.
- Docs describe the new source of truth for descriptor, tokens, instance id,
  workspace ids, and remote-server settings.
- Top-level front matter is changed to `status: completed` and `done: true`
  only after VSA00 through VSA09, VSA10A through VSA10C, VSA11 or its recorded
  deferral, VSA12, VSA13A, VSA13B skip, and VSA13C codebase-only verification
  are true.

Verification:

```powershell
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml veslo_server::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::veslo_server::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::engine::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::workspace::tests --quiet
pnpm --filter veslo-server test
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/veslo-server-connection.test.ts src/app/tests/lib/veslo-server.test.ts
git diff --check
git diff --cached --check
```

Mark done when:

- `vsa13a_unit_contract_docs_gate_done: true`.
- `vsa13b_installed_runtime_smoke_skipped: true`, unless E2E acceptance is
  re-enabled.
- `vsa13c_full_release_gate_done: true`.
- `vsa13_codebase_release_gate_done: true`.
- `vsa13_e2e_docs_and_release_gate_skipped: true`, unless E2E acceptance is
  re-enabled and completed in a separate installed-runtime gate.
- Top-level `status: completed`.
- Top-level `done: true`.
- This task's `done: true`.
