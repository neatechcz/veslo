---
title: OpenCode Engine Starting State And MCP Cold Path KISS Plan
date: 2026-07-04
status: in_progress
done: false
issue: unlinked
source_audit: opencode-cold-start-codebase-verification-2026-07-04
depends_on:
  - docs/plans/2026-07-03-runtime-cold-start-session-handoff-kiss-plan.md
  - docs/plans/2026-07-03-opencode-directory-readiness-cross-os-kiss-plan.md
ocr00_baseline_done: true
ocr01_canonical_runtime_state_contract_done: true
ocr02_shared_engine_starting_snapshot_done: true
ocr03_readonly_proxy_starting_semantics_done: true
ocr04_tauri_engine_info_engine_state_done: true
ocr05_app_quiet_connect_starting_handling_done: true
ocr06_mcp_cold_path_boundary_done: true
ocr07_sandbox_topology_regression_done: true
ocr08_installed_runtime_regression_done: false
---

# OpenCode Engine Starting State And MCP Cold Path KISS Plan

## Goal

Make installed Veslo's OpenCode cold start deterministic and fast by fixing the
missing "engine is starting" state between app, Tauri, orchestrator, and
OpenCode in both sandboxed pooled mode and shared unsandboxed mode. Keep MCP and
external OpenCode plugins out of the default critical path unless a user
explicitly enables them.

The product rule is:

- `GET`/`HEAD` status probes must not spawn OpenCode.
- A status probe during an already-starting shared engine must not look the
  same as "no engine exists".
- A status probe during an already-starting pooled sandbox engine must not look
  the same as "no engine exists".
- First send should join or reuse one runtime start path.
- Browser MCP should be explicit/lazy, not part of normal engine startup.
- `--pure` remains a diagnostic mode, not the production fix.
- Shared-engine behavior must remain non-sandbox-only. Sandboxed runtimes keep
  per-workspace pooled engines.

## Codebase Verification Summary

This plan is based on direct code inspection and current tests, not only on
runtime logs.

OpenCode docs and CLI:

- `veslo-code serve --help` exposes `--pure`, and the help text says it runs
  without external plugins.
- `veslo-code mcp --help` supports MCP add/list/auth/logout/debug, but there is
  no `prune` command in this local CLI.
- Current OpenCode docs show MCP entries can be configured and disabled with
  config (`enabled: false`), but plugin loading is a startup/config load path.
  No official lazy plugin mechanism was found.

Local Veslo code:

- `packages/orchestrator/src/shared-opencode-engine.ts` keeps `pending` while
  `waitForHealthy` runs, but `this.engine` is assigned only after health passes.
  During startup, `snapshot()` reports `running: false` and cannot distinguish
  `absent` from `starting`.
- `packages/orchestrator/src/engine-pool.ts` already stores a per-workspace
  engine with `state: "spawning"` before `waitForHealthy` completes. That means
  sandboxed pooled mode has enough state to report `engine_starting`; the proxy
  simply does not use that state for `GET`/`HEAD` today.
- `packages/orchestrator/src/opencode-proxy-target.ts` intentionally does not
  spawn for `GET`/`HEAD`; in shared mode it only calls
  `sharedEngine.getRunning()`, and in pooled mode it only calls
  `pooledEngine.getRunning(workspaceId)`.
- `packages/orchestrator/src/cli.ts` returns `503 { error: "engine_not_running" }`
  when no proxy target engine exists. This is correct for `absent`, but too
  coarse for an already-pending shared start or pooled `spawning` engine.
- `packages/orchestrator/src/cli.ts` already returns `sharedEngine` in
  `/health`, but Rust `OrchestratorHealth` / `OrchestratorStatus` do not type
  or propagate it, so `engine_info(workspaceId)` cannot see shared-engine
  pending/ready state.
- `packages/orchestrator/src/engine-topology.ts` already enforces the critical
  topology rule: `shared-unsandboxed` requires both
  `VESLO_SHARED_OPENCODE_ENGINE=1` and `VESLO_DISABLE_SANDBOX=1`, and rejects
  active sandbox kinds such as `windows-wsl2`. An unsandboxed fallback does not
  auto-enable shared mode.
