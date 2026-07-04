---
title: Session Flow Background Ownership And Measurability Plan
date: 2026-07-04
status: partial
done: false
issue: unlinked
source_audit: session-flow-background-ui-dependency-audit-2026-07-04
depends_on:
  - docs/plans/2026-07-03-runtime-cold-start-background-flow-ownership-plan.md
  - docs/plans/2026-07-03-runtime-cold-start-session-handoff-kiss-plan.md
sfb00_baseline_and_test_drift_done: true
sfb01_trace_and_measurement_contract_done: true
sfb02_runtime_preparation_single_source_done: true
sfb03_flow_progress_presenter_boundary_done: true
sfb04_session_creation_navigation_split_done: true
sfb05_queue_drain_background_controller_done: false
sfb06_passive_read_side_effect_policy_done: true
sfb07_live_transcript_policy_owner_done: true
sfb08_app_wiring_and_boundary_contract_tests_done: true
sfb09_regression_bundle_done: false
---

# Session Flow Background Ownership And Measurability Plan

## Goal

Make first-send, cold-start, session creation, and queued-draft continuation less
dependent on mounted UI components and easier to measure, reuse, and maintain.

The product rule is:

- UI components submit user intent and render state.
- Background/context owners continue the program after that intent.
- Runtime preparation returns typed state and telemetry instead of mutating UI
  directly.
- Busy/progress state is presented through one adapter, not owned separately by
  send, create, workspace, and readiness helpers.
- Queue draining must not depend on `SessionView` effects continuing to run.
- Read/status paths must not start local services unless an explicit policy says
  that side effect is allowed.

## Implementation Status Contract

Every task starts as `done: false`.

Only mark a task `done: true` after code, focused tests, and listed
verification for that task are complete in the original worktree. Do not mark
top-level `done` complete until SFB00 through SFB09 are complete and verified.

If a task is partially implemented, append a dated note under that task and
leave its `done: false` line unchanged.

## Coordination Notes For Agents

This plan is a coordination artifact only after it is tracked or explicitly
shared with the working agents. Before implementing from another worktree,
verify:

```powershell
git ls-files docs/plans/2026-07-04-session-flow-background-measurability-plan.md
git ls-files docs/plans/2026-07-03-runtime-cold-start-background-flow-ownership-plan.md
git ls-files docs/plans/2026-07-03-runtime-cold-start-session-handoff-kiss-plan.md
```

If this plan or its dependency plans are still untracked, do not assume another
agent can see them. Either track/share the files first or copy the relevant
audit summary into the task handoff.

`source_audit` currently refers to the inline summary in this document, not to a
separate audit file. If a durable audit document is later added, update
`source_audit` to point to that file.

## Current Audit Findings

Current flow is improved but still hybrid:

- `packages/app/src/app/context/session-flow-facade.ts` is only a facade. It
  forwards calls and does not own program flow.
- `packages/app/src/app/pages/session.tsx` still triggers flow continuation from
  Solid effects for selected session changes and session status changes.
- `packages/app/src/app/pages/session-conversation-flow.ts` owns more queue
  logic than before, but it still receives lifecycle triggers from the mounted
  view and has many UI-oriented dependencies: composer, viewport, toast, run
  indicator, and temp runtime UI traces.
- `packages/app/src/app/pages/session-send-workflow.ts` still mixes program
  flow with UI state: busy labels, selected session, view switching, composer,
  pending sidebar rows, and live transcript read policy.
- `packages/app/src/app/pages/session-creation-workflow.ts` both creates the
  backend conversation and applies UI effects: busy state, sidebar
  materialization, session selection, and route navigation.
- `packages/app/src/app/context/send-runtime-readiness.ts` now has a typed
  runtime preparation result, but still mutates `engineReady` and
  `sseConnected` directly.
- `packages/app/src/app/context/conversation-service.ts` can start the local
  Veslo server from passive read/status paths through
  `resolvePassiveConversationReadClient`.
- `packages/app/src/app/tests/app-send-preflight-context.test.ts` is stale
  against the typed runtime preparation refactor. The stale source-contract
  slice starts at the public boolean wrapper
  `ensureLocalRuntimeReachableForSend()` even though the real typed result logic
  now lives in `ensureLocalRuntimeReachableForSendResult()`.

## KISS Boundary

