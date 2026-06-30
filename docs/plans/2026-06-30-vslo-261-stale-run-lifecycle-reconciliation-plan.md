---
title: VSLO-261 Stale Run Lifecycle Reconciliation Plan
date: 2026-06-30
status: phase-7-operational-recovery-complete
done: true
kiss_slice_1_done: true
phase_4_followup_done: true
phase_5_recovery_done: true
phase_7_startup_sweep_done: true
source_issue: Desktop agent remains Answering when run lifecycle stays stale after engine run
---

# VSLO-261 Stale Run Lifecycle Reconciliation Plan

## Goal

Stop desktop conversations from staying in `Answering` forever when a Veslo conversation run remains
stuck in `conversation_run.status = running` after:

- an OpenCode engine crash or replacement,
- a successful user abort,
- a successful OpenCode response whose completion is not reconciled into Veslo lifecycle,
- workspace/session navigation during an active run,
- a sidebar/read-store failure while the UI is switching workspaces.

The fix must make lifecycle terminalization server/orchestrator-owned. UI transcript append remains
an important wake-up signal, but it must not be the only path that clears an active run.

## Implementation Status Contract

This document starts with every implementation status set to `done: false`.

The AI agent implementing the plan is responsible for changing a `done: false` line to `done: true`
only after the corresponding code, tests, and verification for that section are complete. Do not
flip the top-level `done` value until every non-deferred phase required for the accepted fix slice is
implemented and verified.

`kiss_slice_1_done: false` is the first implementation target. It becomes `true` only when Phase 1,
Phase 2, Phase 3, and Phase 6 are implemented, the focused tests pass, and the queue wake-up behavior
is verified. Phase 4 was later completed as a separate engine-loss cleanup patch. The Phase 4
follow-up owner-attach/stale-retry patch is also complete. Phase 5 read-only UI recovery and Phase 7
legacy startup sweep were completed as KISS follow-ups.

## Incident Summary

Known reports from 2026-06-26 and 2026-06-28 show the same business symptom from multiple runtime
paths:

- OpenCode accepted the prompt and the provider path started.
- In one case, the engine later failed health checks and was replaced.
- In another case, OpenCode wrote the assistant response successfully, but Veslo lifecycle stayed
  `running`.
- In another existing conversation, later user input was persisted behind an active stale run and
  the server queue did not drain.
- Abort returned success from OpenCode but only set `abort_requested = 1`.
- The desktop UI kept showing `Answering` because the visible run state waits for a scoped idle or
  terminal transition.
- One sidebar workspace/session refresh also hit `SQLiteError: no such table: session` from the
  conversation read store, blocking reliable session materialization during navigation.

Local verification during audit still found a dev lifecycle store with 14 active `running` rows with
no `completed_at` and no `error`. The exact ticket run ids were no longer present locally, so that
DB state is supporting evidence for the stale-row class, not proof for those exact incidents.

## Current Architecture Snapshot

### Lifecycle Store and Registry

Current lifecycle ownership is centered in:

- `packages/orchestrator/src/run-store.ts`
- `packages/orchestrator/src/run-registry.ts`
- `packages/orchestrator/src/run-activity-probe.ts`
- lifecycle HTTP endpoints inside `packages/orchestrator/src/cli.ts`

Important current behavior:

- `conversation_run` has active statuses `submitted`, `running`, and `blocked`.
- Terminal statuses are `completed`, `failed`, and `aborted`.
- SQLite enforces one active run per `(workspace_id, conversation_id)`.
- `register()` checks `activeForConversation()`, reconciles that active row, and rejects with
  `RunAlreadyActiveError` if the active row is still non-terminal.
- `active()`, `latest()`, and `get()` are reconciled reads.
- `reconcile()` marks a run `completed` only when `probeRunActivity()` returns `active: false`.
- `reconcile()` leaves the row active and returns `stale: true` when the probe is `unreachable`.
- `markFailed()` exists.
- `markAbortRequested()` only sets metadata; it does not mark the run terminal.

This is a good foundation for admission control, but it is not enough as the only completion path.
If no later reconciled read sees a clean inactive signal, a stale active row keeps blocking the
conversation.

### Activity Probe

`run-activity-probe.ts` already has useful terminal detection:

- no engine means inactive,
- `GET /session/status` with `busy` or `retry` means active,
- `GET /session/status` with `idle` means inactive,
- unknown status shape falls back to `GET /session/:id/message`,
- missing session transcript (`404`) means inactive,
- latest assistant with `time.completed`, `error`, or `finish` means inactive,
- non-404 engine failures return `unreachable`.