- `packages/desktop/src-tauri/src/commands/engine.rs` always returns an
  orchestrator proxy `baseUrl` for a workspace when the daemon is up. That is
  necessary for lazy `POST`, but it makes quiet `GET /global/health` hit a proxy
  that may only know `engine_not_running`.
- `packages/orchestrator/src/opencode-project-api.ts` and app-side workspace API
  readiness probes already split process health from workspace API readiness.
  This plan should reuse that split, not add a new hard provider/config gate.
- `packages/desktop/src-tauri/src/engine/spawn.rs` prepends sidecar paths for
  direct desktop OpenCode. When Tauri spawns the installed orchestrator daemon,
  verify that the daemon inherits an equivalent sidecar PATH before relying on a
  direct `chrome-devtools-mcp` command.
- `packages/app/src/app/constants.ts` quick-connect currently installs
  `npx -y chrome-devtools-mcp@latest --isolated`, which is acceptable only as
  an explicit user action, not as cold-start default config.

Verification already run before writing this plan:

```powershell
corepack pnpm@10.27.0 --filter veslo-orchestrator exec bun test src/tests/opencode-proxy-target.test.ts src/tests/shared-opencode-engine.test.ts src/tests/opencode-project-api.test.ts src/tests/router-proxy.test.ts
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec bun test src/app/tests/context/workspace-engine-warmup.test.ts src/app/tests/context/send-runtime-readiness.test.ts src/app/tests/app-send-latency-trace.test.ts src/app/tests/context/mcp-connection-workflow.test.ts
```

Observed result: orchestrator `36 pass, 0 fail`; UI `52 pass, 0 fail`.

## KISS Boundary

Core for this plan:

- Add a first-class shared engine `starting` state.
- Reuse the existing pooled engine `spawning` state as the sandboxed
  per-workspace `starting` signal.
- Preserve the existing "GET does not spawn" invariant.
- Return a distinguishable proxy response for pending shared startup.
- Return the same distinguishable proxy response for pending pooled startup.
- Propagate both shared and pooled starting state through Tauri `engine_info`.
- Let app quiet reconnect/recovery wait or retry when the engine is starting.
- Keep browser MCP out of normal startup and make explicit MCP activation
  bounded and predictable.

Not core for this plan:

- Rewriting OpenCode.
- Rewriting session flow ownership already covered by the RSH/CBF plans.
- Replacing the orchestrator.
- Adding `/provider` as a hard boot gate.
- Enabling `--pure` in production by default.
- Using `npx @latest` in any automatic cold-start path.
- Changing the desktop default for shared unsandboxed mode in this plan.
- Making shared mode available while an OS sandbox is active.

## Implementation Status Contract

Every task starts as `done: false`.

Only mark a task complete after the code, focused tests, and listed
verification for that task are complete. Do not mark top-level `done` complete until
OCR00 through OCR08 are all complete and verified.

If an implementation only completes part of a task, append a dated note under
that task and leave its `done: false` line unchanged.

## OCR00: Baseline And Issue Link

done: true

Goal:

Freeze the repro and decide whether this plan is a new VSLO issue or a child of
the existing installed cold-start incident.

Implementation:

- Link `issue:` in front matter if a real issue id exists.
- Record the latest failing/passing pilot evidence path.
- Keep the current trace handle from the audit:

```text
dev-specific/tauri-pilot/cold-start-audit-20260703-214734
```

- Note that the previous failure showed `connect-quiet:routing-error` with
  `engine_not_running` while engine start was pending or about to start.

Acceptance:

- The plan references the issue or explicitly states no issue was assigned.
- The plan has a dated baseline note with current branch/worktree status and
  pilot evidence.

Verification:

```powershell
git status --short --branch
rg -n "issue:|cold-start-audit-20260703-214734|OCR00" docs/plans/2026-07-04-opencode-shared-starting-state-and-mcp-cold-path-kiss-plan.md
```