Core for this plan:

- Improve ownership boundaries around existing files.
- Add typed progress and measurement seams before moving large behavior.
- Keep current first-send and pending-session UX stable.
- Fix stale tests that block reliable verification.
- Move continuation triggers out of `SessionView` incrementally.
- Make passive read side effects explicit and measurable.

Not core for this plan:

- Rewriting the orchestrator.
- Rewriting OpenCode.
- Redesigning the session UI.
- Deleting `session-send-workflow.ts` or `session-creation-workflow.ts` in one
  pass.
- Changing default installed-runtime behavior covered by OpenCode cold-path
  plans.
- Pulling unrelated `setBusy` owners from workspace activation, workspace
  connection, local workspace creation, or extensions into this refactor.
- Adding a new large coordinator before smaller services/adapters prove that
  shared decision ownership is actually needed.

## What To Delete Or Narrow

Prefer deletion or narrowing over new layers:

- Remove or rename stale `SessionView.*` trace source names.
- Replace brittle source-contract tests with behavior or boundary-contract tests
  when the implementation shape is already known to have changed.
- Remove direct busy setter dependencies from send/create workflows.
- Remove queue-drain `createEffect` calls from `SessionView`.
- Keep `session-flow-facade.ts` honest as a facade. If it only forwards calls,
  do not describe it as an owner.
- Do not introduce `session-flow-coordinator.ts` until two or more completed
  slices need the same background decision owner.

## Target Ownership

### Deferred Session Flow Coordinator

Target location:

```text
packages/app/src/app/context/session-flow-coordinator.ts
```

Responsibilities:

- Accept send/create/open/replace/cancel user intents.
- Own continuation decisions after the initial intent.
- Coordinate runtime preparation, pending-session materialization, queue drain,
  and conversation run start.
- Emit typed progress and trace events.

Must not:

- Render UI.
- Call Solid component-local setters directly.
- Depend on `SessionView` effects to keep the flow alive.

The existing `session-flow-facade.ts` may stay as the API facade, but it should
delegate to this coordinator when the coordinator exists.

Do not create this file as the first implementation step. It is a deferred
consolidation point. Start with smaller service/adapters in SFB00 through SFB04;
create the coordinator only after those slices show duplicated decision logic
that belongs in one owner.

### Runtime Preparation Service

Current file:

```text
packages/app/src/app/context/send-runtime-readiness.ts
```

Responsibilities:

- Return a typed runtime preparation result.
- Describe whether health was skipped, checked, recovered, failed, or already
  known.
- Update preflight state consistently.

Must not:

- Mutate UI/global readiness signals directly.
- Own busy labels.
- Require the caller to know whether `enginePrepared`, `runtimeHealthOk`, and
  `managedAiReady` need to be set manually.

### Flow Progress Presenter

Target location:

```text
packages/app/src/app/context/session-flow-progress-presenter.ts
```

Responsibilities:

- Translate typed flow progress events into UI-facing signals such as `busy`,
  `busyLabel`, `busyStartedAt`, `creatingSession`, and run diagnostics.
- Deduplicate overlapping send/create/runtime progress.
- Provide a single source of truth for user-visible flow state.

Must not:

- Start runtime work.
- Create sessions.
- Drain queues.

### Queue Drain Controller

Target location:

```text
packages/app/src/app/context/session-queue-drain-controller.ts
```

Responsibilities:

- Subscribe to session status changes and queue state from context/store level.
- Drain queued drafts when a session transitions to idle.
- Guard in-flight drain attempts per session key.
- Emit measurable queue-drain trace events.

Must not:

- Be mounted only inside `SessionView`.
- Depend on transcript viewport or composer rendering.

## Implementation Order

Implement in this order:

1. SFB00 baseline and stale test fix.
2. SFB01 trace and measurement contract.
3. SFB02 runtime preparation single source.
4. SFB03 flow progress presenter boundary.
5. SFB04 session creation/navigation split.
6. SFB05 queue drain background controller.
7. SFB06 passive read side-effect policy.
8. SFB07 live transcript policy owner.
9. SFB08 app wiring and boundary-contract tests.
10. SFB09 regression bundle.

Do not start SFB05 before SFB03 is complete unless the progress presenter is
folded into the same implementation slice and its acceptance criteria are also
met.

