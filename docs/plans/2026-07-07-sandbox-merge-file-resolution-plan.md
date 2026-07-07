# Sandbox Merge File Resolution Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Merge `origin/local/sandbox-merge` into local `dev_vaclav` while preserving the local Skill Registry capability work and accepting Sandbox Merge as the base for the newer server/runtime architecture.

**Architecture:** Sandbox Merge is the authoritative base for server-owned conversation submit, runtime readiness, workspace identity, MCP/OpenCode hardening, and Veslo server lifecycle behavior. Local uncommitted changes should be layered back only where they add the Skill Registry capability contract or UI wiring. The local Veslo server connection behavior change should be discarded because it weakens Sandbox Merge's explicit runtime-chain readiness gate.

**Tech Stack:** Git, SolidJS app shell, Veslo server TypeScript/Bun service, Tauri desktop runtime, Tauri Pilot E2E.

---

## Merge Intent

Use `origin/local/sandbox-merge` as the architectural source of truth.

Preserve local work only when it adds Skill Registry capability awareness:

- app-side capability type: `skillRegistry.configured`
- server-side capability response: `skillRegistry.configured`
- UI availability plumbing that consumes `skillRegistry.configured`

Discard local work when it changes Veslo server readiness semantics in conflict with Sandbox Merge.

## File Resolution Matrix

| File | Resolution | Meaning |
| --- | --- | --- |
| `packages/app/src/app/context/veslo-server-connection.ts` | Take Sandbox Merge version | Keep Sandbox Merge's option-gated runtime-chain readiness behavior. Drop the local diagnostics-only server probe behavior. |
| `packages/app/src/app/lib/veslo-server/types.ts` | Merge both | Keep local `skillRegistry.configured` and keep Sandbox Merge's new auth/runtime/plugin/conversation-submit protocol types. |
| `packages/server/src/types.ts` | Merge both | Keep local `Capabilities.skillRegistry.configured` and keep Sandbox Merge's new server config, plugin activation, and session artifact fields. |
| `packages/server/src/server.ts` | Merge both | Keep local capability response for Skill Registry configuration and keep Sandbox Merge's server-owned submit/runtime changes. |
| `packages/app/src/app/app.tsx` | Merge both | Keep Sandbox Merge's server-owned send/runtime wiring and keep local Skill Registry availability plumbing. |

## Task 1: Protect Local Work

**Files:**
- Read only: all dirty local files
- Preserve: local tracked and untracked changes

**Step 1: Capture a backup of current local changes**

Save the current tracked patch and list of untracked files before changing any file. This is a safety net, not the merge resolution.

**Step 2: Confirm local branch state**

Confirm the active branch is `dev_vaclav`, local `HEAD` matches `origin/dev_vaclav`, and `origin/local/sandbox-merge` is ahead of it.

**Step 3: Confirm no user work will be lost**

Verify that the local dirty changes are either stashed, backed up, or intentionally discarded by this plan.

## Task 2: Apply the One Intentional Discard

**Files:**
- Replace from Sandbox Merge: `packages/app/src/app/context/veslo-server-connection.ts`

**Step 1: Restore the local dirty change in the connection file**

Discard the local modification in `packages/app/src/app/context/veslo-server-connection.ts` before merging or before reapplying the stash.

**Step 2: Preserve Sandbox Merge's readiness model**

Ensure the resolved file keeps these semantics:

- runtime-chain readiness can be required or bypassed by an explicit option
- the default local desktop path requires runtime-chain readiness
- server-only checks can bypass full runtime-chain readiness when requested
- auth failure handling uses the Sandbox Merge status model
- Veslo server descriptor updates can come from Tauri server state events

**Step 3: Do not reintroduce the local diagnostics-only probe behavior**

Do not keep the local change that probes runtime diagnostics but still treats the server as connected when the runtime chain is not ready.

## Task 3: Merge App Capability Types

**Files:**
- Modify: `packages/app/src/app/lib/veslo-server/types.ts`

**Step 1: Keep the local Skill Registry capability field**

The app-side `VesloServerCapabilities` type must include:

```ts
skillRegistry?: {
  configured: boolean;
};
```

**Step 2: Keep Sandbox Merge protocol additions**

Do not remove Sandbox Merge's additions for:

- `auth_desync` server status
- plugin activation phase metadata
- plugin cold-start and restart metadata
- materialization sync phase metadata
- latest-run artifact conversation/session identity
- server-owned conversation submit request/result types

**Step 3: Check compatibility**

Confirm that app code can safely treat `skillRegistry` as optional, because older or partial server responses may not include it.

## Task 4: Merge Server Capability Types

**Files:**
- Modify: `packages/server/src/types.ts`

**Step 1: Keep the local server capability field**

The server `Capabilities` interface must include:

```ts
skillRegistry: {
  configured: boolean;
};
```

**Step 2: Keep Sandbox Merge server/runtime additions**

Do not remove Sandbox Merge's additions for:

- server instance/runtime descriptor fields
- secrets-file token source values
- plugin activation metadata
- latest-run artifact conversation/session identity

**Step 3: Keep server and app contracts aligned**

Confirm the app type and server type both expose the same `skillRegistry.configured` shape.

## Task 5: Merge Server Capability Response

**Files:**
- Modify: `packages/server/src/server.ts`

**Step 1: Keep Sandbox Merge's server-owned submit/runtime code**

Do not remove Sandbox Merge's additions for:

- conversation submit attempt store
- conversation submit service
- skill command resolution
- AI Gateway auth failure tracing
- document runtime dependency reuse
- strict conversation/session binding
- OpenCode session action helpers

**Step 2: Keep local Skill Registry capability response**

The server capability builder must include:

```ts
skillRegistry: {
  configured: Boolean(skillRegistryBaseUrl(config)),
},
```

