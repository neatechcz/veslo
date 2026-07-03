---
title: Runtime Cold Start Background Flow Ownership Plan
date: 2026-07-03
status: in-progress
done: false
issue: unlinked
depends_on:
  - docs/plans/2026-07-03-runtime-cold-start-session-handoff-kiss-plan.md
source_audit: readonly-cold-start-ui-ownership-audit-2026-07-03
cbf00_issue_and_baseline_done: false
cbf01_runtime_readiness_semantics_done: true
cbf04_send_runtime_readiness_boundary_done: true
cbf03_ui_effects_intents_only_done: true
cbf02_session_handoff_owner_done: true
cbf05_debug_autostart_boundary_done: true
cbf06_regression_verification_done: true
cbfd1_secondary_ui_creation_followup_done: false
---

# Runtime Cold Start Background Flow Ownership Plan

## Goal

Move the local runtime cold-start and first-send/session handoff program flow
behind explicit application owners so the frontend only submits user intent and
renders state.

The product rule is:

- UI components may start a user intent such as "send this draft" or "open this
  session".
- UI components must not decide the cold-start sequence after that intent.
- Runtime readiness, pending-session materialization, route selection, and
  queued-draft draining must be owned by background/context flow owners.
- Background engine warmup must not silently change browse/read policy into a
  live SDK path unless the read policy explicitly allows it.

## Implementation Status Contract

Every task starts as `done: false`.

Only change a task to `done: true` after its code, focused tests, and listed
verification are complete in the original worktree. Do not flip top-level
`done` until CBF00 through CBF06 are complete and verified.

CBF-D1 is a deferred cleanup follow-up. It does not block the top-level `done`
unless implementation proves that the same cold-start ownership bug still
depends on it.

If only part of a task is completed, append a dated note under that task and
leave its `done: false` line unchanged.

## Current Audit Findings

The existing runtime cold-start controller is mostly in the right place:

```text
packages/app/src/app/context/workspace-runtime-controller.ts
```

It owns `ensureEngineForWorkspace`, single-flight startup, workspace skill
materialization, local runtime restart/reattach, and the boot-warmup
`loadSessions: false` path.

The remaining ownership problems are above that layer:

- `engineReady` still has legacy meaning in comments and read policy. It used
  to mean "sendPrompt explicitly brought the engine up", but boot warmup can now
  set it to true without a send.
- `SessionView` effects react to `selectedSessionId` and `sessionStatus` by
  remapping pending queues and calling `drainNextQueuedDraft`.
- `session-send-workflow.ts` decides the first-send sequence from the page
  workflow: pending sidebar row, runtime prep, create session, then send.
- `session-creation-workflow.ts` creates backend conversation state and also
  applies UI state: sidebar materialization, `selectSession`, and route
  navigation.
- `send-runtime-readiness.ts` owns runtime recovery but also mutates active UI
  busy labels and legacy `engineReady`.
- debug-only native orchestrator autostart still uses UI/onboarding timing as a
  coordination mechanism. The current diff already has
  `VESLO_DISABLE_DEV_AUTOSTART` and pilot-runner wiring; the remaining work is
  to verify, finish any scenario gaps, and mark it done rather than adding the
  gate from scratch.

## KISS Boundary

Core for this plan:

- Split runtime readiness from browse/read policy and legacy UI readiness.
- Move first-send pending handoff and queue draining out of `SessionView`
  effects.
- Keep the current runtime controller as the engine-start owner.
- Add narrow owner APIs before moving code wholesale.
- Keep pending-session UX stable through the migration.

Not core for this plan:

- Rewriting the orchestrator.
- Rewriting OpenCode startup.
- Rebuilding routing from scratch.
- Redesigning the sidebar.
- Removing all page workflow files in one pass.

## Implementation Order

Implement in this order:

1. CBF00 baseline.
2. CBF01 runtime readiness vs browse policy.
3. CBF04 typed runtime preparation result without UI setters.
4. CBF03 move queue-drain flow out of `SessionView` effects.
5. CBF02 add the session flow facade over existing workflow files.
6. CBF05 verify/finish debug autostart boundary.
7. CBF06 pilot and final verification bundle.

Do not start CBF02 before CBF04 is complete unless CBF04 is explicitly folded
into the same implementation slice and its acceptance criteria are also met.