Baseline note 2026-07-04:

- No separate issue id was assigned in this workspace; front matter remains
  `issue: unlinked`.
- Current branch status was checked with `git status --short --branch`:
  `main...origin/main`.
- Worktree was already dirty before this implementation slice, with many
  unrelated modified/untracked files present. This plan/file remains untracked.
- Pilot evidence handle remains:
  `dev-specific/tauri-pilot/cold-start-audit-20260703-214734`.
- The implementation target remains the observed pending-start symptom:
  `connect-quiet:routing-error` with `engine_not_running` while engine start
  was pending or about to start.

## OCR01: Define Canonical Runtime State Contract

done: true

Goal:

Standardize runtime/engine state names across orchestrator internals, proxy
responses, Tauri `engine_info`, app runtime ownership, workspace connection
state, UI copy, and traces.

Problem:

The same runtime fact is currently represented through several partial state
languages:

- orchestrator `EngineProcess.state`: `spawning`, `ready`, `idle`,
  `suspended`, `crashed`, and related pool state.
- shared engine snapshot: currently only `running: boolean` plus directories.
- proxy errors: currently `engine_not_running` for both absent and not-yet-ready
  cases.
- Tauri `EngineInfo`: currently mostly `running: boolean`, `baseUrl`, `pid`,
  and no canonical OpenCode engine state enum.
- app `WorkspaceConnectionStatus`: `idle`, `connecting`, `connected`, `error`.
- app workspace lifecycle events: `runtime-starting`, `connected`, `failed`.
- app `runtime-owner`: boolean readiness helpers such as
  `activeWorkspaceRuntimeReady()`.

This plan must not introduce another parallel vocabulary. It should add one
canonical runtime state contract and make each layer map to it.

Canonical public states:

```ts
type RuntimeEngineState =
  | "absent"
  | "starting"
  | "process_ready"
  | "workspace_api_waiting"
  | "ready"
  | "stopped"
  | "failed";
```

State meaning:

- `absent`: no target engine process exists and no start is pending.
- `starting`: process spawn or health wait is pending; request callers should
  retry/join, not start unrelated duplicate work.
- `process_ready`: OpenCode process health passed, but workspace/session API is
  not yet proven ready.
- `workspace_api_waiting`: process is reachable, but the bounded workspace API
  probe has not succeeded yet.
- `ready`: send/proxy/runtime reads may proceed according to existing read
  policy.
- `stopped`: intentionally suspended/stopped/disposed, not an error.
- `failed`: spawn, health, proxy, or runtime prerequisite failure.

Implementation:

- Add a small shared TypeScript owner for orchestrator-side public state
  mapping, for example `packages/orchestrator/src/runtime-engine-state.ts`.
  Keep it local to orchestrator if cross-package sharing would add build churn.
- Map internal orchestrator states into this contract:
  - missing engine and no pending start -> `absent`
  - pooled `state: "spawning"` -> `starting`
  - shared pending/spawning -> `starting`
  - `ready`/`idle` with process health -> `ready` or `process_ready` depending
    on whether the caller is reporting process health or workspace API
  - `suspended` -> `stopped`
  - `crashed`/permanent failure/spawn failure -> `failed`
- Use the same canonical state in:
  - orchestrator traces,
  - proxy JSON bodies,
  - `/health` snapshots,
  - Tauri `EngineInfo`,
  - app recovery classification,
  - workspace connection messages.
- Keep UI-specific `WorkspaceConnectionStatus` coarse if needed, but add a
  canonical runtime state field or mapped message so `connected` no longer has
  to mean both "process ready" and "workspace API waiting".
- Do not rename all internal states in one large refactor. KISS rule: keep
  existing internal states, add a mapping layer, and update public boundaries.

Focused tests:

- Add or update a small orchestrator unit test for the state mapper.
- Add source/behavior coverage that proxy `engine_starting`,
  `EngineInfo.engineState`, app recovery, and workspace connection message
  all use the canonical vocabulary.