**Step 3: Keep `buildCapabilities` testable**

If the local change exports `buildCapabilities` for tests, keep that export unless the merged test suite no longer needs it.

**Step 4: Check import availability**

Confirm `skillRegistryBaseUrl` is still available in the merged file and that the capability builder can call it without introducing a circular dependency.

## Task 6: Merge App UI Wiring

**Files:**
- Modify: `packages/app/src/app/app.tsx`

**Step 1: Keep Sandbox Merge's app architecture**

Do not remove Sandbox Merge's additions for:

- server-owned conversation submit
- legacy submit fallback wrapper
- managed AI runtime authorization for send
- workspace ID resolution changes
- removal of old devtools workspace routing
- updated plugin inventory props

**Step 2: Keep local Skill Registry availability plumbing**

Preserve the local memo that derives Skill Registry availability from Veslo server readiness, workspace readiness, and `resolvedVesloCapabilities().skillRegistry.configured`.

**Step 3: Keep the UI prop handoff**

Preserve the local prop handoff for Skill Registry availability and materialization auth context, so the downstream skills UI can use the capability.

**Step 4: Reconcile naming only if needed**

If Sandbox Merge renamed any prop or capability access path, adapt the local Skill Registry wiring to the new name instead of dropping it.

## Task 7: Reapply Remaining Local Work

**Files:**
- Preserve all remaining local files unless they conflict with Sandbox Merge's architecture.

**Step 1: Reapply the local patch after the branch fast-forward**

Apply the local dirty work after local `dev_vaclav` has been updated to `origin/local/sandbox-merge`.

**Step 2: Resolve only actual conflicts**

Expected intentional resolution:

- `packages/app/src/app/context/veslo-server-connection.ts`: Sandbox Merge wins

Expected clean merges:

- `packages/app/src/app/app.tsx`: keep both
- `packages/app/src/app/lib/veslo-server/types.ts`: keep both
- `packages/server/src/server.ts`: keep both
- `packages/server/src/types.ts`: keep both

**Step 3: Confirm no conflict markers remain**

Check that no merge markers remain in source, tests, docs, or generated artifacts.

## Task 8: Semantic Review Checklist

**Files:**
- Review: `packages/app/src/app/app.tsx`
- Review: `packages/app/src/app/lib/veslo-server/types.ts`
- Review: `packages/server/src/server.ts`
- Review: `packages/server/src/types.ts`
- Review: `packages/app/src/app/context/veslo-server-connection.ts`

Confirm these statements are true:

- Skill Registry configured state is produced by the server capability response.
- Skill Registry configured state is represented in the server `Capabilities` type.
- Skill Registry configured state is represented in the app `VesloServerCapabilities` type.
- Skill Registry configured state reaches the app UI wiring.
- The app can handle missing `skillRegistry` capability safely.
- Veslo server connection readiness follows Sandbox Merge's option-gated runtime-chain behavior.
- The connection layer does not silently mark the local runtime as usable when the runtime chain is required but not ready.
- Server-owned conversation submit remains intact.
- Plugin activation and materialization metadata remains intact.

## Task 9: Focused Verification

**Files:**
- Test: `packages/app/src/app/tests/context/veslo-server-connection.test.ts`
- Test: `packages/app/src/app/tests/lib/veslo-server.test.ts`
- Test: `packages/app/src/app/tests/pages/skills-bulk-publish-gate.test.ts`
- Test: `packages/server/src/tests/server.capabilities.test.ts`
- Test: `packages/server/src/tests/server.plugins-routes.test.ts`
- Test: `packages/server/src/tests/conversation-submit-service.test.ts`

**Step 1: Typecheck app and server**

Run the app and server typechecks after the file resolutions.

Expected: both typechecks pass or failures are clearly unrelated baseline failures.

**Step 2: Run focused app tests**

Run the app tests covering Veslo server connection and Skill Registry availability.

Expected: connection tests reflect Sandbox Merge's readiness behavior; Skill Registry tests see `skillRegistry.configured`.

**Step 3: Run focused server tests**

Run the server tests covering capabilities, plugin routes, and conversation submit.

Expected: capabilities include Skill Registry configuration; Sandbox Merge's submit/plugin routes remain intact.

**Step 4: Rebuild server binary**

Because `packages/server/src` changes are part of the merged result, rebuild the Veslo server binary before relying on server-backed flows.

## Task 10: Desktop Runtime Verification

**Files:**
- Reference: `docs/dev/testing-playbook.md`
- Test: `packages/e2e/pilot-scenarios/smoke.toml`
- Test: `packages/e2e/specs/skill-publish-request.pilot.ts`

**Step 1: Follow desktop process preflight**

Before starting desktop runtime or Pilot tests, follow the single-tenant desktop preflight from the testing playbook.

**Step 2: Run minimum desktop smoke**

Run the Tauri Pilot smoke scenario against the real desktop runtime.

Expected: app starts, Veslo server connection settles, and the app shell remains usable.

**Step 3: Run Skill Registry publish path**

Run the Skill Registry publish Pilot path if the local Skill Registry UI work remains part of the final merge state.

Expected: publish path respects server capabilities and does not regress Sandbox Merge's runtime flow.

## Completion Criteria

The merge is ready when:

- local `dev_vaclav` contains `origin/local/sandbox-merge`
- local Skill Registry capability work is preserved in app and server types
- local Skill Registry capability response is preserved in server capabilities
- local Skill Registry UI availability plumbing is preserved
- `packages/app/src/app/context/veslo-server-connection.ts` is resolved to Sandbox Merge semantics
- focused typechecks/tests pass or failures are documented as pre-existing/unrelated
- real desktop/Pilot smoke has passed or is explicitly documented as blocked
- no local stash needed for recovery remains undropped without a reason
