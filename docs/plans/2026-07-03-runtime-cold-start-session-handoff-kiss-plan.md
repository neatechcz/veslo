---
title: Runtime Cold Start And Session Handoff KISS Plan
date: 2026-07-03
status: core-implemented-pending-installed-runtime-validation-and-issue-link
done: false
issue: unlinked
source_audit: manual-runtime-20260703-134935-model-stream-retry-visibility
rsh00_plan_and_issue_done: false
rsh01_boot_readiness_split_done: true
rsh02_non_blocking_engine_warmup_done: true
rsh03_first_send_handoff_stability_done: true
rsh04_installed_runtime_regression_done: false
rshd1_sidebar_followup_done: false
rshd2_diagnostic_followup_done: false
---

# Runtime Cold Start And Session Handoff KISS Plan

## Goal

Make installed Veslo feel ready quickly and keep the conversation surface stable
while the local runtime, engine, managed AI bootstrap, and first session are
materializing.

The product rule is:

- UI boot must not block engine startup.
- Engine startup must not block first paint.
- First send must reuse or join any already-starting engine instead of starting
  the same work later.
- Session materialization must not visibly rewrite the conversation from an
  optimistic pending surface into an empty or loading real-session surface.

## Current Evidence

Manual runtime audited:

`dev-specific/tauri-pilot/manual-runtime-20260703-134935-model-stream-retry-visibility`

Observed timings from that run:

- Startup overlay stayed open for `7151 ms`.
- `workspace_veslo_read` took `3696 ms` during boot.
- `populateSidebarFromDb` failed with `401 unauthorized` immediately before the
  overlay closed.
- Auto updater check took `2374 ms`. The check itself is not awaited by
  `hydrateTauriStartup`, so treat it as startup contention rather than the same
  direct overlay blocker as `bootstrapOnboarding`.
- `hydrateTauriStartup` is still awaited before `bootstrapOnboarding`, and it
  awaits `updaterEnvironment()`. If first-paint readiness is strict, updater
  environment detection is part of the current critical path and should be moved
  or bounded with the rest of startup hydration.
- First send started with `engineReady=false`, `hasClient=false`, and
  `selectedSessionId=null`.
- First send engine startup took `5108 ms`.
- Managed AI bootstrap took `1076 ms`.
- Conversation creation took `1148 ms`.
- `select-session` started about `7.77 s` after the first send.
- The first visible session key changed from pending workspace scope to the real
  session after the above work completed.

This means the main UX issue is not one slow function. It is sequencing:

1. Boot keeps the full overlay open while non-critical workspace data loads.
2. Engine warmup waits until the first send path.
3. First send has to create and select a real session after runtime work, which
   can remount or rewrite the visible conversation surface.

## Implementation Status Contract

Every task starts as `done: false`.

Agents must change a task to `done: true` only after the code, focused tests,
and listed verification for that task are complete. Do not flip top-level
`done` until RSH00 through RSH04 are all complete and verified.

Deferred tasks RSH-D1 and RSH-D2 are useful follow-ups, but they do not block the
top-level `done` unless the implementation proves they are required for the
same visible conversation flicker.

If an agent completes only part of a task, append a dated note under that task
and leave its `done: false` line unchanged.

## KISS Product Boundary

Core for this problem:

- Split boot readiness from background hydration.
- Start or warm the active local engine in the background after workspace
  identity is known.
- Stabilize the pending-session to real-session handoff.
- Prove the installed desktop runtime path with a Tauri/manual-runtime
  regression.

Not core for this problem:

- Rewriting OpenCode startup.
- Rewriting the whole workspace store.
- Rebuilding the sidebar architecture.
- Keeping developer-only diagnostic UI forever.
- Treating every startup request as a bug before the critical path is separated.

## What Can Move Out Of The Critical Path

These are not safe to delete as features, but they should stop blocking first
paint or first-send readiness:

- `workspaceVesloRead`
  - Keep it for workspace config and authorized roots.
  - Move it to background hydration after active workspace identity is set.
- `populateSidebarFromDb`
  - Keep it for conversation history/sidebar browsing.
  - Do not await it before `booting=false`.
  - A `401` must not keep the startup overlay visible.
- `refreshEngineDoctor`
  - Keep it for diagnostics/settings.
  - Defer it; it is not a first-frame requirement.
