# Local Execution + Expanded Sync Design (Compatibility-Preserving)

Date: 2026-03-08  
Status: Approved

## 1. Goal

Shift Veslo/Openwork to local-only execution for users while preserving backend compatibility and minimizing code churn.

Core product intent:
- All tool execution, shell commands, filesystem actions, and model calls run locally on user machines.
- Server is used for replicated chat/session history so users can view history across devices.
- Keep existing backend worker APIs and remote/cloud capabilities in place (not removed) so behavior can be re-enabled later.

## 2. Locked Decisions

- Sync scope: Expanded.
- Runtime authority: Local-first.
- Remote/cloud disablement level: UI-off only.
- Cross-device mismatch policy: workspace mismatch always requires fork.

## 3. Recommended Approach

Chosen approach: Compatibility Wrapper.

Why:
- Minimal change footprint.
- Preserves current backend API surface and remote code paths.
- Easiest rollback/re-enable path for future remote execution.

Approach summary:
- Keep current worker/workspace/session architecture.
- Gate member-facing remote/cloud UX behind a mode flag.
- Add sync replicator layer that uploads expanded local history to server.

## 4. Architecture

### 4.1 Execution plane

- Execution remains entirely local via existing local workspace/session flow.
- Existing `session.create`, `session.prompt`, tool/event streaming, and permission handling stay local.

### 4.2 Sync plane

- Add a Sync Replicator in app/desktop that tails local session/messages/events/artifacts metadata and replicates to server.
- Server stores/query synced history only for this mode.
- No server-side tool execution required for member flow.

### 4.3 Compatibility plane

- Remote/cloud worker endpoints remain implemented and callable.
- Member UI hides remote/cloud entry points.
- Admin/internal surfaces can keep remote controls if needed.

## 5. Data Model and Sync Contract

### 5.1 Identity and keys

- Local session IDs remain runtime identity.
- Sync entities keyed by:
  - `workspaceCanonicalId`
  - `sessionId`
  - `eventSeq` (monotonic per session)

### 5.2 Expanded sync payload

- Messages (user/assistant/system, parts/attachments metadata).
- Tool timeline/events (start/update/end, permission prompts and decisions).
- Artifacts metadata and references.
- Session metadata (title, model, timestamps, status).
- Workspace fingerprint snapshots captured per run boundary.

### 5.3 Conflict and authority

- Local write-ahead queue with idempotency keys (`sessionId:eventSeq`).
- Server accepts idempotent upserts.
- Server does not overwrite local execution state.
- Pull sync hydrates history for viewing; does not drive runtime mutations.

### 5.4 Privacy and scope

- Expanded history is synced.
- Workspace files are not uploaded by default unless explicitly attached/exported.

## 6. Cross-Device Continuation and Forking

### 6.1 Opening from another machine

- Synced chat opens in history/view mode.
- Continue action requires selecting a local workspace context.

### 6.2 Workspace fingerprint check

On continue, compare current local workspace fingerprint against source run fingerprint.

Recommended fingerprint fields:
- git remote URL (when available)
- git commit SHA
- dirty state
- workspace root token/canonical path id

### 6.3 Mandatory fork rule

If mismatch is detected:
- Block in-place continuation.
- Require `Fork chat to this machine/workspace`.
- Create fork metadata:
  - `newSessionId`
  - `parentSessionId`
  - `forkReason=workspace_mismatch`
  - `sourceFingerprint`
  - `targetFingerprint`

No force-continue override.

## 7. UX Behavior

### 7.1 Member-facing UX

- Hide/remove member entry points: `Add worker`, `Connect remote`, cloud launch.
- Show runtime status as `Runs on this device`.
- Show sync status chip (`Synced`, `Syncing…`, `Sync paused`).

### 7.2 Cross-device UX

- Chat history is visible immediately.
- Continue path triggers fingerprint validation.
- Mismatch forces fork flow with clear explanation.

### 7.3 Owner/admin UX

- Remote/cloud controls can remain in hidden/admin surfaces for compatibility/internal operations.

### 7.4 Error handling UX

- Sync upload failures: non-blocking banner + retries.
- Offline mode: local execution continues; sync backfills later.
- Artifact sync partial failures are clearly marked.

## 8. Minimal-Change Implementation Boundaries

- Keep backend worker provisioning/control APIs unchanged.
- Introduce top-level mode flag (e.g. `appMode=local_sync`).
- In `local_sync` mode:
  - Hide remote/cloud member UI.
  - Keep local execution flow unchanged.
  - Enable sync replicator.
- In other modes:
  - Existing behavior remains available.
- Avoid broad renames/removals of `Worker`/`Workspace`/`Session` types in this phase.

## 9. Verification and Rollout

### 9.1 Verification checklist

- Local execution E2E remains functional.
- Expanded sync persists messages, tool events, artifact metadata.
- Cross-device open works in history mode.
- Mismatch always blocks continue and requires fork.
- Fork lineage metadata is persisted and rendered.
- Remote/cloud backend endpoints still pass compatibility smoke tests.

### 9.2 Rollout

- Phase 1: mode flag + UI hiding.
- Phase 2: expanded sync replicator enablement.
- Phase 3: mandatory mismatch-fork UX enforcement hardening.
- Rollback by disabling mode flag.

### 9.3 Guardrails

- No implicit workspace file upload.
- Idempotent sync with retry queue.
- Local-first conflict resolution.
- Telemetry for sync lag/failure and mismatch-fork rate.
