---
title: Local Runtime Invalid Bearer Recovery Plan
date: 2026-07-08
status: draft
done: false
issue: unlinked
source_audit: chat:2026-07-08-local-runtime-invalid-bearer-deep-audit
repo: veslo-main
lribr00_contract_snapshot_done: false
lribr01_fresh_runtime_recovery_done: false
lribr02_tests_done: false
lribr03_pilot_retry_check_done: false
lribr04_docs_alignment_done: false
---

# Local Runtime Invalid Bearer Recovery Plan

## Goal

done: false

Fix the local Veslo server / OpenCode runtime auth desync path causally, with
the smallest ownership-respecting change.

When an event stream reports local Veslo server `401 unauthorized` with
`Invalid bearer token`, Veslo must recover by refreshing the process boundary
that owns the OpenCode runtime token. A route-only reconnect or workspace
activate is not enough.

## Non-Goals

done: false

- Do not rewrite the send flow.
- Do not change provider auth semantics.
- Do not merge local Veslo server bearer auth with managed AI gateway runtime
  authorization.
- Do not rely on pilot retry text matching as the primary fix.
- Do not make normal browse attach more expensive.

## Current Audit Snapshot

done: false

The current dirty codebase already has a `forceFreshRuntime` wiring attempt:

- `packages/app/src/app/app.tsx`
  - `recoverWorkspaceRuntimeForEventStream(...)` calls
    `ensureEngineForWorkspace(..., { forceFreshRuntime: true })`.
- `packages/app/src/app/context/workspace-runtime-controller.ts`
  - passes `forceFreshRuntime` into `restartWorkspaceRuntime(...)`.
- `packages/app/src/app/utils/local-runtime-lifecycle.ts`
  - for orchestrator runtime, `forceFreshRuntime` calls
    `disposeOrchestratorWorkspace(...)`, then activates/reattaches the
    workspace.

This is directionally in the right owner, but it is not causally strong enough.

Why:

- `/instances/:id/dispose` explicitly skips disposal in
  `shared-unsandboxed` topology.
- Windows and macOS fresh desktop profiles default to shared unsandboxed
  OpenCode runtime.
- In pooled topology, disposing a workspace child still does not necessarily
  refresh the orchestrator daemon's captured Veslo server token.
- The existing docs note claims the fix uses `startHost(...)` / `engine_start`,
  but the current code path still uses `restartWorkspaceRuntime(...)`.

## Existing Contracts To Preserve

done: false

- Normal orchestrator browse attach should stay cheap:
  activate or reattach the workspace route.
- Direct runtime restart can keep the existing stop/start reconnect flow.
- Local Veslo server invalid bearer is detected by
  `isLocalVesloServerInvalidBearerError(...)`.
- Managed AI gateway runtime auth failures remain a separate class:
  `gateway_runtime_authorization_required` is not the same incident.
- `loadSessions: false` during event-stream recovery should stay, so recovery
  does not mutate session-list state while the active run is being reconciled.

## Causal Fix

done: false

For orchestrator runtime only, make local invalid-bearer event-stream recovery
use the existing fresh host start path instead of workspace dispose.

Target behavior:

- `event-stream-runtime-recovery` + `forceFreshRuntime: true`
  + `runtime === "veslo-orchestrator"` calls `startHost(...)`.
- `startHost(...)` calls desktop `engine_start`.
- `engine_start` stops/replaces the orchestrator daemon and starts it with the
  current Veslo server client token.
- If `startHost(...)` starts the daemon but route attachment is not ready yet,
  keep the existing orchestrator reattach fallback.
- Ordinary browse attach keeps using `restartWorkspaceRuntime(...)` with
  `browse-attach-orchestrator`.

Implementation shape:

1. In `workspace-runtime-controller.ts`, branch before
   `restartWorkspaceRuntime(...)`:
   - if `forceFreshRuntime && runtime === "veslo-orchestrator"`,
     call `startHostQuiet("runtime-recovery-fresh-start",
     "runtime-recovery-fresh-start-reattach")`.
   - else keep the current restart path.
2. Keep `forceFreshRuntime` in the API only if it remains useful for naming and
   tracing. It must not imply that `orchestrator_instance_dispose` is token
   fresh.
3. Consider removing `forceFreshRuntime` handling from
   `local-runtime-lifecycle.restartWorkspaceRuntime(...)` if no other caller
   needs it. The KISS default is fewer meanings.

## UI Error-Turn Policy

done: false

Do not block the causal fix on UI polishing.

Current behavior appends a visible assistant/error turn before recovery starts.
That explains why the pilot handshake can stop on the first message. After the
process recovery is fixed, decide separately whether successful recovery should:

- keep the visible error turn and require retry, or
- replace/suppress the transient local-runtime error when recovery succeeds.

KISS first slice: keep the current visible error and rely on the pilot retry
only as a verification helper. Do not auto-resend the user's prompt in this
slice.

## Tests

done: false

Update or add targeted tests before broad E2E:

1. App controller test:
   - orchestrator + `forceFreshRuntime: true` calls `startHost`, not
     `restartWorkspaceRuntime`.
   - normal orchestrator browse attach still calls `restartWorkspaceRuntime`.
   - direct runtime behavior is unchanged.
2. App lifecycle test:
   - remove or narrow the assertion that `forceFreshRuntime` means
     `disposeOrchestratorWorkspace`.
   - keep lifecycle tests focused on actual lifecycle helpers.
3. Orchestrator test:
   - document that HTTP `/instances/:id/dispose` in `shared-unsandboxed`
     topology does not dispose the shared engine.
   - this protects against future confusion where route dispose is treated as
     token-fresh recovery.
4. Session event stream test:
   - local invalid bearer still releases route and invokes recovery.
   - the recovery dependency receives the workspace id and does not load
     sessions.

## Verification

done: false

Run targeted app tests:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-runtime-controller-source.test.ts src/app/tests/utils/local-runtime-lifecycle.test.ts src/app/tests/context/session-event-stream.test.ts src/app/tests/lib/session-error.test.ts
```

Run targeted orchestrator tests:

```powershell
pnpm --filter veslo-orchestrator exec bun test src/tests/shared-opencode-engine.test.ts src/tests/router-proxy.test.ts
```

Then run the live pilot scenario that hit the incident:

```powershell
pnpm e2e:pilot --scenario packages/e2e/pilot-scenarios/live-skills-finder-roundtrip.toml
```

Expected evidence after the fix:

- invalid-bearer recovery trace enters a fresh-start path, not only
  dispose/activate,
- orchestrator daemon or OpenCode child ownership changes at the correct
  process boundary,
- follow-up prompt succeeds after recovery,
- no `gateway_runtime_authorization_required` trace is misclassified as local
  Veslo server bearer failure.

## Completion Criteria

done: false

- `event-stream-runtime-recovery` for orchestrator runtime uses `startHost` /
  `engine_start`.
- Existing cheap browse attach behavior is preserved.
- Tests prove the intended branch and the shared-dispose no-op contract.
- The misleading docs/fixes note is corrected or superseded.
- Targeted app and orchestrator tests pass.
- Pilot retry succeeds against a local runtime that previously produced the
  invalid-bearer handshake failure.