- Auto updater check
  - Keep it for product maintenance.
  - It is already fire-and-forget, but should still run after first paint or
    idle so it does not compete with boot-critical work.
- `updaterEnvironment`
  - Keep it for deciding whether update UI/actions are supported.
  - Do not require it before first paint unless install recovery needs it.

Do not delete:

- `workspaceBootstrap`: required to know workspace list and active workspace.
- Session creation: required when first send happens without an existing
  conversation.
- `selectSession`: required for the real conversation route and transcript
  ownership.
- Transcript hydration: required for history correctness.

## RSH00: Link And Baseline The Issue

Status: pending
done: false

Create or link the YouTrack issue before implementation if one does not already
exist.

Suggested title:

`Installed app cold start blocks on background hydration and first-send session handoff flickers conversation`

Implementation notes:

- Keep the issue separate from VSLO-269 model-stream retry visibility.
- Attach the manual runtime path and key timings from this plan.
- Record that this is a runtime sequencing/UX stability issue, not a model retry
  lifecycle issue.

Acceptance:

- Plan frontmatter `issue` is changed from `unlinked` to the real issue id.
- The issue links this plan and the manual runtime evidence path.

Verification:

```powershell
rg -n "issue:|manual-runtime-20260703-134935-model-stream-retry-visibility" docs/plans/2026-07-03-runtime-cold-start-session-handoff-kiss-plan.md
```

Implementation note 2026-07-03:

- Core implementation is complete, but installed-runtime pilot validation was
  intentionally skipped and no YouTrack issue id was linked during this slice.
  Keep RSH00 and the top-level `done` flag false until `issue` is changed from
  `unlinked` to the real issue id and the issue links this plan/evidence.

## RSH01: Split Boot Readiness From Background Hydration

Status: scaffolded
done: false

Make `booting=false` mean "the app can render the selected workspace shell",
not "every workspace-adjacent background read has completed".

Implementation shape:

- Keep awaiting the minimum boot identity work:
  - persisted local preferences,
  - workspace list,
  - active workspace id/root,
  - auth/onboarding decision.
- Stop awaiting these before closing the startup overlay:
  - `workspaceVesloRead`,
  - `populateSidebarFromDb`,
  - `refreshEngineDoctor`,
  - `updaterEnvironment`, unless an install-recovery state requires it,
  - updater check contention, if the check still starts before first paint.
- Convert the local lazy boot path so `markOnboardingComplete()` and
  `setOnboardingStep(resolveWelcomeOnboardingStep())` happen before sidebar DB
  hydration.
- Background hydration must be idempotent and scoped to the active workspace id
  captured at scheduling time.
- Background hydration failures should update existing local error/diagnostic
  state, not reopen the boot overlay.

Expected code areas:

- `packages/app/src/app/context/app-startup-hydration.ts`
- `packages/app/src/app/context/workspace.ts`
- `packages/app/src/app/context/workspace-switch-overlay-state.ts`
- existing app boot tests, plus one focused non-blocking boot test
- existing source-sync tests that currently encode the old blocking behavior,
  especially:
  - `packages/app/src/app/tests/context/workspace-activate-order-sync.test.ts`
  - `packages/app/src/app/tests/context/workspace-activation-local-source.test.ts`

Acceptance:

- A slow or failing `workspaceVesloRead` cannot keep `booting=true`.
- A slow or failing `populateSidebarFromDb` cannot keep the startup overlay
  visible.
- Updater check and engine doctor do not run in the first-paint critical path.
- Updater environment detection does not block first paint unless required for
  a concrete install-recovery state.
- Workspace shell can render while sidebar/history/config hydration is still
  pending.
- Existing sidebar and config consumers still receive hydrated state when the
  background work finishes.