## Target Ownership

### Runtime Readiness Owner

Owner:

```text
packages/app/src/app/context/runtime-owner.ts
packages/app/src/app/context/workspace-runtime-controller.ts
```

Responsibilities:

- Report whether a workspace runtime is actually ready.
- Keep background warmup state separate from user-initiated send state.
- Expose a read-policy input that tells session selection whether live SDK reads
  are allowed.

Must not:

- Use one global `engineReady` boolean to mean both runtime availability and
  "the user explicitly brought the engine up".
- Let background warmup alone opt normal history browsing into live SDK reads.

### Session Flow Facade

Preferred new facade boundary:

```text
packages/app/src/app/context/session-flow-facade.ts
```

This facade can initially wrap existing helpers instead of moving all code at
once. It is not the final business owner by itself; the durable logic remains in
the workflow/controller files until later slices move more behavior behind this
boundary.

Responsibilities:

- Accept user intents:
  - submit draft
  - queue draft
  - open session
  - create session for an explicit command
- Own pending-session instance keys.
- Own pending-to-real session materialization.
- Own queue drain decisions.
- Own route/session transition decisions that are part of first-send handoff.

Must not:

- Render UI.
- Depend on Solid component effects to continue the program.
- Make `SessionView` decide when to drain queued work.

### UI Components

Primary UI file:

```text
packages/app/src/app/pages/session.tsx
```

Responsibilities after this plan:

- Render current flow state.
- Submit user intents to the session flow facade.
- Display owner-provided loading, optimistic, and error state.

Must not:

- Call `drainNextQueuedDraft` from effects.
- Remap pending queues from route/selection effects.
- Auto-create sessions as an implementation detail of visual controls unless
  that action goes through the session flow facade.

## CBF00: Link Issue And Freeze Baseline

done: false

Goal:

Create the durable issue link and baseline contract before agents start moving
flow ownership.

Implementation:

- Link the real issue id in this plan front matter.
- Keep the current runtime cold-start plan as dependency:

```text
docs/plans/2026-07-03-runtime-cold-start-session-handoff-kiss-plan.md
```

- Add a short baseline note under this section with:
  - current branch/worktree commit
  - relevant dirty files
  - whether `runtime-cold-start-session-handoff` pilot is currently passing
  - whether this plan is intended to replace or follow the existing RSH plan

Focused verification:

```powershell
git status --short --branch
```

Done when:

- `issue:` is not `unlinked`.
- `cbf00_issue_and_baseline_done: true`.
- This section has a dated note with the baseline evidence.

## CBF01: Split Runtime Readiness From Browse Policy

done: true

Goal:

Fix the `engineReady` semantic drift found in the audit.

Problem:

`engineReady` comments and session read policy still describe it as "the user
explicitly brought the engine up through sendPrompt", but boot warmup can now
set it to true without a send. This can make normal session browsing take a
live SDK `session.messages` path just because background warmup completed.

Implementation:

- Replace or narrow legacy `engineReady` usage with explicit concepts:
  - workspace runtime ready
  - user/send activated runtime
  - live conversation read allowed
  - background warmup in progress/done
- Update the stale comments in:

```text
packages/app/src/app/app.tsx
packages/app/src/app/context/session.ts
```

- Make `sessionReadPolicy` depend on explicit browse/read policy, not on the old
  global `engineReady` meaning.
- Preserve the existing good behavior:
  - cold history browsing should prefer offline transcript data
  - active scoped recovery may use live SDK reads when the policy explicitly
    allows recovery
  - send-time runtime readiness still uses `runtime-owner`
- Update source-contract tests that currently encode the stale meaning.

