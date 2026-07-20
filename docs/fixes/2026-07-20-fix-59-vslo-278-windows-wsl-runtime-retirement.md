# Fix 59 / VSLO-278: Windows WSL Runtime Retirement

Date: 2026-07-20

## Scope

This checkpoint hardens the Windows desktop runtime against a legacy persisted
`sharedUnsandboxedEngine: false` preference. It covers the desktop preference
owner and the orchestrator sandbox resolver. It does not remove the remaining
WSL repair source files or their native IPC commands.

## Problem

The Windows installer had already stopped shipping WSL provisioning files and
the UI no longer rendered the repair component. However, an upgrade profile
could still contain:

```json
{ "sharedUnsandboxedEngine": false }
```

Before this change, that value emitted `VESLO_DISABLE_SANDBOX=0` and
`VESLO_SHARED_OPENCODE_ENGINE=0`. The Windows orchestrator resolver could then
select `windows-wsl2` even though there was no longer any user-facing repair
or provisioning contract.

## Fix

- On Windows, `runtime_preferences` now resolves every persisted engine choice
  to shared, unsandboxed mode and normalizes writes to `true`.
- The desktop child environment therefore always receives
  `VESLO_DISABLE_SANDBOX=1` and `VESLO_SHARED_OPENCODE_ENGINE=1` on Windows.
- The orchestrator now rejects automatic Windows WSL2 backend selection. Its
  only remaining use is an explicit developer diagnostic opt-in through
  `VESLO_ENABLE_LEGACY_WINDOWS_WSL_SANDBOX=1`.
- Added a focused orchestrator sandbox-policy test and included it in
  `check:unit`.

## KISS Boundary

No new configuration owner, migration service, installer action, or UI setting
was added. The existing desktop preference owner is the one place that can
translate the legacy persisted value; the resolver is an independent final
fail-closed barrier for direct orchestrator usage.

The old WSL repair module, its registered Tauri commands, and source helper
scripts remain a separate cleanup task. They are not reachable through current
Settings or onboarding UI, but direct trusted IPC callers could still invoke
them.

## Verification

```powershell
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml runtime_preferences::tests --all-features --locked
# passed: 8 tests

pnpm --filter veslo-orchestrator test:sandbox-policy
# passed: 2 tests

pnpm --filter veslo-orchestrator typecheck
# passed

pnpm --filter veslo-orchestrator test:router
# passed

node --test packages/app/src/app/tests/pages/settings-runtime-preferences.test.ts
# passed: 3 tests; Settings has no user-facing sandbox toggle

pnpm release:review
# passed: Windows release configuration excludes WSL payload and setup hooks
```

The public Windows MSI `2026.7.12` was also extracted with
`scripts/release/verify-windows-msi-runtime.ps1`: 271 files, no WSL sandbox
payload and no WSL/VesloSandbox custom action. The locally installed
`2026.6.26` app is older and still physically contains the historic WSL setup
scripts.

## Status

Source-level runtime retirement is implemented and verified. It is not yet in
the published `2026.7.12` desktop binary: that release still honors a persisted
`sharedUnsandboxedEngine: false`. A new desktop release and installed-app
upgrade are required to make the fail-closed runtime behavior production
effective. No Den or server deployment is required for this change.