- Existing runtime-owner and workspace-connection tests should continue to
  prove app behavior stays scoped per workspace.

Acceptance:

- There is one documented public runtime state vocabulary.
- `engine_not_running` is used only for `absent`/`stopped`, not `starting`.
- `engine_starting` maps to canonical `starting`.
- App-visible text and traces can distinguish `starting`,
  `process_ready/workspace_api_waiting`, `ready`, and `failed`.
- No layer invents a different synonym such as `booting`, `pending`,
  `connecting`, or `warming` as a public runtime state without mapping it back
  to the canonical contract.

Verification:

```powershell
pnpm --filter veslo-orchestrator exec bun test src/tests/runtime-engine-state.test.ts src/tests/opencode-proxy-target.test.ts src/tests/router-proxy.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/runtime-owner.test.ts src/app/tests/context/workspace-connection-state.test.ts src/app/tests/context/workspace-lifecycle-state.test.ts src/app/tests/context/send-runtime-readiness.test.ts
```

If `src/tests/runtime-engine-state.test.ts` is new, create it in the same slice
that adds the mapper.

Implementation note 2026-07-04:

- Added canonical `RuntimeEngineState` mapping in orchestrator and propagated
  public `engineState` through proxy bodies, Tauri `EngineInfo`, app recovery,
  and structured traces.
- Verified with:

```powershell
pnpm --filter veslo-orchestrator exec bun test src/tests/runtime-engine-state.test.ts src/tests/opencode-proxy-target.test.ts src/tests/router-proxy.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/runtime-owner.test.ts src/app/tests/context/workspace-connection-state.test.ts src/app/tests/context/workspace-lifecycle-state.test.ts src/app/tests/context/send-runtime-readiness.test.ts
pnpm --filter veslo-orchestrator typecheck
pnpm --filter @neatech/veslo-ui typecheck
```

## OCR02: Expose Shared Engine Starting Snapshot

done: true

Goal:

Make `SharedOpenCodeEngine` distinguish `absent`, `starting`, and `ready`
without making read-only probes spawn the engine.

Implementation:

- Extend `SharedOpenCodeEngineSnapshot` with backward-compatible fields:
  - `engineState: RuntimeEngineState`,
  - `pending: boolean`,
  - optional `state`, `baseUrl`, `pid`, `port`, and `startedAt` when a child is
    already spawned.
- If a local/internal snapshot status is still useful, keep it private to the
  owner and map internal `crashed` to public `engineState: "failed"`.
- Keep the existing `running: boolean` field for compatibility.
- Keep `getRunning()` semantics unchanged: it must return an engine only when
  the engine is usable for proxy forwarding.
- During `spawn()`, either assign the `EngineProcess` before `waitForHealthy`
  with `state: "spawning"` or store a separate pending snapshot. Prefer the
  smaller change that gives accurate `snapshot()` output without allowing proxy
  forwarding before health passes.
- Clear the starting state on spawn failure and dispose.

Focused tests:

- Add a deferred-health test in
  `packages/orchestrator/src/tests/shared-opencode-engine.test.ts` proving:
  - `ensureStarted()` is pending,
  - `snapshot()` reports starting/pending,
  - `getRunning()` is still `null`,
  - the final snapshot becomes ready after health resolves.
- Keep existing coalescing and failed-spawn tests passing.

Acceptance:

- `snapshot()` no longer collapses an in-flight shared start into `running:false`
  with no detail.
- No read-only caller receives a forwardable engine before health passes.

Verification:

```powershell
pnpm --filter veslo-orchestrator exec bun test src/tests/shared-opencode-engine.test.ts
```

Implementation note 2026-07-04:

- `SharedOpenCodeEngine.snapshot()` now reports `pending`, canonical
  `engineState`, and spawned child details while health is still pending.
- `getRunning()` remains unchanged and does not expose a forwardable engine
  before health passes.
- Verified with:

```powershell
pnpm --filter veslo-orchestrator exec bun test src/tests/shared-opencode-engine.test.ts
```