The gap is policy, not parser capability: the code can recognize idle/completed sessions, but it is
called only when some request path asks for lifecycle status.

### Server Conversation Run Admission and Queue

Current server path:

- `POST /workspace/:id/conversations/:conversationId/runs`
  - resolves the execution target,
  - asks lifecycle for an active reconciled run,
  - registers a new lifecycle run before submitting to OpenCode,
  - queues the request if lifecycle reports an active run,
  - submits to OpenCode and returns `status: "submitted"`.
- `conversation_run_queue` stores queued run requests durably.
- `drainConversationQueue()` checks lifecycle `latest`; if it is still active, it reschedules itself.
- `reconcileConversationLifecycleAfterTranscriptAppend()` asks lifecycle to reconcile `latest` after
  a terminal-looking transcript append, then wakes the queue if the row became terminal.
- Startup schedules drain polling for pending conversation queue keys.

This already implements the correct business boundary: after the server accepts a run, the server is
authoritative and the UI queue is only a local editing affordance. The missing part is a reliable
server/orchestrator wake-up for completion, abort, crash, and replacement.

### App Session Runtime

Recent modularization already gives this issue good attachment points:

- `session-transcript-controller.ts`
  - foreground transcript ingest,
  - background transcript ingest using explicit source workspace clients,
  - append through Veslo server.
- `session-event-stream.ts`
  - scoped `session.status`, `session.idle`, `session.error`,
  - active and background workspace SSE event handling,
  - background transcript ingestion triggers.
- `workspace-session-selection.ts`
  - workspace/conversation/session scope memory,
  - latest run id aliases.
- `session.tsx`
  - run indicator state,
  - local editable draft queue,
  - session switch preservation of keyed run state.

The UI behavior is defensible if backend lifecycle is reliable: session switch preserves prior run
UI state and waits for the scoped runtime status to clear it. That design becomes dangerous when
backend terminalization is best-effort.

### Engine Runtime

Per-workspace engine pool:

- `EnginePool` has `onEngineChange` events: `spawned`, `suspended`, `crashed`, `restart-scheduled`,
  `restart-attempt`, `permanently-failed`, `healthy`, `unhealthy`.
- The current `onEngineChange` listener in `cli.ts` logs and persists engine snapshots.
- It does not reconcile or terminalize active lifecycle rows on crash/restart/permanent failure.
- The pool already has `hasActiveWork()` so idle suspend and LRU avoid killing recent active runs.

Shared-unsandboxed engine:

- `SharedOpenCodeEngine` starts and reuses one shared process.
- It has no health monitor, crash/restart event surface, or lifecycle hook comparable to
  `EnginePool`.
- `run-activity-probe` in shared-unsandboxed mode calls `sharedOpenCodeEngine.getRunning()`, so if
  the shared process disappears the probe returns no engine and can release active runs only when a
  reconciled lifecycle read happens.

Because the 2026-06-28 environment note explicitly had sandbox disabled, the final fix must cover
both per-workspace pool and shared-unsandboxed mode.

### Conversation Read Store

Current read-store behavior:

- `conversation-read-store.ts` opens an existing SQLite path and queries `FROM session`.
- Missing DB file returns `source: "unavailable"`.
- Missing session row returns `source: "unavailable"`.
- A DB file that exists but does not have OpenCode's `session` table throws.
- `conversation-service.ts` catches read-store errors only when host-owned bindings already exist.
  If the host store is empty, the error propagates and can become a 500.

This matches the sidebar incident. It is not the core stale lifecycle bug, but it can interrupt the
navigation/read path that would otherwise help the UI materialize the correct session and transcript.

## What Is Already Done and Should Be Reused

1. Server-authoritative run admission already exists.
   - Do not move this invariant back to the UI.
   - Keep `POST /workspace/:id/conversations/:conversationId/runs` as the owner of accepted sends.

2. Durable run queue already exists.
   - Reuse `scheduleConversationQueueDrain()` after every new terminalization path.
   - Do not create a separate app-only queue drain rule for stale backend rows.

3. Reconciled lifecycle reads already exist.
   - Extend the registry/store with explicit terminalization helpers where needed.
   - Reuse `probeRunActivity()` for "is this actually inactive?" decisions.

4. Engine pool crash events already exist.
   - Attach lifecycle cleanup to `onEngineChange` instead of inventing a second engine monitor for
     pooled engines.

5. App session runtime has been modularized.
   - Keep UI changes small and targeted to status/lifecycle recovery.
   - Add tests against `session-transcript-controller`, `session-event-stream`, and session run-state
     behavior rather than growing `session.tsx`.

