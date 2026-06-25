# Fix 06: VSLO-250 Non-Sandbox Runtime Fallback

## Problem

On Windows, Veslo can be configured to use the WSL2 sandbox as the preferred
OpenCode runtime backend. That is the right secure default, but startup and
first-send behavior must still work on machines where the Veslo WSL
prerequisites are not installed, not repaired yet, or not launchable.

The broken behavior was that different app layers treated "configured sandbox"
as if it were the same thing as "effective runtime." When the server capability
said `windows-wsl2`, the app could still assume a WSL bridge URL was required
even after the orchestrator had fallen back to a direct non-sandbox engine. This
made the first local workspace flow fragile:

- onboarding could show WSL repair state, but the rest of startup still needed
  to continue;
- managed AI routing could block because no WSL bridge URL existed;
- directory/path routing could use the configured backend instead of the actual
  engine backend;
- debug output did not clearly show whether the app was running in configured
  WSL mode, actual WSL mode, or direct fallback mode;
- multi-workspace direct fallback had to remain per-workspace and must not turn
  into shared unsandboxed mode implicitly.

In short: the system needed to distinguish desired sandbox configuration from
the runtime that actually started.

## Root Cause

The runtime model had several partial truths:

- `/capabilities.sandbox` represented configured capability, not the live
  engine state.
- Orchestrator engine snapshots did not carry enough sandbox metadata for app
  and desktop layers to reason about the actual child process.
- App pre-send logic mixed runtime preparation, managed AI checks, directory
  path mode, and bridge requirements across multiple call sites.
- A direct fallback engine and an explicitly shared non-sandbox engine were both
  "not WSL" from some callers' perspective, but they have different semantics.

That made it too easy for a caller to see `windows-wsl2` in configured
capabilities and require WSL even after the orchestrator had correctly launched
a direct fallback engine.

## Fix

The fix keeps the architecture simple: configured sandbox remains a configured
capability, while the effective runtime is derived from the engine that actually
exists.

- The orchestrator now records and reports runtime sandbox audit fields:
  `sandboxed`, `configuredSandboxBackend`, `effectiveSandboxBackend`,
  `sandboxMode`, `sandboxFallbackReason`, and `childKind`.
- WSL resolver failures and WSL launch failures are classified separately:
  `sandbox unavailable` vs `sandbox launch unavailable`.
- Direct fallback is reported as `childKind=direct`,
  `configuredSandboxBackend=windows-wsl2`,
  `effectiveSandboxBackend=none`, and `sandboxMode=launch-fallback`.
- WSL runtime remains `childKind=wsl` with an effective WSL backend.
- Explicit shared non-sandbox mode remains opt-in only. Direct fallback does not
  auto-enable shared multi-workspace mode.
- Engine pool snapshots preserve the new metadata so health/status consumers can
  inspect the actual runtime.
- Desktop Rust types preserve the same optional fields through Tauri IPC.
- App TS types include the new optional runtime fields.
- The app uses the existing runtime preflight path as the owner instead of
  adding a second controller. Pre-send now prepares the target runtime first,
  resolves effective sandbox state, then runs managed AI bootstrap/routing.
- Managed AI bridge requirements use effective runtime state, not raw configured
  capabilities alone.
- Directory query path mode also uses effective runtime state.
- Settings/devtools now exposes a Runtime sandbox panel with configured backend,
  configured enabled state, effective backend, sandboxed state, engine child,
  child source, directory mode, bridge requirement, and fallback status.
- Runtime trace/debug reports now expose configured and effective sandbox
  information so this class of issue is visible without guessing.

## Effective Runtime Rules

- `childKind=wsl` means effective backend is `windows-wsl2`.
- `childKind=direct` means effective backend is `none`, even when the configured
  backend is `windows-wsl2`.
- Missing `childKind` is unknown/configured state. It is not proof that a WSL
  runtime is already available.
- Direct fallback is a per-workspace local runtime fallback.
- Shared unsandboxed runtime still requires explicit shared-engine configuration.

## Files