## OCR03: Add Read-Only Proxy Starting Semantics For Both Topologies

done: true

Goal:

Preserve "GET does not spawn" while making pending shared and pooled engine
starts visible to probes as `engine_starting`, not `engine_not_running`.

Implementation:

- Extend `SharedOpenCodeEngineLike` in
  `packages/orchestrator/src/opencode-proxy-target.ts` to expose the snapshot or
  a small `isStarting()` method.
- Extend `PooledOpenCodeEngine` to expose a no-spawn state lookup, or reuse a
  narrow existing `get(workspaceId)` equivalent if the type boundary allows it.
- Extend `OpenCodeProxyTarget` with a narrow canonical unavailable reason, for
  example:

```ts
unavailableReason?: "absent" | "starting";
```

- For shared `GET`/`HEAD`:
  - if `getRunning()` returns an engine, forward as today;
  - if no running engine but snapshot says starting/pending, return
    `unavailableReason: "starting"`;
  - if absent, keep today's no-spawn behavior.
- For pooled `GET`/`HEAD`:
  - if `getRunning(workspaceId)` returns an engine, forward as today;
  - if no running engine but the no-spawn state lookup says
    `state: "spawning"`, return `unavailableReason: "starting"`;
  - if absent or suspended/stopped, keep today's `engine_not_running`
    behavior;
  - if crashed or permanently failed, return a failure response with
    `engineState: "failed"`, not `engine_not_running`.
- In the orchestrator proxy route:
  - trace `orchestrator:proxy-engine-starting`,
  - return a retryable response such as
    `{ error: "engine_starting", engineState: "starting", workspaceId, retryAfterMs }`.
  - Keep `engine_not_running` only for truly absent/stopped state.
- Do not make read-only probes call `ensureStarted()` unless there is already a
  pending promise and the implementation intentionally joins it with a tiny
  bounded wait. The safer KISS default is immediate `engine_starting`.

Focused tests:

- Add shared pending coverage in
  `packages/orchestrator/src/tests/opencode-proxy-target.test.ts`.
- Add pooled spawning coverage in the same test file.
- Add router integration coverage in
  `packages/orchestrator/src/tests/router-proxy.test.ts`:
  - shared pending `GET /workspace/:id/opencode/global/health` returns
    `engine_starting`,
  - pooled spawning `GET /workspace/:id/opencode/global/health` returns
    `engine_starting`,
  - `ensureStarted` is not called by that GET,
  - `pool.ensure` is not called by that GET,
  - absent shared state still returns `engine_not_running`.
  - absent pooled state still returns `engine_not_running`.

Acceptance:

- Pending shared engine start is visible in traces and response body.
- Pending pooled engine start is visible in traces and response body.
- Existing GET/no-spawn invariant remains true.
- Existing POST lazy-start path remains unchanged.

Verification:

```powershell
pnpm --filter veslo-orchestrator exec bun test src/tests/opencode-proxy-target.test.ts src/tests/router-proxy.test.ts
```

Implementation note 2026-07-04:

- Read-only shared and pooled proxy target resolution now reports
  `engineState: "starting"` / `error: "engine_starting"` for in-flight starts
  without calling `ensureStarted()` or `pool.ensure()`.
- Failed/crashed internal states map publicly to `engineState: "failed"` rather
  than `engine_not_running`.
- Verified with:

```powershell
pnpm --filter veslo-orchestrator exec bun test src/tests/router-proxy.test.ts src/tests/opencode-proxy-target.test.ts src/tests/runtime-engine-state.test.ts src/tests/shared-opencode-engine.test.ts
pnpm --filter veslo-orchestrator typecheck
```

## OCR04: Propagate Engine Starting State Through Tauri Engine Info

done: true

Goal:

Make installed Tauri `engine_info(workspaceId)` able to report pooled and shared
engine starting/ready state from orchestrator `/health`.

Implementation:

- Add a Rust type for the orchestrator `sharedEngine` health field in:

```text
packages/desktop/src-tauri/src/types.rs
packages/desktop/src-tauri/src/orchestrator/mod.rs
```

- Keep fields optional/defaulted for backward compatibility.
- Add one optional OpenCode engine field to `EngineInfo`:
  - `engineState?: RuntimeEngineState`.
- Avoid `lifecycleStatus` here because Rust already has
  `VesloServerLifecycleStatus` for server lifecycle; this plan is about the
  target OpenCode engine state.
- In `engine_info(workspaceId)` shared/orchestrator branch:
  - keep returning the proxy `baseUrl` while daemon is up,
  - set `running=true` only when the target engine is actually ready/idle,
  - in pooled mode, derive `starting` from the matching
    `OrchestratorEngineSnapshot.state === "spawning"`,
  - in shared mode, derive `starting` from `sharedEngine.pending`,
    `sharedEngine.state === "spawning"`, or
    `sharedEngine.engineState === "starting"`,
  - expose `pid`/`port` from the matching pooled or shared engine when
    available.
- Do not remove the existing lazy proxy `baseUrl` behavior; POST send relies on
  it.

Focused tests:

- Add or extend Rust tests in `packages/desktop/src-tauri/src/commands/engine.rs`
  or a nearby module to prove pooled and shared `starting` maps into
  `EngineInfo`.
- Add a TypeScript type/source contract if app code consumes the new fields.

Acceptance:

- Tauri can distinguish:
  - daemon running but no engine,
  - pooled sandbox engine starting,
  - pooled sandbox engine ready,
  - shared unsandboxed engine starting,
  - shared unsandboxed engine ready.
- Existing direct and pooled engine info behavior is unchanged.

Verification:

```powershell
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml engine_info
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/send-runtime-readiness.test.ts src/app/tests/context/workspace-engine-warmup.test.ts
```

Implementation note 2026-07-04:

- Added Rust `RuntimeEngineState`, orchestrator `sharedEngine` health
  deserialization, and optional `engineState` on serialized `EngineInfo`.
- Workspace-scoped `engine_info` now derives starting/ready for pooled and
  shared orchestrator engines while preserving proxy `baseUrl` behavior.
- Verified with:

```powershell
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml engine_info
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/send-runtime-readiness.test.ts src/app/tests/context/workspace-engine-warmup.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

## OCR05: Handle Engine Starting In App Quiet Connect And Send Recovery

done: true

Goal:

Stop app quiet reconnect from treating a pending engine start as a terminal
`engine_not_running` routing failure in either topology.

Implementation:

- Teach `shouldRecoverLocalRuntimeFromHealthError()` to classify
  `engine_starting` / canonical `starting` as recoverable/waiting.
- In `packages/app/src/app/utils/local-runtime-lifecycle.ts`, when
  `EngineInfo` indicates orchestrator `starting`, poll scoped
  `engineInfo(workspaceId, workspacePath)` for a bounded window before calling
  `connectQuiet` against the proxy.
- Keep the existing fallback behavior for real absent/stopped engines.
- In `connectToEngineQuiet`, record a distinct trace event for
  `engine_starting` rather than only `connect-quiet:routing-error`, if the
  routed client returns that body.
- Update UI state through the canonical mapping: `WorkspaceConnectionStatus`
  may still display `connecting`, but traces and structured state should carry
  canonical `starting`.
- Preserve active-workspace-only UI state rules: a background workspace start
  must not flash an active error.

Focused tests:

- Extend `packages/app/src/app/tests/utils/local-runtime-lifecycle.test.ts`:
  - starting snapshot polls until running,
  - timeout still returns/reports false without hanging,
  - absent proxy URL behavior remains compatible.
- Extend `packages/app/src/app/tests/context/send-runtime-readiness.test.ts`:
  - `engine_starting` is recoverable and joins existing ensure path.
- Keep `workspace-engine-warmup` and `app-send-latency-trace` source contracts
  aligned.

Acceptance:

- No user-visible failure is produced just because shared engine startup is
  pending.
- No user-visible failure is produced just because sandboxed pooled engine
  startup is pending.
- First send can still recover if the pending start fails.
- No extra engine start owner is introduced.

Verification:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/utils/local-runtime-lifecycle.test.ts src/app/tests/context/send-runtime-readiness.test.ts src/app/tests/context/workspace-engine-warmup.test.ts src/app/tests/app-send-latency-trace.test.ts
```