6. Existing docs already state the intended contract.
   - `docs/dev/veslo-server-app-contract.md` says run admission is server-authoritative and active
     reads are reconciled.
   - `docs/features/session-runtime.md` says workspace/session visibility is not the runtime
     boundary and background runs must persist transcripts through the Veslo server.

7. Existing tests already cover the happy path.
   - `server-stale-active-run.integration.test.ts` proves idle OpenCode status releases stale active
     rows before new submissions.
   - `server-conversations.test.ts` covers queue drain and transcript append reconciliation.
   - `run-registry.test.ts` documents current unreachable and abort metadata behavior.
   - `run-activity-probe.test.ts` covers status/message terminal parsing.
   - `session-transcript-controller.test.ts` covers background transcript ingestion from an explicit
     workspace client.

## Findings and Planned Fixes

### Finding 1: Lifecycle completion is pull-based and can miss successful completion

Severity: P0

Current behavior:

- Submit creates a `running` lifecycle row before OpenCode submit.
- Normal OpenCode success does not directly complete the lifecycle row.
- Completion is discovered later by a lifecycle read or transcript append reconciliation.
- If the relevant `session.idle`, transcript append, or queue/status read does not happen, the row
  stays active forever.

Why this matters:

- A completed OpenCode answer can be present in OpenCode DB while Veslo still shows `Answering`.
- Server queue drain sees latest lifecycle active and keeps polling.
- The UI has no authoritative backend terminal signal to clear run state.

Plan:

- Add an orchestrator/server-owned completion watcher for accepted prompt runs.
- After successful submit, schedule a short lifecycle reconciliation loop for that `(workspaceId,
  conversationId, runId)`.
- The loop should call a run-specific reconciled status and stop when the run is terminal, failed,
  aborted, too old, or superseded.
- On terminal status, wake the durable server queue immediately.
- Keep transcript append reconciliation as a fast-path, not the only path.

Test coverage to add:

- Server integration: OpenCode returns 204, later `/session/status` becomes idle, no transcript
  append occurs, lifecycle becomes terminal and queue drains.
- Server integration: OpenCode messages show terminal assistant but no `session.idle` event arrives;
  lifecycle becomes terminal from message probe.
- Regression: successful submit must not immediately mark completed before OpenCode is actually
  idle/terminal.

### Finding 2: Abort success only records intent and can leave the row running

Severity: P0

Current behavior:

- User abort calls OpenCode `/session/:id/abort`.
- If upstream abort succeeds, Veslo calls `markAbortRequested()`.
- `markAbortRequested()` only sets `abortRequested = true`.
- Existing tests intentionally encode "abort intent is metadata and inactive reconcile completes the
  run".

Why this matters:

- In a stale/restarted engine case, abort can return success but there may be no later inactive
  reconcile.
- The visible run remains `running` with `abort_requested = 1`.
- User-visible cancel does not clear `Answering`.

Plan:

- Preserve `abortRequested` as metadata, but add an explicit terminal path after successful abort.
- Preferred behavior:
  - call OpenCode abort,
  - mark abort requested,
  - run immediate reconcile,
  - if inactive or missing engine/session, mark `aborted`,
  - wake queue.
- If OpenCode abort succeeds but probe remains active, keep `running + abortRequested` only briefly
  and schedule a bounded abort reconciliation loop.
- If OpenCode abort fails because the engine/session is gone, treat that as stale cleanup and mark
  the run `aborted` or `failed` according to the final product decision.

Open decision:

- Terminal status for user cancel after stale engine loss:
  - Recommended default: `aborted` when the user explicitly clicked stop/cancel.
  - Use `failed` for engine crash without user abort.

Test coverage to add/update:

- Orchestrator registry: `markAbortRequested` remains metadata, but new helper can mark aborted.
- Server route: successful abort marks lifecycle terminal or schedules immediate terminal reconcile.
- Queue drain: queued item behind an aborted active run starts without waiting for poll interval.
- App: successful abort response clears or receives terminal backend status for current run id.

### Finding 3: Engine crash/replacement does not terminalize runs owned by the dead engine

Severity: P0/P1

Current behavior:

- `EnginePool` detects health failures and child exits.
- It emits `crashed`, `restart-scheduled`, `restart-attempt`, and `permanently-failed`.
- The listener in `cli.ts` only logs and persists engine state.
- `conversation_run` does not store an engine generation/process identity.
- A replacement engine can exist while a run row from the old process stays `running`.

Why this matters:

- A crashed engine cannot later emit the idle/completed event for the old run.
- A restarted engine might not know the old active message/session state.
- A probe that hits a bad/restarting engine can return `unreachable`, and registry preserves the
  active row.

