# Fix 21: VSLO-235 Local Host Lifecycle Recovery

## Problem

The original VSLO-235 report described a desktop startup failure where the local
Veslo server briefly appeared to listen on `127.0.0.1:8787` and then vanished,
leaving the app in a generic "server unavailable" state.

The broad old proposal no longer matched the current app architecture exactly,
but the useful risk still existed: local host lifecycle failures could collapse
into generic unavailable UI state and lacked real Tauri coverage for:

- startup without a selected workspace,
- startup with a local workspace,
- fixed-port contention,
- Veslo server child exit after listen,
- explicit recovery after child exit.

## Fix

- Added additive local host lifecycle fields to `veslo_server_info`:
  - `lifecycleStatus`: `stopped`, `starting`, `running`, `exited`, `blocked`
  - `lifecycleReason`: `none`, `spawn_pending`, `port_unavailable`,
    `spawn_failed`, `child_exited`, `health_unreachable`, `token_missing`,
    `identity_mismatch`
- Preserved existing compatibility fields such as `running`, URL fields, tokens,
  `pid`, stdout, and stderr.
- Mapped fixed-port contention to `blocked/port_unavailable`.
- Mapped child process loss to `exited/child_exited`.
- Kept intentional stop as `stopped/none`, so a user/runtime stop is not
  confused with a crash.
- Added no-workspace E2E profile support in the Tauri-pilot launcher.
- Added a port-contention fixture that holds an isolated local E2E port and
  injects it through `E2E_VESLO_SERVER_PORT`.
- Added a debug+`e2e` gated native command,
  `veslo_server_e2e_kill_child`, to kill only the Veslo server child for
  desktop E2E. This command is not compiled into release behavior.
- Added Tauri-pilot scenarios for:
  - `vslo-235-local-host-no-workspace`
  - `vslo-235-local-host-with-workspace`
  - `vslo-235-local-host-port-contention`
  - `vslo-235-local-host-child-exit`
- Closed the product decision for this KISS slice: `engine_stop` intentionally
  means "stop local runtime", so it continues to stop orchestrator, OpenCode,
  Veslo local host, persisted host state, and OpenCode router.

## Plan

The implementation plan is closed in:

```text
docs/plans/2026-07-02-vslo-235-local-host-lifecycle-kiss-plan.md
```

Top-level `done`, Slice 1 status model, Slice 2 Tauri-pilot regression, and
Slice 3 `engine_stop` decision are all marked complete.

## Coverage

- Native manager tests cover `exited/child_exited`, intentional stop, and
  preserved blocked-port reasons.
- Native Veslo server command tests cover the status sanitization and lifecycle
  response shape.
- E2E runner tests cover the no-workspace profile selection and port-contention
  fixture selection.
- Tauri-pilot scenarios cover cold start without workspace, cold start with one
  workspace, structured blocked state for port contention, and child-exit
  recovery through `veslo_server_restart`.
- The E2E debug Tauri binary was rebuilt after adding the native E2E command.

## Verification

Run on 2026-07-03:

```powershell
cargo fmt --manifest-path packages/desktop/src-tauri/Cargo.toml
cargo check --manifest-path packages/desktop/src-tauri/Cargo.toml --features e2e --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml veslo_server::manager::tests --quiet
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml commands::veslo_server::tests --quiet
pnpm --filter @neatech/veslo exec tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e
pnpm --filter @neatech/veslo-e2e exec node --test --import=tsx/esm helpers/pilot-runner.test.ts
pnpm --filter @neatech/veslo-e2e exec node --import=tsx/esm ./helpers/pilot-runner.ts --scenario vslo-235-local-host-child-exit
pnpm --filter @neatech/veslo-e2e exec node --import=tsx/esm ./helpers/pilot-runner.ts --scenario vslo-235-local-host-no-workspace
pnpm --filter @neatech/veslo-e2e exec node --import=tsx/esm ./helpers/pilot-runner.ts --scenario vslo-235-local-host-with-workspace
pnpm --filter @neatech/veslo-e2e exec node --import=tsx/esm ./helpers/pilot-runner.ts --scenario vslo-235-local-host-port-contention
pnpm --filter @neatech/veslo-e2e exec tsc --noEmit
git diff --check -- packages/desktop/src-tauri/src/commands/veslo_server.rs packages/desktop/src-tauri/src/lib.rs packages/e2e/helpers/app-launcher.ts packages/e2e/helpers/pilot-runner.ts packages/e2e/helpers/pilot-runner.test.ts packages/e2e/pilot-scenarios/vslo-235-local-host-no-workspace.toml packages/e2e/pilot-scenarios/vslo-235-local-host-with-workspace.toml packages/e2e/pilot-scenarios/vslo-235-local-host-port-contention.toml packages/e2e/pilot-scenarios/vslo-235-local-host-child-exit.toml docs/plans/2026-07-02-vslo-235-local-host-lifecycle-kiss-plan.md packages/app/src/app/lib/tauri.ts packages/desktop/src-tauri/src/types.rs packages/desktop/src-tauri/src/veslo_server/manager.rs packages/desktop/src-tauri/src/veslo_server/mod.rs
```

Result:

- `cargo check --features e2e` passed; existing warnings only.
- Native lifecycle manager tests passed: `3 pass`, `0 fail`.
- Native Veslo server command tests passed: `18 pass`, `0 fail`.
- E2E debug Tauri build passed and rebuilt
  `packages/desktop/src-tauri/target/debug/veslo.exe`.
- E2E runner unit tests passed: `14 pass`, `0 fail`.
- `vslo-235-local-host-child-exit` passed: `6 passed`, `0 failed`.
- `vslo-235-local-host-no-workspace` passed: `2 passed`, `0 failed`.
- `vslo-235-local-host-with-workspace` passed: `2 passed`, `0 failed`.
- `vslo-235-local-host-port-contention` passed: `2 passed`, `0 failed`.
- E2E TypeScript check passed.
- Scoped `git diff --check` passed with only Windows LF-to-CRLF warnings.
- Post-E2E runtime process check found no lingering `veslo*`, `bun*`, or
  `tauri*` processes.

## Status

VSLO-235 is complete for this KISS lifecycle recovery checkpoint. The desktop
local host now has structured lifecycle reporting and real Tauri-pilot coverage
for the old startup failure modes that still matter in the current app.

## 2026-07-16 scenario correction

The first `Quality / Desktop recovery` CI run exposed a test-side defect: Tauri
Pilot 0.7.2 applies a fixed 10 s timeout to one `eval`, regardless of the
scenario step's `timeout_ms`. The old scenario polled for up to 8.5 s inside one
`eval`, so ordinary IPC overhead could turn a valid recovery into
`eval timed out after 10s`.

The current scenario starts each long probe asynchronously, waits for a DOM
completion/error marker, then performs a short assertion. It also follows the
actual app-owned runtime behavior: the kill command immediately exposes
`exited/child_exited`; the UI recovery path then replaces the child. The gate
requires a different PID, healthy `/health`, and a valid workspace `/status`.
It does not change the native command or production lifecycle behavior.

Two consecutive `pnpm check:desktop-recovery` runs passed with this contract,
each with a fresh isolated profile and launcher cleanup.