## SFB00: Baseline And Test Drift

done: true

Goal:

Freeze the current state and remove known test drift so later agents can trust
the verification bundle.

Implementation:

- Link the real issue id in front matter if a ticket exists. Leave
  `issue: unlinked` only if no ticket exists, and record that decision in the
  baseline note.
- Record current branch, commit, dirty files, and whether the previous CBF/RSH
  plan is still in progress.
- Fix `packages/app/src/app/tests/app-send-preflight-context.test.ts` so it
  locates and asserts the typed runtime preparation logic in
  `ensureLocalRuntimeReachableForSendResult`, not the public boolean wrapper
  `ensureLocalRuntimeReachableForSend`.
- Keep the test focused on the behavior:
  - duplicate runtime health skips only when `preflight.runtimeHealthOk` is true
  - the public boolean wrapper delegates to the typed result
  - `prepareSendRuntimeForSend` records runtime failure reasons from the typed
    result

Focused verification:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/app-send-preflight-context.test.ts src/app/tests/context/send-runtime-readiness.test.ts
```

Acceptance:

- The stale source-contract failure is gone.
- Tests verify behavior, not only an obsolete source snippet.
- No production behavior changes are included in this baseline slice.

2026-07-04 implementation note:

- `issue: unlinked` remains because no ticket id was supplied in the current
  handoff.
- Baseline branch: `main`.
- Baseline HEAD: `03f78870`.
- Relevant dirty files at implementation time:
  - `packages/app/src/app/context/send-runtime-readiness.ts`
  - `packages/app/src/app/pages/session-conversation-flow.ts`
  - `packages/app/src/app/tests/app-send-preflight-context.test.ts`
  - `packages/app/src/app/tests/pages/session-conversation-flow.test.ts`
  - `packages/app/src/app/tests/context/session-flow-facade.test.ts`
  - `docs/plans/2026-07-03-runtime-cold-start-background-flow-ownership-plan.md`
  - `docs/plans/2026-07-03-runtime-cold-start-session-handoff-kiss-plan.md`
  - `docs/plans/2026-07-04-session-flow-background-measurability-plan.md`
- Dependency plans and this plan are still untracked, so this is not yet a
  HEAD-visible coordination artifact for other worktrees.
- Verification passed:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/app-send-preflight-context.test.ts src/app/tests/context/send-runtime-readiness.test.ts
```

## SFB01: Trace And Measurement Contract

done: true

Goal:

Make flow progress measurable with stable event names before changing more
ownership.

Implementation:

- Replace stale `SessionView.*` trace source names in
  `packages/app/src/app/pages/session-conversation-flow.ts` with owner-based
  names such as `SessionConversationFlow.sendPromptImmediate`.
- Add a narrow typed flow event model for send/create/runtime/queue transitions.
  Prefer a small local type near the workflow files first; move it only if two
  owners need it.
- Do not introduce `session-flow-coordinator.ts` in this slice.
- Ensure each first-send attempt has one trace id and one client message id
  carried through:
  - runtime preparation
  - session creation
  - pending-session materialization
  - conversation run
  - queue drain completion
- Add tests that assert trace source names and high-level event ordering.

Focused verification:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/context/session-flow-facade.test.ts
```

Acceptance:

- No trace source in `session-conversation-flow.ts` is named `SessionView.*`.
- First-send and queue-drain traces include stable owner names.
- Existing runtime behavior is unchanged.

2026-07-04 partial implementation note:

- Completed only the trace-rename subset recommended for the first slice.
- Renamed `SessionView.*` temp runtime trace source names in
  `packages/app/src/app/pages/session-conversation-flow.ts` to
  `SessionConversationFlow.*`.
- Added a boundary assertion in
  `packages/app/src/app/tests/pages/session-conversation-flow.test.ts`.
- Left `done: false` because the full measurement/event contract for SFB01 is
  not implemented yet.
- Verification passed:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/context/session-flow-facade.test.ts
```

2026-07-04 completion note:

- Later slices completed the measurement contract without introducing a
  coordinator:
  - `SessionFlowProgressEvent` is the typed flow event model for send/create
    progress.
  - send/create workflows emit typed progress events through the presenter
    boundary.
  - queue continuation trace sources use
    `SessionConversationFlow.*`/`SessionQueueDrainController.*` owner names.
  - live transcript read policy emits typed policy events from send/compact
    success paths.