Plan:

- Add lifecycle cleanup on engine events.
- For pooled engines:
  - on `crashed` or `permanently-failed`, reconcile active runs for that workspace;
  - if active rows are tied to the crashed process/generation, mark them `failed`;
  - wake queues for affected conversations.
- Add engine generation/process ownership to new lifecycle rows:
  - generation id, process pid, baseUrl, or startedAt snapshot is enough;
  - use it to distinguish "same engine temporarily unreachable" from "old engine is gone".
- For existing rows without generation data:
  - apply conservative fallback: after crash/restart event, active rows older than the crash event
    and still unresolved should be marked failed with a clear error.

Shared-unsandboxed coverage:

- Add `SharedOpenCodeEngine` event/health handling comparable to pooled `EnginePool`, or add a
  lightweight shared-engine liveness sweep from `cli.ts`.
- When the shared engine disappears, all active local workspace runs using that shared engine need
  reconciliation or failure marking, not only the active UI workspace.

Test coverage to add:

- `engine-pool.test.ts`: crash event invokes lifecycle cleanup callback.
- Orchestrator integration/unit: active runs in workspace are marked failed on crash for matching
  engine generation.
- Shared engine test: child disappearance/liveness failure triggers active-run cleanup.
- Server queue test: pending item behind a crashed run drains after lifecycle marks failed.

### Finding 4: Successful transcript/background reconciliation is not guaranteed during navigation

Severity: P1

Current behavior:

- Foreground transcript ingestion refuses to build a payload if the active workspace id no longer
  matches the event workspace.
- Background ingestion exists and uses the explicit source workspace client.
- Background ingestion still depends on:
  - a routed client for the source workspace,
  - successful `session.get`,
  - successful `session.messages`,
  - successful server append,
  - terminal-looking reason or transcript snapshot for lifecycle reconcile.
- UI run state is preserved across session switch until scoped idle clears it.

Why this matters:

- The 2026-06-28 navigation incident can happen even when OpenCode completed successfully.
- The UI may switch workspaces/sessions while the old run is finishing.
- If the background ingest path misses or fails, lifecycle remains `running` and the UI reloads the
  stale state later.

Plan:

- Do not make UI navigation the owner of lifecycle completion.
- Keep background transcript ingestion, but add observability and retry for failed terminal ingests.
- Ensure `session.idle` and terminal `message.updated` from background workspaces schedule
  transcript append with source workspace scope and do not depend on selected UI workspace.
- Add a backend lifecycle poll after accepted submit so navigation cannot strand the row even if
  transcript append fails.
- Make UI read backend lifecycle/latest run state on returning to a conversation if local run state
  is still active beyond a short grace period.

Test coverage to add:

- App context: background `session.idle` for a non-active workspace appends transcript and includes
  terminal reason.
- App/session flow: switching sessions preserves local UI state, but backend terminal status clears
  it on return.
- Server: transcript append with terminal assistant result wakes queued runs even when the UI
  workspace changed before append.

### Finding 5: Bad OpenCode DB schema can break sidebar/session navigation

Severity: P1/P2

Current behavior:

- Read-store treats missing DB as unavailable.
- Read-store does not treat missing OpenCode tables as unavailable.
- `conversation-service` propagates read-store errors if host bindings are empty.

Why this matters:

- Sidebar refresh can produce 500 `SQLiteError: no such table: session`.
- That can prevent clicked sessions from materializing during the same user flow that already has an
  active run.
- It compounds the stuck `Answering` symptom by breaking recovery/navigation.

Plan:

- Add schema validation or guarded query handling in `conversation-read-store.ts`.
- Missing `session`, `message`, or `part` tables should return `source: "unavailable"` and log a
  warning, not throw to the route.
- `conversation-service.loadTranscript()` should also catch read-store unavailable/schema errors
  after a host miss and return an unavailable/empty transcript response instead of 500 where product
  behavior expects passive read fallback.
- Keep real corruption/I/O errors visible in diagnostics, but avoid breaking sidebar browsing for a
  non-OpenCode SQLite file.

Test coverage to add:

- `conversation-read-store.test.ts`: existing SQLite file with no `session` table returns
  unavailable for list and transcript.
- `conversation-service.test.ts`: empty host store plus bad source schema does not 500.
- Route test: `/conversations` returns 200 with unavailable/empty source instead of 500 for bad DB.

## Implementation Phases and KISS Slice

## KISS Slice 1: Server/Orchestrator Lifecycle

done: true

This is the first implementation slice. Keep it narrow:

- Phase 1: orchestrator lifecycle terminal helpers.
- Phase 2: bounded completion watcher after accepted prompt runs.
- Phase 3: abort reconciliation and terminalization policy.
- Phase 6: bad OpenCode DB schema returns `unavailable`, not 500.

Phase 0 should add only targeted reproductions needed for these flows, not every failing test in the
full roadmap. Phase 4 was completed in the follow-up crash/generation cleanup patch. Phase 5 and
Phase 7 were later completed as KISS follow-ups.

### Phase 0: Reproduction and Guard Tests

done: true

Add a few targeted failing tests first for the first implementation slice:

- stale active run after successful OpenCode completion without transcript append,
- abort success leaves active row,
- malformed OpenCode DB schema causes sidebar list 500.

Do not block Slice 1 on broad crash/restart or UI navigation reproductions. Those belong to the
deferred roadmap phases unless the implementer is explicitly asked to extend scope.

Expected result before fixes: at least one focused test for completion, abort, and bad schema fails
against current behavior.

### Phase 1: Orchestrator Lifecycle Terminal Helpers

done: true

Target files:

- `packages/orchestrator/src/run-store.ts`
- `packages/orchestrator/src/run-registry.ts`
- `packages/orchestrator/src/cli.ts`
- `packages/orchestrator/src/tests/run-registry.test.ts`
- `packages/orchestrator/src/tests/run-store.test.ts`

Work:

- Add explicit helpers for:
  - mark completed from reconcile,
  - mark failed from engine loss,
  - mark aborted after user abort/stale abort,
  - list active runs by workspace only if needed for direct queue/recovery behavior.
- Keep existing reconciled read semantics compatible.
- Add structured error strings for abort cleanup and bounded watcher failures.
- Do not introduce engine generation/process ownership in Slice 1; that belongs to deferred Phase 4.

Acceptance:

- Existing lifecycle tests still pass.
- New helper tests prove one active row becomes terminal and unique active lock is released.

### Phase 2: Completion Watcher and Queue Wake

done: true

Target files:

- `packages/server/src/server.ts`
- `packages/server/src/routes/conversations.ts`
- `packages/server/src/tests/server-conversations.test.ts`
- `packages/server/src/tests/server-stale-active-run.integration.test.ts`

Work:

- After accepted submit, schedule a bounded reconciliation loop.
- Stop the loop on terminal status, failed submit, abort, timeout, or missing lifecycle owner.
- Wake `scheduleConversationQueueDrain()` immediately when terminal state is observed.
- Keep transcript append reconciliation as immediate fast-path.

Acceptance:

- A successful OpenCode completion without transcript append releases lifecycle and drains queue.
- No false completion while OpenCode status remains busy/retry.
- Polling is bounded and traceable.

### Phase 3: Abort Terminalization

done: true

Target files:

- `packages/server/src/server.ts`
- `packages/server/src/routes/conversations.ts`
- `packages/orchestrator/src/run-registry.ts`
- relevant server/orchestrator tests

Work:

- After upstream abort, set abort metadata and start immediate terminal reconcile.
- Add a direct `markAborted` lifecycle call if immediate probe says inactive/missing/stale.
- Wake queue after abort terminalization.
- Decide and document behavior for abort when upstream engine/session is gone.

Acceptance:

- User stop/cancel cannot leave a row `running + abort_requested = 1` forever.
- Queue behind an aborted run drains.
- Existing UI abort test still tracks submitted/queued run ids.

### Phase 4: Engine Crash and Shared Engine Cleanup

done: true

Implemented after KISS Slice 1 as a separate engine-loss cleanup patch.

Target files:

- `packages/orchestrator/src/engine-pool.ts`
- `packages/orchestrator/src/shared-opencode-engine.ts`
- `packages/orchestrator/src/cli.ts`
- `packages/orchestrator/src/tests/engine-pool.test.ts`
- `packages/orchestrator/src/tests/shared-opencode-engine.test.ts`

Work:

- Add lifecycle cleanup callback for pooled engine `crashed` and `permanently-failed`.
- Add engine generation/process ownership to run registration.
- Add shared-unsandboxed liveness event or sweep.
- For crash cleanup, mark affected active rows `failed` with a clear engine-lost error.
- Wake queues for affected conversations.

Acceptance:

- Engine crash/replacement cannot leave active run rows tied to the dead engine.
- Shared-unsandboxed mode gets equivalent protection.
- Active-work protection for idle/LRU remains intact.

### Phase 5: KISS Navigation/Transcript Recovery Hardening

done: true

Implemented after KISS Slice 1 as a read-only UI recovery path. UI recovery polls/reads backend
lifecycle for the latest known run and improves stale visible state, but it does not decide or write
lifecycle terminal state.