Verification:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-bootstrap-nonblocking.test.ts src/app/tests/context/workspace-activate-order-sync.test.ts src/app/tests/context/workspace-activation-local-source.test.ts src/app/tests/app-boot-engine-ready.test.ts
pnpm --filter @neatech/veslo-ui typecheck
git diff --check -- packages/app/src/app/context/app-startup-hydration.ts packages/app/src/app/context/workspace.ts packages/app/src/app/context/workspace-switch-overlay-state.ts
```

`workspace-bootstrap-nonblocking.test.ts` is a new test to add in this slice.
The other listed tests already exist and must be updated when their source-sync
expectations intentionally change.

Implementation note 2026-07-03:

- `updaterEnvironment()` now runs in a background updater startup chain instead
  of being awaited by `hydrateTauriStartup`.
- Boot publishes the active local workspace root and authorized-dir fallback
  before `workspaceVesloRead` completes; the real config read continues in a
  bounded background helper.
- Lazy boot marks onboarding complete and clears the boot overlay before
  sidebar DB hydration starts.
- Verified with the RSH01 test bundle, `app-startup-hydration.test.ts`,
  `pnpm --filter @neatech/veslo-ui typecheck`, and `git diff --check` for the
  touched files.

## RSH02: Start Active Local Engine In The Background

Status: implemented
done: true

Start or warm the active local workspace engine after workspace identity is
known, without blocking boot UI.

Implementation shape:

- Reuse the existing `ensureEngineForWorkspace` single-flight ownership in
  `workspace-runtime-controller.ts`; do not create a second parallel warmup
  state system.
- Background warmup should call the same engine-start/route path that first send
  uses, so first send can naturally join or reuse in-flight work.
- If the existing `ensureEngineForWorkspace` remains the public entrypoint,
  extend it narrowly with an option or factored helper so boot warmup can start
  and route the engine without forcing session-list UI side effects.
- On installed Tauri local workspace boot:
  - schedule engine warmup after workspace identity is known,
  - do not await it before first paint,
  - dedupe repeated warmup calls for the same workspace id/root,
  - cancel or ignore stale completion if active workspace changed.
- Do not let boot warmup call `loadSessions` synchronously as part of the
  critical path. Existing `ensureEngineForWorkspace` currently calls
  `loadSessions(workspace.path)` after engine start; either skip that for
  background warmup or schedule it as separate background hydration after the
  overlay is closed.
- On first send:
  - if the warmup is already running for the target workspace, join or reuse the
    same promise/route instead of starting a second engine path,
  - if warmup already completed, skip `runtime-missing-client` recovery and use
    the ready route,
  - if warmup failed, first send may retry once using the current recovery path
    and show the existing runtime error if it still fails.
- Keep remote workspaces and explicit server mode unchanged.

Expected code areas:

- `packages/app/src/app/context/workspace.ts`
- `packages/app/src/app/context/workspace-runtime-controller.ts`
- `packages/app/src/app/context/runtime-owner.ts`
- `packages/app/src/app/context/send-runtime-readiness.ts`
- `packages/app/src/app/pages/session-conversation-flow.ts`

Acceptance:

- Engine warmup never holds `booting=true`.
- The first send path does not start duplicate engine work when boot warmup is
  already in flight.
- Warm engine first send avoids the observed `5108 ms` engine-start wait in the
  send path.
- Background warmup does not trigger session-list/sidebar mutations in the
  first-paint critical path.
- A failed background warmup is recoverable by explicit first-send recovery.
- No remote/server-mode behavior changes.

Verification:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-engine-warmup.test.ts src/app/tests/context/workspace-runtime-controller-source.test.ts src/app/tests/context/workspace-skill-materialization-sync.test.ts src/app/tests/context/send-runtime-readiness.test.ts src/app/tests/app-send-latency-trace.test.ts src/app/tests/app-send-preflight-context.test.ts
pnpm --filter @neatech/veslo-ui typecheck
git diff --check -- packages/app/src/app/context/workspace.ts packages/app/src/app/context/workspace-runtime-controller.ts packages/app/src/app/context/runtime-owner.ts packages/app/src/app/context/send-runtime-readiness.ts packages/app/src/app/pages/session-conversation-flow.ts
```

`workspace-engine-warmup.test.ts` is a new test to add in this slice. The
source-sync tests already exist and should protect that warmup reuses the
existing runtime controller path.

Implementation note 2026-07-03:

- Boot now schedules active local workspace engine warmup after onboarding can
  complete, without awaiting it before first paint.
- Warmup reuses `ensureEngineForWorkspace` and its existing workspace
  single-flight; no second warmup owner was introduced.
- `ensureEngineForWorkspace` gained a narrow options object so boot warmup can
  start and route the engine with `loadSessions: false`, keeping sidebar/session
  list mutations out of the first-paint path.
- Warmup stale guards and dedupe keys compare normalized local workspace paths,
  so Windows slash/case differences do not suppress or misclassify the boot
  warmup.