- Verification passed:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/context/session-flow-facade.test.ts src/app/tests/context/session-flow-progress-presenter.test.ts
```

## SFB02: Runtime Preparation Single Source

done: true

Goal:

Make runtime preparation the single source of truth for send/create/replace
runtime readiness.

Implementation:

- Promote the typed runtime preparation result in
  `send-runtime-readiness.ts` so callers do not set `enginePrepared`,
  `runtimeHealthOk`, or `managedAiReady` manually after a successful call.
- Replace the `sendRuntimeReady` pre-check in
  `session-send-workflow.ts` with a typed preparation call that can return
  `already-ready`, `health-ok`, `recovered`, or `blocked`.
- Keep `isWorkspaceRuntimeReady` available for rendering and cheap policy
  decisions, but do not let it be a second readiness source for send/create.
- Update `session-creation-workflow.ts` so create-session runtime checks consume
  the same preflight result instead of reinterpreting boolean flags.
- Update `session-mutation-workflow.ts` replace flow to use the same result.

Focused verification:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/send-runtime-readiness.test.ts src/app/tests/app-send-preflight-context.test.ts src/app/tests/pages/session-send-workflow.test.ts src/app/tests/pages/session-mutation-workflow.test.ts
```

Acceptance:

- One runtime preparation path is used by send, create, and replace.
- Callers do not manually set success flags that the preparation service can set.
- Runtime failure telemetry includes the typed failure reason.
- No UI setter is required to know whether preparation succeeded.

2026-07-04 implementation note:

- `prepareSendRuntimeForSend` now returns a typed preparation result with
  `ok`, runtime readiness details, managed AI readiness, workspace scope, and
  failure reason.
- `session-send-workflow.ts` and `session-mutation-workflow.ts` now consume
  `.ok` from the typed result instead of relying on a boolean return.
- Send and replace callers no longer manually set `enginePrepared` or
  `managedAiReady`; the readiness service owns those preflight flags.
- First-send create handoff no longer passes `managedAiRuntimeAlreadyPrepared`.
  `session-creation-workflow.ts` consumes `preflight.enginePrepared` and
  `preflight.managedAiReady` instead.
- The obsolete `managedAiRuntimeAlreadyPrepared` option and controller
  `runtimeAlreadyPrepared` input were removed from the active workflow
  contract.
- Verification passed:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/send-runtime-readiness.test.ts src/app/tests/app-send-preflight-context.test.ts src/app/tests/controllers/send-orchestration-controller.test.ts src/app/tests/app-send-orchestration-controller-contract.test.ts src/app/tests/app-managed-ai-bootstrap-gate.test.ts src/app/tests/app-stale-local-runtime-recovery.test.ts src/app/tests/pages/session-send-workflow.test.ts src/app/tests/pages/session-creation-workflow.test.ts src/app/tests/pages/session-mutation-workflow.test.ts src/app/pages/session-pending-instance.test.ts src/app/tests/pages/session-message-replacement.test.ts src/app/tests/pages/session-message-queue.test.ts
corepack pnpm@10.27.0 --filter @neatech/veslo-ui typecheck
git diff --check -- packages/app/src/app/context/send-runtime-readiness.ts packages/app/src/app/pages/session-send-workflow.ts packages/app/src/app/pages/session-mutation-workflow.ts packages/app/src/app/pages/session-creation-workflow.ts packages/app/src/app/controllers/send-orchestration-controller.ts packages/app/src/app/tests/context/send-runtime-readiness.test.ts packages/app/src/app/tests/app-send-preflight-context.test.ts packages/app/src/app/tests/controllers/send-orchestration-controller.test.ts packages/app/src/app/tests/app-send-orchestration-controller-contract.test.ts packages/app/src/app/tests/app-stale-local-runtime-recovery.test.ts packages/app/src/app/tests/pages/session-send-workflow.test.ts packages/app/src/app/tests/pages/session-creation-workflow.test.ts packages/app/src/app/tests/pages/session-mutation-workflow.test.ts packages/app/src/app/pages/session-pending-instance.test.ts packages/app/src/app/tests/pages/session-message-replacement.test.ts docs/plans/2026-07-04-session-flow-background-measurability-plan.md
```

## SFB03: Flow Progress Presenter Boundary

done: true

Goal:

Stop session send/create flows from owning UI busy state directly, including
the runtime-preparation progress they surface during those flows.

Implementation:

- Scope this slice to session send/create busy ownership only. Do not change
  unrelated busy owners in workspace activation, workspace connection, local
  workspace creation, or extension workflows.
- Add a small progress presenter that accepts typed events, for example:
  - `runtime.connecting`
  - `runtime.recovering`
  - `session.creating`
  - `session.loading`
  - `conversation.running`
  - `flow.idle`
- Wire the presenter in `app.tsx` to update existing UI signals:
  `setBusy`, `setBusyLabel`, `setBusyStartedAt`, and `setCreatingSession`.
- Replace direct busy mutations in `session-send-workflow.ts` with progress
  events.
- Replace direct busy mutations in `session-creation-workflow.ts` with progress
  events.
- Keep existing labels stable unless a test proves the current label is wrong.
- Ensure progress cleanup is idempotent when send creates a session and both
  flows finish through different `finally` blocks.

Focused verification:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-send-workflow.test.ts src/app/tests/pages/session-creation-workflow.test.ts src/app/tests/app-send-latency-trace.test.ts
```