Target files:

- `packages/app/src/app/context/session-lifecycle-recovery.ts`
- `packages/app/src/app/context/session.ts`
- `packages/app/src/app/app.tsx`
- `packages/app/src/app/lib/veslo-server-domains/conversations.ts`
- `packages/app/src/app/context/session-lifecycle-recovery.test.ts`

Work:

- Add app client read for `GET /workspace/:id/conversations/:conversationId/runs/:runId`.
- Add a bounded, deduplicated recovery watcher for local active session statuses
  (default 600 attempts at 5s poll).
- On backend terminal status with `stale !== true`, set local session status to `idle`, notify busy
  state, and schedule transcript ingestion for the owning workspace.
- On `stale: true`, continue polling without making a terminal decision.
- Keep UI queue/edit behavior unchanged and leave lifecycle mutation to server/orchestrator.

Acceptance:

- Switching sessions/workspaces during a run cannot permanently preserve `Answering` after backend
  terminalizes the run.
- UI recovery is read-only with respect to lifecycle rows.
- Background transcript append still avoids mutating active visible transcript incorrectly.

### Phase 6: Read Store Schema Hardening

done: true

Target files:

- `packages/server/src/conversation-read-store.ts`
- `packages/server/src/conversation-service.ts`
- `packages/server/src/tests/conversation-read-store.test.ts`
- `packages/server/src/tests/conversation-service.test.ts`

Work:

- Validate required OpenCode tables before query or catch known SQLite missing-table errors.
- Return `source: "unavailable"` for non-OpenCode SQLite files.
- Keep warnings/diagnostics for real investigation.

Acceptance:

- Bad schema no longer produces sidebar `/conversations` 500.
- Host-first behavior remains unchanged when host bindings exist.

### Phase 7: Operational Recovery Startup Sweep

done: true

Target files:

- `packages/orchestrator/src/run-store.ts`
- `packages/orchestrator/src/run-registry.ts`
- `packages/orchestrator/src/cli.ts`
- `packages/orchestrator/src/tests/run-store.test.ts`
- `packages/orchestrator/src/tests/run-registry.test.ts`
- this plan document

Work:

- Add `activeCreatedBefore(...)` to list old active lifecycle rows.
- Add registry startup sweep helper that terminalizes only old active rows.
- Use `failed` for ordinary stale legacy rows and `aborted` for rows with abort intent.
- Run the sweep at orchestrator startup before serving lifecycle/status requests.
- Default threshold: 24 hours; configurable with
  `--run-lifecycle-legacy-active-sweep-age-ms` or
  `VESLO_RUN_LIFECYCLE_LEGACY_ACTIVE_SWEEP_AGE_MS`; `0` disables the sweep.

Acceptance:

- Docs say lifecycle terminalization is owned by server/orchestrator, not UI-only transcript append.
- Existing stale rows from older builds have a safe migration/recovery path.
- Recent active runs are not terminalized by startup.

## Verification Commands

Focused server/orchestrator checks:

```powershell
pnpm --filter veslo-orchestrator exec bun test src/tests/run-store.test.ts src/tests/run-registry.test.ts src/tests/run-activity-probe.test.ts src/tests/engine-pool.test.ts src/tests/shared-opencode-engine.test.ts
pnpm --filter veslo-server exec bun test src/tests/conversation-read-store.test.ts src/tests/conversation-service.test.ts src/tests/conversation-run-queue-store.test.ts src/tests/orchestrator-lifecycle-client.test.ts src/tests/server-conversations.test.ts src/tests/server-stale-active-run.integration.test.ts
```

Focused app checks:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-transcript-controller.test.ts src/app/tests/context/session-event-stream.test.ts src/app/tests/context/session-workspace-busy-source.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/app-conversation-abort.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

Binary/runtime checks after server/orchestrator changes:

```powershell
pnpm --filter veslo-server build:bin
pnpm --filter veslo-orchestrator build:bin
```

Final hygiene:

```powershell
git diff --check
```

Desktop/E2E validation should use the real Tauri desktop runtime per `AGENTS.md` and
`docs/dev/testing-playbook.md`; do not validate this with a raw web/Vite UI server.

## Implementation Verification: KISS Slice 1

Implemented on 2026-06-30:

- orchestrator `markAborted` terminal helper and lifecycle HTTP/client endpoint,
- bounded server-side lifecycle reconcile watcher after accepted conversation runs,
- immediate abort reconciliation from successful OpenCode abort to terminal `aborted` when the
  lifecycle row is already inactive,