Focused tests:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/app-boot-engine-ready.test.ts src/app/tests/context/runtime-owner.test.ts src/app/tests/context/session-selection-controller.test.ts src/app/tests/context/session-select-background-hydration.test.ts src/app/tests/pages/session-navigation.test.ts
```

Done when:

- Background warmup can mark the runtime ready without implying
  user/send-activated browse policy.
- A test proves boot-warmup readiness alone does not force ordinary local
  sidebar/history selection into live `session.messages`.
- `cbf01_runtime_readiness_semantics_done: true`.

2026-07-03 note:

- Added workspace-scoped `liveTranscriptReadWorkspaceIds` in `app.tsx`.
- `shouldBrowseSessionFromDb` now gates ordinary live transcript reads on
  explicit send-flow allowance instead of `isWorkspaceRuntimeReady`.
- `session-send-workflow.ts` marks the send target workspace live-read-allowed
  only after a successful user send.
- `session-selection-controller.ts` now skips live SDK session-list fallback
  while the workspace runtime is not ready.
- `sidebar-workspace-sessions.ts` now gates local sidebar live session-list
  fallback on the same explicit live-read allowance, so host-first sidebar
  hydration cannot silently reintroduce a cold-start `c.session.list` path.
- Updated stale `engineReady` comments in `app.tsx` and `session.ts`.
- Verification passed:
  - `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/app-boot-engine-ready.test.ts src/app/tests/context/runtime-owner.test.ts src/app/tests/context/session-selection-controller.test.ts src/app/tests/context/session-select-background-hydration.test.ts src/app/tests/pages/session-navigation.test.ts src/app/tests/pages/session-send-workflow.test.ts`
  - `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-selection-controller.test.ts src/app/tests/app-send-latency-trace.test.ts`
  - `pnpm --filter @neatech/veslo-ui typecheck`

## CBF04: Separate Runtime Recovery From UI Busy Presentation

done: true

Goal:

Make runtime recovery return state to the flow facade/workflow boundary instead of directly
mutating active UI busy state.

Problem:

`send-runtime-readiness.ts` owns useful runtime recovery but also calls UI
setters such as `setBusy`, `setBusyLabel`, `setBusyStartedAt`, and legacy
`setEngineReady`.

Implementation:

- Change runtime readiness helpers to return a typed result such as:

```ts
type SendRuntimePreparationResult =
  | { ok: true; runtimeReady: true; workspaceId: string }
  | { ok: false; reason: string; workspaceId?: string };
```

- Let the session flow facade/workflow boundary translate runtime preparation into UI busy labels
  and optimistic state.
- Keep runtime state updates in the runtime owner, not as page/UI setters.
- Preserve active-workspace-only UI behavior: recovery for a background target
  workspace must not show active workspace busy UI.

Focused tests:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/send-runtime-readiness.test.ts src/app/tests/context/workspace-runtime-controller-source.test.ts src/app/tests/pages/session-send-workflow.test.ts
```

Done when:

- `send-runtime-readiness.ts` no longer directly owns active UI busy labels.
- Runtime readiness failures still block sends correctly.
- Active/background workspace behavior remains covered by tests.
- `cbf04_send_runtime_readiness_boundary_done: true`.

2026-07-03 note:

- Added `SendRuntimePreparationResult` and
  `ensureLocalRuntimeReachableForSendResult`.
- Kept the existing boolean `ensureLocalRuntimeReachableForSend` wrapper for
  current call sites.
- `prepareSendRuntimeForSend` now consumes the typed result and records blocked
  runtime failures with `runtimeReason`, `runtimeRecoveryAttempted`, and target
  workspace id.
- Removed `setBusy`, `setBusyLabel`, and `setBusyStartedAt` from
  `SendRuntimeReadinessDeps`; runtime recovery no longer directly owns active
  UI busy presentation.
- Legacy active-runtime setters `setEngineReady` and `setSseConnected` remain
  for the current runtime route state contract. Removing those belongs to the
  broader owner migration, not this busy-presentation slice.
- Verification passed:
  - `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/send-runtime-readiness.test.ts src/app/tests/context/workspace-runtime-controller-source.test.ts src/app/tests/pages/session-send-workflow.test.ts`
  - `pnpm --filter @neatech/veslo-ui typecheck`

## CBF03: Remove Program Flow From SessionView Effects

done: true

Goal:

Make `SessionView` render and dispatch intents, not continue cold-start/session
program flow from reactive effects.

Implementation:

- Remove direct queue-drain decisions from effects watching:
  - `props.selectedSessionId`
  - `props.sessionStatus`
  - `props.sessionStatusById`, if it triggers the same flow
- Move those decisions into the session flow facade and conversation-flow
  controller.
- UI may notify the facade that selection/status changed, but the controller
  must own the resulting queue action.
- Keep visual-only side effects in `SessionView`, such as search reset,
  scroll/anchor hints, and local display state, if they do not drive runtime or
  queue progression.