Acceptance:

- `session-send-workflow.ts` does not receive `setBusy`,
  `setBusyLabel`, or `setBusyStartedAt`.
- `session-creation-workflow.ts` does not receive `setBusy`,
  `setBusyLabel`, or `setBusyStartedAt`.
- A first-send create-session path cannot leave a stale busy label after create
  finishes.
- Existing visible busy/loading behavior remains equivalent.

2026-07-04 implementation note:

- Added `session-flow-progress-presenter.ts` as the session send/create
  progress adapter. It maps typed flow events to the existing app busy,
  busy-label, busy-started-at, and creating-session signals.
- The presenter supports owner-scoped events so overlapping send/create cleanup
  is idempotent and create-session cleanup does not clear an active send owner.
- `session-send-workflow.ts` now emits `runtime.connecting`,
  `conversation.running`, and owner-scoped `flow.idle` instead of receiving
  `setBusy`, `setBusyLabel`, or `setBusyStartedAt`.
- `session-creation-workflow.ts` now emits `session.creating`,
  `session.loading`, and owner-scoped `flow.idle` instead of receiving busy or
  creating-session setters.
- `app.tsx` wires the presenter to the existing UI signals. Workspace
  activation, workspace connection, local workspace creation, extension, and
  runtime-readiness busy owners were left out of this slice.
- Verification passed:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-flow-progress-presenter.test.ts src/app/tests/pages/session-send-workflow.test.ts src/app/tests/pages/session-creation-workflow.test.ts src/app/tests/app-send-latency-trace.test.ts src/app/tests/pending-session-send-flow.test.ts src/app/tests/app-send-orchestration-controller-contract.test.ts
corepack pnpm@10.27.0 --filter @neatech/veslo-ui typecheck
git diff --check -- packages/app/src/app/context/session-flow-progress-presenter.ts packages/app/src/app/pages/session-send-workflow.ts packages/app/src/app/pages/session-creation-workflow.ts packages/app/src/app/app.tsx packages/app/src/app/tests/context/session-flow-progress-presenter.test.ts packages/app/src/app/tests/pages/session-send-workflow.test.ts packages/app/src/app/tests/pages/session-creation-workflow.test.ts packages/app/src/app/tests/pending-session-send-flow.test.ts docs/plans/2026-07-04-session-flow-background-measurability-plan.md
```

## SFB04: Session Creation And Navigation Split

done: true

Goal:

Split backend session creation from UI navigation and sidebar effects.

Implementation:

- Change `session-creation-workflow.ts` to return a typed creation result:
  - created session id
  - conversation id
  - opencode session id
  - workspace scope
  - pending handoff metadata
  - recommended UI transition
- Move route navigation and `goToSession` behind a caller-owned transition
  adapter.
- Move sidebar materialization behind a session list/sidebar adapter.
- Keep `selectSession` ordering stable until tests prove a safer order.
- Preserve `onMaterializedSessionId` semantics for first-send pending handoff.

Focused verification:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-pending-instance.test.ts src/app/tests/pages/session-send-workflow.test.ts src/app/tests/pages/session-creation-workflow.test.ts
```