- immediate queue wake-up when watcher/reconcile observes terminal lifecycle status,
- read-store bad OpenCode SQLite schema fallback to `source: "unavailable"`.

Verification run after implementation:

```powershell
bun test packages/orchestrator/src/tests/run-registry.test.ts
bun test packages/server/src/tests/orchestrator-lifecycle-client.test.ts
bun test packages/server/src/tests/conversation-read-store.test.ts
bun test packages/server/src/tests/conversation-service.test.ts
bun test packages/server/src/tests/server-conversations.test.ts
pnpm --filter veslo-server typecheck
pnpm --filter veslo-orchestrator typecheck
pnpm --filter veslo-server build:bin
```

Result:

- run registry: 9 pass, 0 fail
- lifecycle client: 7 pass, 0 fail
- conversation read store: 9 pass, 0 fail
- conversation service: 12 pass, 0 fail
- server conversations: 17 pass, 0 fail
- server and orchestrator typecheck passed
- `veslo-server` binary rebuilt successfully

Deferred at this checkpoint; later completed in follow-up sections below:

- Phase 5 UI navigation/transcript recovery hardening,
- Phase 7 legacy-row operational recovery/startup sweep.

## Implementation Verification: Phase 4

Implemented on 2026-06-30:

- nullable engine ownership metadata on `conversation_run` rows:
  `engine_owner_id`, `engine_pid`, `engine_started_at`, and `engine_base_url`,
- migration for existing `runs.sqlite` databases that do not yet have those columns,
- `activeForEngineOwner()` run-store query,
- `markEngineLost()` registry helper that terminalizes active runs for the matching engine
  generation,
- pooled `EnginePool` `crashed` / `permanently-failed` cleanup wiring,
- shared-unsandboxed engine crash event and lightweight liveness tick,
- lifecycle registration now records the current pooled/shared engine owner snapshot.

Verification run after Phase 4:

```powershell
bun test packages/orchestrator/src/tests/run-store.test.ts packages/orchestrator/src/tests/run-registry.test.ts packages/orchestrator/src/tests/run-activity-probe.test.ts packages/orchestrator/src/tests/engine-pool.test.ts packages/orchestrator/src/tests/shared-opencode-engine.test.ts
bun test packages/server/src/tests/server-stale-active-run.integration.test.ts
pnpm --filter veslo-orchestrator typecheck
pnpm --filter veslo-server typecheck
pnpm --filter veslo-orchestrator build:bin
```

Result:

- orchestrator focused tests: 72 pass, 0 fail
- server stale-active integration: 1 pass, 0 fail
- orchestrator and server typecheck passed
- `veslo-orchestrator` binary rebuilt successfully

Deferred at this checkpoint; later completed in follow-up sections below:

- Phase 5 UI navigation/transcript recovery hardening,
- Phase 7 legacy-row operational recovery/startup sweep.

## Implementation Verification: Phase 4 Follow-up

Implemented on 2026-06-30:

- `attachEngineOwner()` registry helper for idempotently binding active run rows to the actual engine
  generation used by a submit request,
- internal `x-veslo-conversation-run-id` correlation header from the shared server submit helper,
- orchestrator attach immediately after successful proxy engine resolution and before upstream
  forwarding,
- strip of the internal correlation header before OpenCode upstream,
- lifecycle watcher retry on `stale: true` without false terminalization,
- longer default watcher horizon: 600 attempts at the existing 1s default poll.

Verification run after the follow-up:

```powershell
bun test packages/orchestrator/src/tests/run-registry.test.ts packages/orchestrator/src/tests/router-proxy.test.ts
bun test packages/server/src/tests/server-conversations.test.ts
bun test packages/orchestrator/src/tests/run-store.test.ts packages/orchestrator/src/tests/run-registry.test.ts packages/orchestrator/src/tests/run-activity-probe.test.ts packages/orchestrator/src/tests/engine-pool.test.ts packages/orchestrator/src/tests/shared-opencode-engine.test.ts packages/orchestrator/src/tests/router-proxy.test.ts
bun test packages/server/src/tests/server-stale-active-run.integration.test.ts packages/server/src/tests/orchestrator-lifecycle-client.test.ts
pnpm --filter veslo-orchestrator typecheck
pnpm --filter veslo-server typecheck
pnpm --filter veslo-orchestrator build:bin
pnpm --filter veslo-server build:bin
```

Result:

- initial focused orchestrator registry/proxy tests: 35 pass, 0 fail,
- server conversations: 18 pass, 0 fail,
- broader orchestrator lifecycle/proxy subset: 97 pass, 0 fail,
- server stale/lifecycle subset: 8 pass, 0 fail,
- orchestrator and server typecheck passed,
- `veslo-orchestrator` and `veslo-server` binaries rebuilt successfully.

