# Cloud-Only Login and Environment Modes Design

**Date:** 2026-03-07

**Goal:** Enforce a cloud-only OpenWork app across all builds and runtimes (`development`, `test`, `production`) using environment-specific cloud settings, while preserving branch compatibility by keeping local internals in code but unreachable in product behavior.

## Context

Current OpenWork behavior supports both local and remote workspaces, with onboarding and runtime flows that can start or connect to local host services. The requested direction is a product policy change:

- Cloud login only.
- Three environment states: `development`, `test`, `production`.
- App always connects to environment-defined cloud surfaces.
- Users should not see or use local control paths.
- Maintain maximum compatibility with existing OpenWork branches.

## Decision

Adopt a **cloud-only product policy with compatibility-preserving internals**:

1. Keep local runtime code and types in repository for merge compatibility.
2. Remove local capability from all user-facing flows and runtime action paths.
3. Enforce policy guards so local actions are blocked even if triggered indirectly.
4. Filter and remove local workspaces from persisted/user-visible state.
5. Route all login/connect flows through environment-configured cloud endpoints.

## Environment Model

Define a single environment contract used in every build/runtime:

- Active environment: `development` | `test` | `production`.
- Per-environment cloud config:
  - cloud app/login URL
  - cloud API/control-plane base URL
  - optional environment-specific workspace/deep-link defaults

The app resolves connection targets only from this environment contract and does not attempt local fallback.

## Product Behavior

### Onboarding

- Remove host/local onboarding branches.
- Keep one entry path: cloud login -> connect remote worker.
- Support environment-specific website auth/deep-link handoff.

### Workspace Visibility

- Local workspaces are not shown.
- Legacy local entries are removed from persisted workspace state on migration.
- If no remote workspace remains, route directly to cloud connect onboarding.

### Runtime Guards

Block local actions globally (UI and state/runtime layer), including:

- local workspace creation
- local workspace activation
- local host/engine startup paths

Return stable blocked-action codes for instrumentation and UX:

- `cloud_only_local_disabled`
- `cloud_only_local_workspace_filtered`
- `cloud_only_host_mode_removed`

## Compatibility Strategy

To keep branch compatibility:

- Do not delete local structs, RPC commands, or engine plumbing immediately.
- Keep compatibility fields where needed, but make them unreachable from product behavior.
- Prefer additive guards and flow redirection over large-scale deletions in this phase.

## Migration Plan

One-time migration at bootstrap:

1. Load persisted workspace state.
2. Remove all `workspaceType=local` entries.
3. Clear local startup/local-engine preference keys.
4. Persist sanitized state and set migration marker.
5. Continue in cloud connect flow.

Failure mode:

- If migration cleanup fails, app still routes to cloud connect flow and logs a non-sensitive diagnostic event.

## Verification

### Unit tests

- workspace migration removes local entries.
- policy guards reject local actions with expected error codes.
- environment resolver picks correct cloud targets for `development`, `test`, and `production`.

### Integration tests

- onboarding renders only cloud login/connect flow.
- remote connect works via env/deep-link inputs.
- legacy state containing local workspaces boots with zero local entries visible.

### Regression checks

- remote workspace flow remains functional.
- compatibility code compiles and does not regress mergeability with existing branches.

## Out of Scope

- Full deletion of local runtime internals.
- Rewriting unrelated server/orchestrator architecture.
- New cloud auth protocol design beyond environment wiring and existing login/deep-link surfaces.