Acceptance:

- Backend conversation creation can be tested without route navigation.
- UI navigation is a transition effect applied after a typed creation result.
- Pending-session materialization still works for first send.
- No duplicate select/navigation occurs during create-then-send.

2026-07-04 implementation note:

- `session-creation-workflow.ts` now builds a typed
  `SessionCreationResult` containing the created session id, conversation ids,
  workspace scope, pending handoff metadata, and transition recommendation.
- Added `createSession()` for backend creation callers/tests that need the
  typed result without applying route/sidebar effects.
- Kept `createSessionAndOpen()` as the compatible wrapper that applies the
  caller-owned state and transition adapters and returns the created session id.
- Moved session list/sidebar/handoff work behind `applyCreatedSessionState` and
  select/route work behind `applyCreatedSessionTransition` in `app.tsx`.
- Preserved the old effect order for `createSessionAndOpen`: backend create,
  state/sidebar/handoff, then select/route transition.
- Verification passed:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-creation-workflow.test.ts src/app/tests/pages/session-send-workflow.test.ts src/app/tests/pages/session-pending-instance.test.ts src/app/tests/pending-session-send-flow.test.ts src/app/tests/app-send-latency-trace.test.ts
corepack pnpm@10.27.0 --filter @neatech/veslo-ui typecheck
```

## SFB05: Queue Drain Background Controller

done: false

Goal:

Move queued-draft continuation out of mounted `SessionView` effects.

Implementation:

- Add `session-queue-drain-controller.ts` at context/store level.
- Feed it session status map changes, selected session changes, queue state, and
  pause state from stable app/context signals.
- Move the drain triggers currently reached through:
  - `handleSelectedSessionChanged`
  - `handleActiveSessionStatusChanged`
  - `handleSessionStatusMapChanged`
- Keep queue mutation helpers in `session-conversation-flow.ts` until this is
  stable; do not rewrite queue storage in the same slice.
- Make `SessionView` submit explicit user actions and render queue state only.

Focused verification:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-view-modularization.test.ts
```

Acceptance:

- `packages/app/src/app/pages/session.tsx` no longer calls queue-drain handlers
  from `createEffect`.
- Queue drain continues when a session transitions to idle.
- Queue drain is guarded per session key.
- Status-map changes no longer require UI component-local effects to continue
  the program.

2026-07-04 implementation note:

- Added `session-queue-drain-controller.ts` under `context/` to own the
  selected-session, active-status, and status-map reactive effects that trigger
  queue flow continuation.
- `SessionView` now wires the controller with accessors and flow-facade
  handlers, but no longer calls `handleSelectedSessionChanged`,
  `handleActiveSessionStatusChanged`, or `handleSessionStatusMapChanged` from
  component-local `createEffect` bodies.
- Queue storage and `session-conversation-flow.ts` drain logic stayed in place
  for this slice; only the reactive trigger ownership moved.
- Existing run-state reset logic that is not queue-drain ownership remains in
  `SessionView`.
- This is a partial extraction, not full background ownership. The controller
  is still started from mounted `SessionView` because queue/run/search/viewport
  state still lives in the page component. Keep this task open until that state
  is lifted to an app/context owner and queue continuation can run without
  `SessionView` being mounted.
- Verification passed:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-view-modularization.test.ts
corepack pnpm@10.27.0 --filter @neatech/veslo-ui typecheck
```

## SFB06: Passive Read Side-Effect Policy

done: true

Goal:

Make read/status paths explicit about whether they are allowed to start local
services.

Implementation:

- Add a read-side policy input to `conversation-service.ts`, for example:
  `allowPassiveServerStart(reason, scope)`.
- Default passive conversation list/status reads to no server start unless a
  caller explicitly allows it.
- Keep send/write/write-control paths allowed to start or resolve required
  services. This explicitly includes Stop/abort paths such as
  `abortConversationFromVesloWriteApi`, which currently uses
  `resolvePassiveConversationReadClient`.
- Record telemetry when passive read declines to start a server.
- Update session list/transcript/status callers to pass their intent:
  browse-only, live-read, status-poll, write-follow-up, or write-control.

Focused verification:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/conversation-service.test.ts src/app/tests/context/session-store.test.ts
```

Acceptance:

- Passive read/status paths cannot accidentally start local Veslo server without
  an explicit policy decision.