Deferred at this checkpoint; later completed in the Phase 5/7 follow-up:

- Phase 5 UI navigation/transcript recovery hardening,
- Phase 7 legacy-row operational recovery/startup sweep.

## Implementation Verification: Phase 5/7 Follow-up

Implemented on 2026-06-30:

- read-only app client method for conversation run lifecycle status,
- bounded UI lifecycle recovery controller that polls backend status for the latest known active run
  (default 600 attempts at 5s poll),
- terminal backend status recovery to local `idle` plus transcript ingestion wake-up,
- `stale: true` UI recovery retry without false terminalization,
- orchestrator `activeCreatedBefore(...)` query for old active lifecycle rows,
- startup sweep that marks old active rows `failed`, or `aborted` when abort intent exists,
- 24 hour default sweep threshold with `0` disable via flag/env.

Verification run after the follow-up:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/session-lifecycle-recovery.test.ts
bun test packages/orchestrator/src/tests/run-store.test.ts packages/orchestrator/src/tests/run-registry.test.ts
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter veslo-orchestrator typecheck
pnpm --filter veslo-orchestrator build:bin
bun test packages/orchestrator/src/tests/run-store.test.ts packages/orchestrator/src/tests/run-registry.test.ts packages/orchestrator/src/tests/run-activity-probe.test.ts packages/orchestrator/src/tests/engine-pool.test.ts packages/orchestrator/src/tests/shared-opencode-engine.test.ts packages/orchestrator/src/tests/router-proxy.test.ts
git diff --check -- packages/orchestrator/src/run-store.ts packages/orchestrator/src/run-registry.ts packages/orchestrator/src/cli.ts packages/orchestrator/src/tests/run-store.test.ts packages/orchestrator/src/tests/run-registry.test.ts packages/orchestrator/src/tests/run-activity-probe.test.ts packages/app/src/app/lib/veslo-server/types.ts packages/app/src/app/lib/veslo-server-domains/conversations.ts packages/app/src/app/lib/veslo-server/client.ts packages/app/src/app/context/session.ts packages/app/src/app/context/session-lifecycle-recovery.ts packages/app/src/app/context/session-lifecycle-recovery.test.ts packages/app/src/app/app.tsx docs/plans/2026-06-30-vslo-261-stale-run-lifecycle-reconciliation-plan.md
```

Result:

- UI lifecycle recovery controller: 2 pass, 0 fail,
- initial orchestrator run-store/run-registry: 19 pass, 0 fail,
- app and orchestrator typecheck passed,
- `veslo-orchestrator` binary rebuilt successfully,
- broader orchestrator lifecycle/proxy subset: 99 pass, 0 fail,
- scoped diff hygiene passed with Windows LF-to-CRLF warnings only.

## Open Questions

1. Should user abort after engine loss always become `aborted`, even when OpenCode never confirms
   the target run existed in the replacement engine?
   - Recommended default: yes, because the user action was cancel and the run cannot continue.

2. Should crash cleanup mark runs `failed` immediately on `crashed`, or wait until restart attempt
   proves the old session is absent/terminal?
   - Recommended default: if the run generation matches the crashed engine, mark failed immediately.
     Without generation data, use a short bounded reconcile before failure.

3. Should old active rows be swept on startup?
   - Recommended default: yes, but only with age threshold plus OpenCode probe where possible.
     Never silently complete very recent rows without evidence.

4. Should completion watcher live in server or orchestrator?
   - Recommended default: server schedules per accepted run because it owns queue wake and knows the
     conversation id; orchestrator owns the actual reconcile/terminal mutation.

## Non-Goals

- Do not make the UI the business authority for active run admission.
- Do not remove the durable server queue.
- Do not treat every transient OpenCode probe failure as failed work.
- Do not cold-start inactive workspaces just to list conversations.
- Do not redesign the session UI while fixing lifecycle correctness.

## Current Audit Verification

Read-only audit commands already run before writing this plan:

```powershell
pnpm --filter veslo-server exec bun test src/tests/conversation-read-store.test.ts src/tests/conversation-service.test.ts src/tests/orchestrator-lifecycle-client.test.ts src/tests/server-conversations.test.ts src/tests/server-stale-active-run.integration.test.ts
pnpm --filter veslo-orchestrator exec bun test src/tests/run-registry.test.ts
```

Result:

- server focused suite: 41 pass, 0 fail
- orchestrator run registry suite: 8 pass, 0 fail

These passing tests are useful guardrails, but they do not cover the incident paths listed in
Phase 0.