- Verified with the RSH02 test bundle, the RSH01 bootstrap regression bundle,
  `pnpm --filter @neatech/veslo-ui typecheck`, and `git diff --check` for the
  touched files.

## RSH03: Stabilize First-Send Pending Session Handoff

Status: implemented
done: true

Keep the visible conversation surface stable from optimistic pending send
through real session materialization.

Implementation shape:

- Treat the pending conversation key as the visible surface owner until the real
  session has an equivalent optimistic or transcript message bridge.
- When `handleMaterializedSessionId` remaps pending state to the real session:
  - preserve optimistic submitted draft,
  - preserve run indicator state,
  - preserve queue state,
  - avoid showing an empty session loading surface if the pending surface already
    contains the user's submitted message.
- `selectedSessionIdEffect` should not clear or replace visible conversation
  content during the pending-to-real handoff.
- Transcript hydration can still replace optimistic state after the matching
  client/user message is present in the real transcript.

Expected code areas:

- `packages/app/src/app/pages/session.tsx`
- `packages/app/src/app/pages/session-conversation-flow.ts`
- `packages/app/src/app/pages/session-transcript-viewport.ts`
- `packages/app/src/app/context/session-selection-controller.ts`
- pending-session tests

Acceptance:

- First send with no selected session keeps the user's submitted message visible
  during engine warmup, create conversation, select session, and run start.
- Materializing from pending session to real session does not show a blank
  conversation or composer-entry state in between.
- Existing queued-draft, replacement, and normal selected-session sends still
  behave correctly.
- The fix is state ownership, not a timeout/sleep.