- Add source tests that reject new `drainNextQueuedDraft` calls inside
  `session.tsx` reactive effects.

Files to audit:

```text
packages/app/src/app/pages/session.tsx
packages/app/src/app/pages/session-conversation-flow.ts
packages/app/src/app/pages/session-pending-instance.test.ts
```

Focused tests:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-pending-instance.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-inline-loading.test.ts
```

Done when:

- `SessionView` no longer directly calls `drainNextQueuedDraft`.
- Selection/status changes are handled through an owner API.
- A source-contract test protects this boundary.
- `cbf03_ui_effects_intents_only_done: true`.

2026-07-03 note:

- Moved selected-session, active-status, and status-map queue-drain decisions
  into `createSessionConversationFlow`.
- `SessionView` now only reports selection/status changes through
  `handleSelectedSessionChanged`, `handleActiveSessionStatusChanged`, and
  `handleSessionStatusMapChanged`.
- Removed the `SessionView` `drainNextQueuedDraft` alias and all direct
  `drainNextQueuedDraft(` calls from `session.tsx`.
- Updated source-contract tests to require the owner API and reject direct
  queue draining in `SessionView`.
- Verification passed:
  - `rg -n "drainNextQueuedDraft\(" packages/app/src/app/pages/session.tsx`
    returned no matches.
  - `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-pending-instance.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-inline-loading.test.ts src/app/tests/pages/session-view-modularization.test.ts`
  - `pnpm --filter @neatech/veslo-ui exec tsc -p tsconfig.json --noEmit --pretty false`

## CBF02: Introduce Session Flow Owner For First-Send Handoff

done: true

Goal:

Move first-send pending handoff ownership out of page-level workflows and into a
background/context owner.

Implementation:

- Add a narrow facade API, preferably:

```text
packages/app/src/app/context/session-flow-facade.ts
```

- The first version may delegate to existing implementation files, but the
  facade API must become the call boundary for:
  - `sendPromptImmediate`
  - pending session instance allocation
  - pending sidebar metadata
  - `onMaterializedSessionId`
  - pending-to-real queue remap
  - create-session-and-send handoff
- Keep `workspace-runtime-controller.ts` as the only engine-start owner.
- Call runtime preparation through the typed CBF04 result boundary, not through
  helper APIs that directly mutate UI busy setters.
- Do not introduce tiny helper sprawl. Prefer one coarse owner with focused
  model/helper functions where tests already exist.

Focused tests:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-conversation-flow.test.ts src/app/pages/session-pending-instance.test.ts src/app/tests/pages/session-send-workflow.test.ts src/app/tests/pages/session-inline-loading.test.ts
```

Done when:

- CBF04 is already done, or this same implementation slice also satisfies all
  CBF04 acceptance criteria.
- The first-send path enters through the session flow facade.
- Pending-to-real materialization no longer depends on `SessionView` as the
  program owner.
- Existing optimistic pending-session behavior is preserved.
- `cbf02_session_handoff_owner_done: true`.

2026-07-03 note:

- Added `packages/app/src/app/context/session-flow-facade.ts`.
- App-level first-send entrypoints now expose `sendPrompt` and `abortSession`
  through `createSessionFlowFacade` instead of directly exposing
  `sessionSendWorkflow`.
- `SessionView` now creates a `createSessionViewFlowFacade` port over the
  conversation-flow controller and calls that facade for submit, cancel/retry,
  queue edits, selected-session changes, and status-change queue flow.
- Existing heavy workflow implementations remain delegated to
  `session-send-workflow.ts`, `session-creation-workflow.ts`, and
  `session-conversation-flow.ts`; this slice only establishes the context
  facade boundary.
- Verification passed:
  - `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-flow-facade.test.ts src/app/tests/app-refactor-contracts.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/pages/session-pending-instance.test.ts src/app/tests/pages/session-send-workflow.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-inline-loading.test.ts src/app/tests/pages/session-view-modularization.test.ts`
  - `pnpm --filter @neatech/veslo-ui typecheck`

## CBF05: Finish Debug Autostart Boundary Verification

done: true

Goal:

Prevent debug/manual-runtime behavior from depending on UI mount/onboarding
timing.

Problem:

Debug-only native orchestrator autostart waits for UI/onboarding timing before
starting scratch runtime. That can hide or distort cold-start ownership during
manual/E2E audits. The env gate and runner default are already present in the
current diff, so this task is a finish-and-verify step.

Implementation:

- Verify the existing `VESLO_DISABLE_DEV_AUTOSTART` gate in:

```text
packages/desktop/src-tauri/src/commands/engine.rs
```

- Verify the existing pilot runner wiring sets
  `VESLO_DISABLE_DEV_AUTOSTART=1` for scenarios that do not explicitly test
  debug autostart.
- Check whether `runtime-cold-start-session-handoff.toml` needs explicit
  scenario metadata or whether runner defaulting is enough.
- Replace the UI timing comment with runtime-owned coordination language, or
  remove the delayed autostart path if it is no longer required.
- Add or adjust only missing Rust/E2E tests. Do not duplicate the existing env
  gate implementation.

Files to audit:

```text
packages/desktop/src-tauri/src/commands/engine.rs
packages/e2e/helpers/pilot-runner.ts
packages/e2e/pilot-scenarios/runtime-cold-start-session-handoff.toml
```

Focused tests:

```powershell
pnpm --filter @neatech/veslo-e2e exec node --test --import=tsx/esm helpers/pilot-runner.test.ts
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml dev_autostart
```

Done when:

- Runtime cold-start pilots cannot pass because debug autostart won a UI timing
  race.
- Native debug autostart is either disabled for those pilots or coordinated by
  runtime state only.
- The plan has a dated note saying whether this task was already satisfied by
  the current diff or which remaining scenario/test gap was fixed.
- `cbf05_debug_autostart_boundary_done: true`.

2026-07-03 note:

- Verified the existing Rust env gate:
  `VESLO_DISABLE_DEV_AUTOSTART` truthy values disable debug dev autostart.
- Verified pilot-runner wiring: `runtime-cold-start-session-handoff` sets
  `VESLO_DISABLE_DEV_AUTOSTART=1` through scenario selection.
- `runtime-cold-start-session-handoff.toml` does not need extra metadata; the
  runner default is already scenario-specific.
- Replaced the stale dev-autostart comment that referenced UI/onboarding timing
  with runtime-startup coordination language.
- Verification passed:
  - `pnpm --filter @neatech/veslo-e2e exec node --test --import=tsx/esm helpers/pilot-runner.test.ts`
  - `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml dev_autostart`

## CBF06: End-To-End Regression And Boundary Verification

done: true

Goal:

Prove the refactor kept behavior while changing ownership.

Required verification:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-bootstrap-nonblocking.test.ts src/app/tests/context/workspace-engine-warmup.test.ts src/app/tests/context/workspace-runtime-controller-source.test.ts src/app/tests/context/send-runtime-readiness.test.ts src/app/tests/context/session-selection-controller.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/pages/session-pending-instance.test.ts src/app/tests/pages/session-inline-loading.test.ts src/app/tests/pages/session-message-queue.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-flow-facade.test.ts src/app/tests/app-refactor-contracts.test.ts
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui build
pnpm --filter @neatech/veslo-e2e exec node --test --import=tsx/esm helpers/pilot-runner.test.ts
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml dev_autostart
pnpm --filter @neatech/veslo-e2e test:pilot -- --scenario runtime-cold-start-session-handoff
git diff --check
```

Boundary checks:

- `SessionView` submits intents and renders state; it does not own queue drain.
- `runtime-owner` owns runtime readiness.
- session read policy is explicit and tested.
- first-send pending-to-real materialization is owned by the flow facade and
  conversation-flow controller boundary.
- debug autostart does not participate in installed cold-start pilots.

Verification note - 2026-07-03:

- PASS: UI regression bundle including runtime warmup/readiness, session
  selection, conversation flow, pending instance, inline loading, queue,
  session-flow-facade, and app refactor contract tests passed with 156 tests.
- PASS: `pnpm --filter @neatech/veslo-ui typecheck`.
- PASS: `pnpm --filter @neatech/veslo-ui build`.
- PASS: `pnpm --filter @neatech/veslo-e2e exec node --test --import=tsx/esm helpers/pilot-runner.test.ts`
  passed with 19 tests.
- PASS: `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml dev_autostart`
  passed with 1 test. Rust warnings were pre-existing/unrelated.
- PASS: `git diff --check` reported no whitespace errors; it printed existing
  CRLF normalization warnings for touched working-copy files.
- BLOCKED: `pnpm --filter @neatech/veslo-e2e test:pilot -- --scenario runtime-cold-start-session-handoff`
  failed after approximately 165s, so CBF06 remains `done: false`.
  The CBF05 boundary did hold: pilot output included
  `[dev-autostart] disabled by VESLO_DISABLE_DEV_AUTOSTART`. The scenario
  reached `[1/5] root exists`, `[2/5] enable runtime handoff diagnostics`, and
  `[3/5] start cold-start handoff task`, then failed at
  `[4/5] runtime cold-start handoff task finished` and skipped
  `[5/5] runtime cold-start handoff task succeeded`. Blocking log strings:
  `createConversationFromVesloWriteApi:create:error`,
  `"message":"OpenCode request timed out"`,
  `createSessionAndOpen:veslo-conversation-create:error`,
  `createSessionAndOpen:create-error`, `sendPrompt:blocked-no-session`, and
  final tauri-pilot error `Server closed the connection`. Before the failure,
  boot warmup did start and reattach the engine:
  `ensure-engine:success` with reason `boot-warmup`, followed by
  `ensure-engine:load-sessions:skipped`.

Verification note - 2026-07-03, rebuilt installed artifacts:

- PASS: `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-selection-controller.test.ts src/app/tests/app-send-latency-trace.test.ts`
  passed with 38 tests.
- PASS: `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/runtime-owner.test.ts`
  passed with 8 tests.
- PASS: the larger CBF UI bundle passed with 185 tests:
  `workspace-bootstrap-nonblocking`, `workspace-engine-warmup`,
  `workspace-runtime-controller-source`, `send-runtime-readiness`,
  `session-selection-controller`, `app-send-latency-trace`,
  `session-conversation-flow`, `session-pending-instance`,
  `session-inline-loading`, `session-message-queue`,
  `session-flow-facade`, `runtime-owner`, and `app-refactor-contracts`.
- PASS: `pnpm --filter @neatech/veslo-ui typecheck`.
- PASS: `pnpm --filter @neatech/veslo-ui build`; Vite printed only existing
  bundle/chunk warnings.
- PASS: `pnpm --filter @neatech/veslo run prepare:sidecar -- --force`.
  Sidecar outputs were rebuilt, and the OpenCode sidecar was already present
  at `1.17.4`.
- PASS: `pnpm --filter @neatech/veslo exec tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e`.
  This is required before the pilot; `tauri.dev.conf.json` produces the
  `com.neatech.veslo.dev` pilot pipe and is not a valid artifact for this
  e2e scenario.
- BLOCKED: after the forced sidecar rebuild and correct e2e Tauri rebuild,
  `pnpm --filter @neatech/veslo-e2e test:pilot -- --scenario runtime-cold-start-session-handoff`
  still failed: `3 passed`, `1 failed`, `1 skipped` in `94.067s`.
- PASS boundary evidence: runtime trace did not show an early
  `GET /workspace/.../opencode/session?...limit=20` before send. The first
  `/opencode/session` entry was the send-owned
  `POST /workspace/ws-ef57f20e8102/opencode/session` with trace id
  `send_e587ef61-bc95-433c-8aa4-fdf04c62f730`.
- PASS boundary evidence: the send-owned POST reached orchestrator
  `proxy-ensure:done` in `1ms`, targeting `http://127.0.0.1:62343/session`,
  and health probes continued returning `200`.
- BLOCKER: the send-owned create-session POST did not return before
  `OPENCODE_SESSION_CREATE_TIMEOUT_MS` (`60_000ms`). UI logs show
  `createConversationFromVesloWriteApi:create:error`,
  `createSessionAndOpen:veslo-conversation-create:error`,
  `sendPromptImmediate:result`, and `"OpenCode request timed out"`.
  Pilot step `[4/5] runtime cold-start handoff task finished` failed and
  `[5/5] runtime cold-start handoff task succeeded` was skipped.
- BLOCKER evidence: isolated `opencode.log` for the same run reaches
  `creating instance`, `bootstrapping`, and config loading for the visual
  workspace, but records no `/session` success or explicit engine error before
  the server-side timeout.
- PASS cleanup: after the failed pilot, no `veslo`, `veslo-server`,
  `veslo-orchestrator`, `veslo-code-router`, `veslo-code`, or `tauri-pilot`
  process remained from the run.

Verification note - 2026-07-03, live DEN Tauri pilot passing:

- PASS: launched the installed/debug E2E Tauri path through the pilot runner,
  not through raw OpenCode CLI:
  `pnpm --filter @neatech/veslo-e2e test:pilot -- --scenario runtime-cold-start-session-handoff`.
- PASS: run used an isolated profile:
  `E2E_OPENCODE_HOME=C:\Users\jajse\AppData\Local\Temp\veslo-e2e-live-auth-20260703160039`.
- PASS: run used the real desktop auth snapshot:
  `VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE=C:\Users\jajse\.veslo\den-auth.json`,
  whose `authJson.user.email` is `david.kral@neatech.cz`.
- PASS: managed AI fixture was disabled for the run with
  `E2E_MANAGED_AI_GATEWAY_FIXTURE=0`; the scenario used live DEN routing.
- PASS: debug dev autostart boundary held; output included
  `[dev-autostart] disabled by VESLO_DISABLE_DEV_AUTOSTART`.
- PASS: the Tauri pilot scenario completed:
  `5 passed`, `0 failed`, `0 skipped` in `49.820s`.
- PASS: Veslo automations stayed disabled during the pilot profile:
  `activeAutomationPluginExists=false`,
  `.opencode/plugins/veslo-automations.js.disabled` existed, and the
  materialized `veslo-automations` skill contained the
  `Veslo Automations Disabled` marker.
- NOTE: app logs still included
  `AI gateway provider request did not start within 30000ms`; this no longer
  blocks the cold-start handoff regression because the scenario reached the
  success marker, but it remains useful follow-up evidence for the live
  inference/gateway-start path if it reproduces outside this pilot.

Verification note - 2026-07-03, corrected live login and automation-off pilot:

- PASS: reran the same pilot through the Tauri pilot runner with
  `E2E_OPENCODE_HOME=C:\Users\jajse\AppData\Local\Temp\veslo-e2e-live-auth-20260703161139`.
- PASS: preflight parsed the desktop auth snapshot as nested JSON and verified
  `authEmail=david.kral@neatech.cz`,
  `denApiBase=https://api.veslo.work`, and `hasToken=True`.
- PASS: automations were explicitly disabled with
  `VESLO_ENABLE_AUTOMATIONS=0` and `VESLO_ENABLE_AUTOMATIONS_PLUGIN=0`.
- PASS: the scenario launched the expected debug Tauri binary:
  `packages\desktop\src-tauri\target\debug\veslo.exe`.
- PASS: the Tauri pilot scenario completed:
  `5 passed`, `0 failed`, `0 skipped` in `49.795s`.
- PASS: the isolated workspace profile had no active
  `.opencode/plugins/veslo-automations.js`; it had only
  `.opencode/plugins/veslo-automations.js.disabled`, and the materialized
  platform skill was the inert `Veslo Automations Disabled` marker.
- NOTE: live inference still produced
  `AI gateway provider request did not start within 30000ms`; this reproduces
  even with the correct DEN login and without the automation plugin, so the
  remaining issue is in the live gateway/provider-start path rather than pilot
  launch, login selection, or automation plugin loading.

Done when:

- All required verification is passing.
- This section has a dated verification note with exact command results.
- `cbf06_regression_verification_done: true`.
- Top-level `done: true` only after CBF00 through CBF06 are true.

## CBF-D1: Secondary UI Creation Trigger Cleanup

done: false

Goal:

Clean up non-core UI paths that still create sessions as a side effect.

Known examples:

- command palette create session action in `SessionView`
- `applySessionAgent` auto-creating a session when none is selected

Implementation:

- Route these through the session flow facade.
- Keep the same visible behavior unless product explicitly changes it.
- Do not block CBF00 through CBF06 unless one of these paths still reproduces
  the cold-start ownership bug.

Focused tests:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-navigation.test.ts src/app/tests/pages/session-conversation-flow.test.ts
```

Done when:

- Secondary UI actions no longer call session creation workflows directly.
- `cbfd1_secondary_ui_creation_followup_done: true`.