Implementation note 2026-07-04:

- App health recovery now classifies `engine_starting` and canonical
  `engineState: "starting"` as recoverable.
- Orchestrator quiet reconnect polls scoped `engine_info` for a bounded window
  while `engineState` is `starting`, then proceeds through the existing connect
  path.
- Verified with:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/utils/local-runtime-lifecycle.test.ts src/app/tests/context/send-runtime-readiness.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-engine-warmup.test.ts src/app/tests/app-send-latency-trace.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

## OCR06: Keep MCP Out Of The Cold Path

done: true

Goal:

Make browser MCP explicit/lazy and ensure any explicit activation uses a
predictable command path.

Implementation:

- Do not add Control Chrome or other browser MCP entries to generated/default
  `opencode.jsonc` or the shared runtime config.
- Keep `MCP_QUICK_CONNECT` as an explicit user action.
- Avoid `npx @latest` in any automatic path. If Control Chrome should be fast
  in the desktop app, add a small resolver that prefers the bundled
  `chrome-devtools-mcp` sidecar command.
- Verify that the installed orchestrator daemon inherits the desktop sidecar
  PATH when the app expects direct `chrome-devtools-mcp` to work. Desktop direct
  spawn already prepends sidecar paths in
  `packages/desktop/src-tauri/src/engine/spawn.rs`; do not assume this is broken
  without installed-daemon evidence.
- If a workspace inherits a global MCP that should be disabled for cold-start
  testing, use OpenCode's supported config disable shape instead of deleting
  user-owned global config.
- Keep MCP runtime status refresh gated by existing app readiness and active
  send checks.

Focused tests:

- Extend `packages/app/src/app/tests/context/mcp-connection-workflow.test.ts`
  or related MCP contract tests for the explicit quick-connect command decision.
- Add a server/app config test if a bundled command resolver is introduced.
- Add a small CLI/manual verification script or documented command that runs
  `veslo-code mcp list` against a temp config with the explicit command.

Acceptance:

- Normal Veslo cold start has no browser MCP process startup requirement.
- Explicit Control Chrome activation is deterministic in installed desktop.
- `npx -y chrome-devtools-mcp@latest` is not used by any automatic cold path.
- MCP status refresh does not run during an active send or before runtime is
  ready.

Verification:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/mcp-connection-workflow.test.ts src/app/tests/app-send-latency-trace.test.ts
pnpm --filter veslo-server exec bun test src/tests/server.mcp-routes.test.ts src/tests/server.hub-mcp.test.ts
```

Implementation note 2026-07-04:

- No additional runtime code was needed in this slice: Control Chrome remains an
  explicit `MCP_QUICK_CONNECT` entry, not generated/default OpenCode config.
- Existing app gates keep automatic MCP status refresh behind runtime readiness
  and active-send checks; server MCP tests verify hub/workspace route config.
- Verified with:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/mcp-connection-workflow.test.ts src/app/tests/app-send-latency-trace.test.ts
pnpm --filter veslo-server exec bun test src/tests/server.mcp-routes.test.ts src/tests/server.hub-mcp.test.ts
```

## OCR07: Sandbox And Non-Sandbox Topology Regression

done: true

Goal:

Prove that the starting-state fix works in both supported engine topologies and
does not weaken sandbox boundaries.

Implementation:

- Keep `resolveEngineTopology()` as the source of truth:
  - default/bare orchestrator: `pooled-per-workspace`,
  - sandbox active: `pooled-per-workspace`,
  - shared requested without `VESLO_DISABLE_SANDBOX=1`: hard error,
  - shared requested with active sandbox kind: hard error,
  - shared requested with sandbox disabled and sandbox kind `none`:
    `shared-unsandboxed`.