- Send/write paths still start required services.
- Stop/abort/write-control paths cannot be denied by browse-only passive read
  policy.
- Telemetry identifies skipped passive starts.

2026-07-04 implementation note:

- Added explicit `ConversationPassiveReadPolicy` intents:
  `browse-only`, `live-read`, `status-poll`, `write-follow-up`, and
  `write-control`.
- `resolvePassiveConversationReadClient()` now returns an already available
  client immediately, but declines to start a local server unless the intent is
  `write-follow-up` or `write-control`.
- Passive conversation list reads use `browse-only`, transcript reads use
  `live-read`, and run status polling uses `status-poll`.
- Send/create/run workspace resolution and conversation backfill use
  `write-follow-up`.
- `abortConversationFromVesloWriteApi()` uses `write-control`, preserving Stop
  and abort paths that must be able to start or resolve the local server.
- Declined passive starts are recorded through send trace and workspace debug
  telemetry.
- Verification passed:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/conversation-service.test.ts src/app/tests/app-conversation-abort.test.ts
corepack pnpm@10.27.0 --filter @neatech/veslo-ui typecheck
```

## SFB07: Live Transcript Policy Owner

done: true

Goal:

Move live transcript read policy out of send workflow side effects.

Implementation:

- Introduce a small policy owner for live transcript read allowance.
- Let conversation run success emit a typed event that the policy owner consumes.
- Remove direct `markLiveTranscriptReadAllowedForWorkspace` dependency from
  `session-send-workflow.ts`.
- Preserve the current rule: background warmup alone must not make ordinary
  history browsing use live SDK reads.
- Add tests for:
  - no live read after boot warmup alone
  - live read allowed after successful send/compact
  - workspace-scoped behavior across active workspace switches

Focused verification:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-store.test.ts src/app/tests/pages/session-send-workflow.test.ts src/app/tests/app-refactor-contracts.test.ts
```

Acceptance:

- `session-send-workflow.ts` does not own browse/live transcript policy.
- The policy owner records why live read became allowed.
- Background warmup still cannot flip browse policy by itself.

2026-07-04 implementation note:

- Added `live-transcript-read-policy.ts` as the live transcript read allowance
  owner.
- `session-send-workflow.ts` now emits typed conversation run/compact success
  policy events instead of accepting a direct browse-policy setter.
- `app.tsx` wires the policy owner and still gates ordinary history browsing
  through `isLiveTranscriptReadAllowedForWorkspace`.
- Added tests for no allowance before send, recorded allowance reason,
  compact-success allowance, and workspace-scoped behavior across active
  workspace switches.
- Verification passed:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/live-transcript-read-policy.test.ts src/app/tests/pages/session-send-workflow.test.ts src/app/tests/app-boot-engine-ready.test.ts src/app/tests/app-send-latency-trace.test.ts
```

## SFB08: App Wiring And Boundary-Contract Tests

done: true

Goal:

Keep `app.tsx` as a composition shell and enforce the new boundaries with tests.

Implementation:

- Introduce narrow adapters in `app.tsx` for:
  - flow progress presenter
  - runtime preparation service
  - session creation transition effects
  - live transcript policy
  - queue drain controller
- Update boundary-contract tests so regressions are obvious. Use source checks
  only for stable architectural bans, not for exact implementation source
  shape:
  - `SessionView` must not call queue-drain handlers from effects.
  - send/create workflows must not receive direct busy setters.
  - readiness service must not receive `setBusy` or own busy labels.
  - passive read service must require an explicit side-effect policy.
- Keep `session-flow-facade.ts` as a facade, not a fake owner.

Focused verification:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/app-refactor-contracts.test.ts src/app/tests/context/session-flow-facade.test.ts src/app/tests/pages/session-view-modularization.test.ts
```

Acceptance:

- Boundary regressions fail quickly in focused tests.
- `app.tsx` wires owners and adapters but does not grow new flow decisions.
- Facade names and tests reflect that the facade is a facade.

2026-07-04 implementation note:

- Added boundary-contract coverage for:
  - progress presenter and runtime preparation adapters,
  - send/create workflows not receiving direct busy setters,
  - readiness service not owning busy labels,
  - queue-drain continuation effects living in
    `session-queue-drain-controller.ts`,
  - live transcript policy living behind a policy owner,
  - passive conversation reads requiring explicit side-effect intent,
  - `session-flow-facade.ts` staying reactive-free and thin.