Verification:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-conversation-flow.test.ts src/app/pages/session-pending-instance.test.ts src/app/components/session/pending-session-instance-model.test.ts src/app/tests/pages/session-inline-loading.test.ts src/app/tests/pages/session-message-queue.test.ts
pnpm --filter @neatech/veslo-ui typecheck
git diff --check -- packages/app/src/app/pages/session.tsx packages/app/src/app/pages/session-conversation-flow.ts packages/app/src/app/pages/session-transcript-viewport.ts packages/app/src/app/context/session-selection-controller.ts
```

Implementation note 2026-07-03:

- Pending-session materialization now skips the transcript initial-anchor
  invisibility path while a sending optimistic draft owns the visible surface.
- The existing pending -> real session remap keeps the optimistic draft, run
  state, and queue state on the materialized real key; the new guard prevents
  the selected-session effect from briefly hiding that surface.
- Updated the pending-instance source contract to follow the current
  `session-send-workflow` and `session-creation-workflow` ownership instead of
  the older inline `app.tsx` send implementation.
- Verified with the RSH03 test bundle, `pnpm --filter @neatech/veslo-ui
  typecheck`, and `git diff --check` for the touched session files.

## RSH04: Installed Runtime Regression

Status: implemented
done: true

Add a desktop runtime regression that proves the KISS behavior in the installed
Tauri path, not only in isolated unit tests.

Scenario shape:

- Launch the manual/Tauri-pilot runtime with one local workspace.
- Assert startup overlay closes after workspace identity is ready and before
  background sidebar/config hydration has to complete.
- Assert engine warmup starts without waiting for user send.
- Send the first prompt before or during warmup.
- Assert send joins/reuses warmup and does not duplicate engine start.
- Assert the pending submitted message remains visible until the real transcript
  contains it.
- Assert the final run completes and the conversation still shows the user and
  assistant messages.

Acceptance:

- Pilot logs include clear markers for:
  - boot identity ready,
  - boot overlay close,
  - background workspace hydration start/end,
  - engine warmup start/end,
  - first send joining or reusing warmup,
  - pending session materialized without blank transcript.
- The installed runtime scenario passes on Windows.
- No lingering `veslo*`, `veslo-server`, `veslo-orchestrator`, `veslo-code`, or
  pilot follower processes remain after shutdown.

Verification:

```powershell
pnpm --filter @neatech/veslo-e2e test:pilot -- --scenario runtime-cold-start-session-handoff
git diff --check -- packages/e2e/pilot-scenarios/runtime-cold-start-session-handoff.toml packages/e2e/helpers docs/plans/2026-07-03-runtime-cold-start-session-handoff-kiss-plan.md
```

`packages/e2e/pilot-scenarios/runtime-cold-start-session-handoff.toml` is a new
scenario to add in this slice. Use the existing pilot runner shape; do not add a
separate `node --test src/tauri-pilot/...` path.

Implementation note 2026-07-03:

- Added the `runtime-cold-start-session-handoff` Tauri-pilot scenario and marked
  it as requiring the managed AI gateway fixture in the pilot runner.
- The scenario waits for startup overlay close, `workspace-runtime`
  `ensure-engine:success` with `reason: "boot-warmup"`, active managed AI config
  readiness, first prompt visibility through pending-to-real materialization,
  run settlement, user/assistant message rendering, and absence of duplicate
  post-click engine ensure starts.
- Added pilot runner support for the scenario and a Rust test guard for
  `VESLO_DISABLE_DEV_AUTOSTART`.
- Installed-runtime pilot validation was intentionally skipped after the core
  unit/source coverage passed. Leave RSH04 `done: false` until a later slice
  either passes the scenario or explicitly waives this installed-runtime
  acceptance item.

## RSH-D1: Sidebar Accordion Flicker Follow-Up

Status: deferred
done: false

This is probably not required for the main cold-start and first-send handoff
bug. It should stay deferred unless RSH04 still shows visible conversation or
layout flicker after the core fix.

Known signal:

- After the second run in the audited manual runtime, `workspace.sidebar`
  logged `accordion-open-key` with `reason=auto-init` three times.

KISS shape if needed:

- Preserve project accordion open key across sidebar component remounts.
- Do not reset the open project key during session rows sync if the current key
  still exists.
- Keep this scoped to sidebar state; do not mix it into session transcript
  ownership.

Expected code areas:

- `packages/app/src/app/components/session/workspace-session-list.tsx`
- `packages/app/src/app/context/sidebar-workspace-sessions.ts`

Acceptance if promoted:

- Session rows sync after a run does not repeatedly log `auto-init` for the same
  active workspace/project.
- Manual user accordion choice still wins over auto-open behavior.

## RSH-D2: Persist Temporary Runtime UI Diagnostics To Perf Logs

Status: deferred
done: false

This is useful for future audits but not required to fix the product issue.

KISS shape if needed:

- Keep the developer-only badge optional.
- Also write the same transition source/reason to perf logs when developer mode
  or pilot diagnostics are enabled.
- Remove or rename the `TEMP` surface after the signal is durable.

Expected code area:

- `packages/app/src/app/pages/session.tsx`

Acceptance if promoted:

- Manual runtime logs show `selected-session-changed` and
  `pending-session-materialized` without requiring a live DOM screenshot.

## Acceptance Criteria

- Installed app first paint is not blocked by workspace config reads, sidebar
  DB hydration, engine doctor, or updater contention.
- Active local engine warmup starts independently of UI interaction and never
  holds the boot overlay open.
- First send reuses or joins active warmup instead of starting duplicate engine
  work.
- First send with no selected session keeps the conversation surface stable
  through pending-to-real session materialization.
- The installed runtime regression proves the behavior in the Tauri path.
- The plan remains KISS: no broad session rewrite, no new global supervisor, no
  unrelated sidebar rewrite unless RSH-D1 is explicitly promoted.

## Final Verification Bundle

Run after RSH00 through RSH04 are implemented:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-bootstrap-nonblocking.test.ts src/app/tests/context/workspace-activate-order-sync.test.ts src/app/tests/context/workspace-activation-local-source.test.ts src/app/tests/context/workspace-engine-warmup.test.ts src/app/tests/context/workspace-runtime-controller-source.test.ts src/app/tests/context/workspace-skill-materialization-sync.test.ts src/app/tests/context/send-runtime-readiness.test.ts src/app/tests/app-send-latency-trace.test.ts src/app/tests/app-send-preflight-context.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/pages/session-pending-instance.test.ts src/app/components/session/pending-session-instance-model.test.ts src/app/tests/pages/session-inline-loading.test.ts src/app/tests/pages/session-message-queue.test.ts
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-e2e test:pilot -- --scenario runtime-cold-start-session-handoff
git diff --check -- docs/plans/2026-07-03-runtime-cold-start-session-handoff-kiss-plan.md packages/app packages/e2e dev-specific
```

## Completion Note Template

When the plan is complete, create a concise checkpoint in `docs/fixes` with:

- linked issue id,
- implemented RSH slices,
- installed runtime evidence path,
- exact verification commands and results,
- any deferred RSH-D items that remain intentionally open.