- Do not infer shared mode merely because sandbox resolution fell back to
  unsandboxed. That remains pooled-per-workspace unless the user/runtime
  explicitly requests shared unsandboxed mode.
- Add regression coverage that `engine_starting` is reported without spawning
  for:
  - pooled sandbox/per-workspace `state: "spawning"`,
  - shared unsandboxed pending/spawning state.
- Keep WSL/path mapping tests unchanged; this plan must not route WSL sandboxed
  workspaces through the shared unsandboxed directory model.

Focused tests:

```powershell
pnpm --filter veslo-orchestrator exec bun test src/tests/engine-topology.test.ts src/tests/sandbox-mode.test.ts src/tests/engine-paths.test.ts src/tests/opencode-proxy-target.test.ts src/tests/router-proxy.test.ts
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml runtime_preferences
```

Acceptance:

- Shared mode is still impossible while an OS sandbox is active.
- Pooled sandbox mode can report `engine_starting` without becoming shared.
- Unsandboxed fallback alone does not auto-enable shared mode.
- WSL sandbox path mapping remains covered.
- Desktop runtime preference tests still prove explicit true/false env
  overrides for shared unsandboxed mode.

Implementation note 2026-07-04:

- Added pooled in-flight `engine_starting` regression coverage without changing
  sandbox topology resolution.
- Existing topology tests still prove shared mode requires explicit
  unsandboxed configuration and cannot run with an active WSL sandbox.
- Verified with:

```powershell
pnpm --filter veslo-orchestrator exec bun test src/tests/engine-topology.test.ts src/tests/sandbox-mode.test.ts src/tests/engine-paths.test.ts src/tests/opencode-proxy-target.test.ts src/tests/router-proxy.test.ts
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml runtime_preferences
```

## OCR08: Installed Runtime Regression Verification

done: false

Goal:

Prove the fix in the installed/Tauri runtime, not only in unit tests.

Required verification:

```powershell
pnpm --filter veslo-orchestrator exec bun test src/tests/shared-opencode-engine.test.ts src/tests/opencode-proxy-target.test.ts src/tests/router-proxy.test.ts src/tests/opencode-project-api.test.ts src/tests/engine-topology.test.ts src/tests/sandbox-mode.test.ts src/tests/engine-paths.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/utils/local-runtime-lifecycle.test.ts src/app/tests/context/send-runtime-readiness.test.ts src/app/tests/context/workspace-engine-warmup.test.ts src/app/tests/context/runtime-owner.test.ts src/app/tests/context/workspace-connection-state.test.ts src/app/tests/context/workspace-lifecycle-state.test.ts src/app/tests/app-send-latency-trace.test.ts src/app/tests/context/mcp-connection-workflow.test.ts
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml engine_info
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml runtime_preferences
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter veslo-orchestrator typecheck
pnpm --filter @neatech/veslo-e2e test:pilot -- --scenario runtime-cold-start-session-handoff
git diff --check
```

Pilot acceptance:

- No `connect-quiet:routing-error` with `engine_not_running` while
  a pooled or shared engine is starting.
- If a read-only probe arrives during startup, trace shows
  `proxy-engine-starting` or equivalent.
- Only one shared engine start is active for the workspace.
- In pooled mode, only one per-workspace engine start is active for the
  workspace.
- First send reaches the run path without duplicate cold-start fallback.
- Browser MCP is not started unless explicitly configured for the scenario.

Done when:

- All required verification is passing or any skipped command has a documented,
  concrete reason.
- This section has a dated verification note with exact command results.
- The OCR08 installed-runtime regression flag is marked complete.
- Top-level `done` is marked complete only after OCR00 through OCR08 are true.

## Final Fix Note

When complete, add a concise checkpoint in `docs/fixes` with:

- issue id,
- implemented OCR tasks,
- pilot trace path,
- exact test commands and results,
- any remaining MCP or OpenCode plugin follow-up intentionally left open.