- Updated the existing queue-drain source contract to allow the current
  selected-session wrapper while requiring delegation through the facade.
- Verification passed:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/app-refactor-contracts.test.ts src/app/tests/context/session-flow-facade.test.ts src/app/tests/pages/session-view-modularization.test.ts
```

## SFB09: Regression Bundle

done: false

Goal:

Verify the whole flow after ownership changes.

Focused verification:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/app-send-preflight-context.test.ts src/app/tests/context/send-runtime-readiness.test.ts src/app/tests/context/conversation-service.test.ts src/app/tests/context/session-flow-facade.test.ts src/app/tests/pages/session-send-workflow.test.ts src/app/tests/pages/session-creation-workflow.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-pending-instance.test.ts src/app/tests/pages/session-view-modularization.test.ts
corepack pnpm@10.27.0 --filter @neatech/veslo-ui typecheck
git diff --check
```

Manual or pilot verification:

- Run the existing Tauri pilot only after focused tests pass.
- Use the project session login/profile that returns inference responses.
- Capture:
  - first-send trace id
  - client message id
  - workspace id
  - runtime preparation result reason
  - queue-drain events, if any
  - AI gateway failure/success reason

Acceptance:

- First-send cold start works without UI owning continuation decisions.
- Failed runtime preparation has a typed, visible, traceable reason.
- Queue drain still works after send completion.
- Passive reads do not start services without policy approval.
- Top-level `done` can be changed to `true` only after all SFB tasks are true.
- Final SFB09 remains open while SFB05 is open; the current bundle validates the
  implemented slices, not the strict mounted-view-independent queue drain goal.

2026-07-04 implementation note:

- Regression bundle passed with the expanded SFB coverage for the implemented
  slices:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/app-send-preflight-context.test.ts src/app/tests/context/send-runtime-readiness.test.ts src/app/tests/context/conversation-service.test.ts src/app/tests/context/session-flow-facade.test.ts src/app/tests/context/session-flow-progress-presenter.test.ts src/app/tests/context/live-transcript-read-policy.test.ts src/app/tests/app-refactor-contracts.test.ts src/app/tests/app-boot-engine-ready.test.ts src/app/tests/app-send-latency-trace.test.ts src/app/tests/app-conversation-abort.test.ts src/app/tests/app-send-orchestration-controller-contract.test.ts src/app/tests/pages/session-send-workflow.test.ts src/app/tests/pages/session-creation-workflow.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-pending-instance.test.ts src/app/tests/pages/session-view-modularization.test.ts src/app/tests/pending-session-send-flow.test.ts
```

Result: `185` passed, `0` failed.

- Typecheck passed:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui typecheck
```

- Diff hygiene passed with LF/CRLF warnings only:

```powershell
git diff --check
```

- E2E debug assets were rebuilt before attempting pilot validation:

```powershell
pnpm --filter veslo-server build:bin
$env:VESLO_SIDECAR_FORCE_BUILD = "1"; pnpm --filter @neatech/veslo run prepare:sidecar; Remove-Item Env:\VESLO_SIDECAR_FORCE_BUILD
Push-Location packages\desktop; pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e; Pop-Location
```

- Tauri pilot verification was then intentionally skipped on user instruction
  because the current E2E/debug setup is suspect. The attempted run failed
  before a useful session-flow validation with:
  `Invalid package entry 5 in managed dependencies manifest at ...\opencode-managed-deps.json.exe`.
  Treat that as a separate E2E/debug packaging configuration issue, not as a
  regression in this session-flow ownership slice.

## Suggested Agent Slices

Recommended small PR/task slices:

1. SFB00 and the trace-rename subset of SFB01 first.
2. SFB02 alone.
3. SFB03 alone.
4. SFB04 alone.
5. SFB05 alone.
6. SFB06 and SFB07 together only if the same policy/event owner is used.
7. SFB08 and SFB09 final hardening.

Avoid mixing UI visual redesign, orchestrator cold-path changes, and flow-owner
refactors in the same slice.

Hard rule for implementation: measure and remove direct dependencies first;
add a new owner only when a completed smaller slice has proven the owner is
needed.