- `packages/orchestrator/src/cli.ts`
- `packages/orchestrator/src/engine-pool.ts`
- `packages/orchestrator/src/sandbox-mode.ts`
- `packages/orchestrator/src/tests/local-opencode-url.test.ts`
- `packages/orchestrator/src/tests/sandbox-mode.test.ts`
- `packages/app/src/app/app.tsx`
- `packages/app/src/app/context/send-runtime-readiness.ts`
- `packages/app/src/app/lib/runtime-sandbox-state.ts`
- `packages/app/src/app/lib/ai-access.ts`
- `packages/app/src/app/lib/tauri.ts`
- `packages/app/src/app/pages/settings.tsx`
- `packages/app/src/app/tests/lib/runtime-sandbox-state.test.ts`
- `packages/app/src/app/tests/app-send-preflight-context.test.ts`
- `packages/app/src/app/tests/app-managed-ai-bootstrap-gate.test.ts`
- `packages/app/src/app/tests/pages/settings-runtime-sandbox.test.ts`
- `packages/desktop/src-tauri/src/types.rs`
- `packages/e2e/package.json`
- `packages/e2e/helpers/pilot-integration.test.ts`
- `packages/e2e/specs/wsl-direct-fallback.pilot.ts`
- `docs/dev/non-sandbox-runtime-preflight-plan.md`
- `docs/dev/opencode-workspace-runtime-architecture.md`
- `docs/dev/opencode-shared-non-sandbox-runtime.md`
- `docs/dev/state-and-config-reference.md`

## Verification

```powershell
cd packages/orchestrator
bun test src/tests/sandbox-mode.test.ts src/tests/local-opencode-url.test.ts src/tests/engine-pool.test.ts

cd ../..
pnpm --filter veslo-orchestrator typecheck

cd packages/app
pnpm run typecheck
pnpm exec node --test --import=tsx/esm src/app/tests/pages/settings-runtime-sandbox.test.ts

cd ../..
pnpm --filter @neatech/veslo-e2e exec tsc --noEmit --pretty false
pnpm --filter @neatech/veslo-e2e exec node --test --import=tsx/esm helpers/pilot-runner.test.ts helpers/pilot-integration.test.ts

cd packages/desktop/src-tauri
cargo check --features e2e
cargo test --features e2e orchestrator_engine_snapshot -- --nocapture

cd ../../..
pnpm --filter @neatech/veslo-e2e test:pilot:wsl-direct-fallback
```

Result: targeted orchestrator tests passed, orchestrator typecheck passed, app
typecheck passed, Settings runtime sandbox test passed, e2e TypeScript and pilot
integration tests passed, desktop Rust check and serde test passed, and the
Windows Tauri fallback probe passed.

The fallback probe starts the Tauri app with an isolated e2e profile and a
missing WSL executable override, waits for the local workspace to register,
triggers the first workspace engine request, and verifies these runtime trace
signals:

```json
{
  "sandboxKind": "windows-wsl2",
  "sandboxMode": "launch-fallback",
  "configuredSandboxBackend": "windows-wsl2",
  "effectiveSandboxBackend": "none",
  "sandboxFallbackReason": "sandbox launch unavailable",
  "childKind": "direct"
}
```

The probe also shuts down the orchestrator daemon and cleans Veslo sidecars tied
to the isolated e2e profile.

## Build Note

One full `pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e`
attempt reached the Vite build and then failed in a Windows/libuv assertion:
`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c,
line 94`.

To finish the runtime validation, the current sidecars were rebuilt/prepared,
copied into the desktop debug target, `cargo build --features e2e` was run for
the Tauri binary, and the actual application behavior was verified through the
fallback pilot probe.

## Follow-Up Guardrails

- Do not redefine `/capabilities.sandbox` as live runtime state without an
  explicit API migration.
- Keep direct fallback per-workspace unless shared unsandboxed mode is
  explicitly requested.
- Keep managed AI bridge checks dependent on effective runtime state.
- Keep Settings/debug output showing both configured and effective sandbox
  state; hiding either side makes this failure mode hard to diagnose.
