---
title: Sidebar Session Activity Projection Implementation Plan
date: 2026-07-13
status: implementation-in-progress
done: false
repository_snapshot: current veslo-main working tree
scope: app-local sidebar activity presentation only
audit_date: 2026-07-13
audit_decision_required: false
selected_branch: B-minimal-completion
b02_consumer_contract_done: true
b01_row_bound_reconciliation_done: true
b03_tauri_pilot_done: false
sai01_baseline_diagnostics_done: partial-and-violated
sai00_activity_identity_done: partial-missing-final-row-cleanup
sai02_projection_owner_done: partial-missing-stable-output-contract
sai03_sidebar_consumer_migration_done: implemented-unverified
sai04_regression_coverage_done: incomplete
sai05_row_remount_decision_done: false
---

# Sidebar Session Activity Projection Implementation Plan

## Canonical Status

done: false

The audit found no reproduced sidebar activity bounce, while the partially
landed projection introduced an unpruned durable-token state. Branch B is
selected: retain the already integrated projection boundary and complete only
B02 and B01 are implemented and verified with focused checks. B03 remains
required before completion because it is the real-desktop preservation check.
Branch A remains a conditional rollback path, not the default.

The scope remains app-local sidebar presentation only. It does not change the
durable conversation-run owner, OpenCode SSE routing, queue semantics, abort
semantics, transcript hydration, or any status/busy writer.

## Conditional goal (Branch B only)

Give the sidebar one UI-owned activity projection instead of making each row
combine several independently written runtime maps.

The resulting contract is:

```text
existing runtime evidence
  sessionStatusById
  workspaceBusy
  conversationRunDiagnosticsBySessionKey
  workspaceSessionGroups / aliases
        |
        v
SidebarSessionActivityProjection (only sidebar UI writer)
        |
        v
activityByRowKey[rowKey]
        |
        v
WorkspaceSessionList spinner and active-row presentation
```

The projection is not another run owner. It never writes `sessionStatusById`,
`workspaceBusy`, durable lifecycle state, or queues. It receives those as
read-only evidence and writes only a normalized sidebar presentation map.

There is exactly one app-level projection instance. `app.tsx` constructs it
once and passes its accessor through `AppViewProps` to both `Dashboard` and
`Session`, which in turn pass it to `WorkspaceSessionList`. No page or row
creates an independent projection.

## Audit finding: risk, not reproduced user-visible bug

The original problem statement overstated the evidence. Multiple runtime
mirrors are a valid architectural risk, but the inspected fresh runtime did
not show a false activity release while a send was still active.

The exact UI trace segment started at `2026-07-13T00:07:09.973Z`, after the
projection commit and before the later diagnostic filter commit. It contains
383 entries, of which 165 are sidebar activity transition writes. The current
inactive-to-inactive guard would suppress 152 of those writes and leave 13.
Three sends produced three activation/release pairs; none contains
`active -> inactive -> active` for the same running send.

The trace contains zero `sidebar-session-row:mount` or
`sidebar-session-row:unmount` events. That is not evidence that rows cannot
remount: the promised instrumentation was never added. It means row identity
is currently unclassified, not confirmed broken.

The activity trace volume is also not independent evidence for this plan. The
projection implementation introduced the sidebar transition trace, and the
default desktop development wrapper enables send-workflow tracing. A native
write has a real development cost (one IPC command plus append/flush/stderr
forwarding per entry), but no release workflow enables this trace and no
frame-drop was measured. The related trace-volume plan therefore remains
deferred until this plan's branch decision and a fresh post-filter baseline.

### Current implementation audit

| Area | Current state | Audit result |
| --- | --- | --- |
| Activity token | begin, migrate, and promote are wired before lifecycle admission | Partial: a committed durable token has no final-row removal/rekey cleanup. |
| Projection | a pure projection reads scoped status, busy state, diagnostics, and tokens | Partial: it allocates a new map each computation and does not implement the documented stable-output or `updatedAt` contract. Neither is a reproduced visual defect. |
| Sidebar consumer | Dashboard and Session pass one projection map; both spinner paths and project expansion read it | Implemented, but the old Dashboard source test still expects the retired direct props. |
| Diagnostics | transition tracing exists and filters inactive-to-inactive values | Partial: it is live, not shadow-only; no row mount/unmount tracing exists. |
| Coverage | focused suite is 124 passing / 1 failing | The only failure is the stale direct-prop expectation. Coverage does not exercise final-row token cleanup, rekey, equal-map reuse, or a desktop runtime scenario. |

The current source deliberately reads scoped status only. Existing normal
writers publish scoped values, so this audit found no cross-workspace
regression in that change. Lifecycle diagnostics are written to the full alias
set, so selecting the first matching diagnostic is also not a separate
observed defect.

## Existing Owners and Boundaries

- `session.ts` owns the app session store and its status/busy notification
  bridge.
- `session-event-stream.ts` owns app-side consumption of foreground and
  background OpenCode events.
- `session-lifecycle-recovery.ts` owns exact durable-run observation and
  reconciles status from an authoritative lifecycle result.
- `workspace.ts` / `workspace-busy-state.ts` own the cross-workspace busy
  mirror.
- `sidebar-workspace-sessions.ts` owns sidebar session data rows.
- `workspace-session-list.tsx` owns sidebar row rendering.

The new controller is a presentation adapter placed beside the existing
sidebar/session context owners. It must not move these ownership boundaries.

## Non-goals

- Do not replace `sessionStatusById` or `workspaceBusy` globally.
- Do not make the sidebar decide durable run completion.
- Do not add a time-based debounce that merely hides an incorrect idle event.
- Do not switch `<For>` to `<Index>`; index reuse would be incorrect when
  sessions reorder by activity.
- Do not refactor source status writers in this slice.
- Do not stabilize `FlatSessionRow` identity until diagnostics prove that row
  remounts are the remaining cause after the projection is live.

## Conditional target UI contract (Branch B only)

### Run / generation correlation precondition

A terminal diagnostic is retained after its watch ends, while a normal
`session.status` event has no `runId`. Therefore a terminal diagnostic plus a
running/busy mirror is ambiguous: it can mean either a stale mirror from the
completed run or a legitimate newer non-lifecycle run. The projection must
not try to infer that distinction from ordering or timestamps.

Before terminal authority is enabled, add a small, scoped sidebar activity
identity input. One token is owned by an **atomic alias set** (UI session ID,
OpenCode session ID, and conversation ID) for one workspace, rather than by
independent alias-map entries:

```ts
type SidebarActivityToken =
  | { kind: "durable"; runId: string; generation: number }
  | { kind: "local"; generation: number };
```

The model stores a canonical token record and an alias-to-canonical index
derived with the same `scopedSessionAliasKeys` helper used by lifecycle
diagnostics. Begin, alias migration, promotion, and removal update the entire
alias set in one batch; a projection lookup through any alias observes the
same token.

The existing send workflow advances the scoped generation synchronously when
it starts a user send, before that send can update sidebar presentation. It
then follows this explicit state transition:

```text
begin(pending aliases)
  -> migrate(final UI/OpenCode/conversation aliases on materialization)
  -> promote(submitted runId | queued reservedRunId)
  -> retain through terminal for correlation
```

A server-accepted `submitted` send promotes with `runId`; a `queued` send
promotes with its existing `reservedRunId`. The projection receives this token
as read-only evidence; it does not generate or mutate it.

Terminal authority is correlated as follows:

- a terminal lifecycle diagnostic releases the row only when its `runId`
  equals the current durable token's `runId` for that scoped alias;
- a terminal diagnostic for an older/different run is ignored for a newer
  durable token and for a current local token;
- if there is no current token, a terminal diagnostic cannot override a
  non-idle status/busy mirror; it may only describe an otherwise idle row;
- active lifecycle diagnostics are likewise usable only when their `runId`
  matches the current durable token, or when no newer token exists.

This is deliberately an additional UI evidence stream, not a rewrite of SSE
status writers or durable lifecycle ownership. It is the minimum information
needed to distinguish the two otherwise identical input states.

The projection is keyed by stable sidebar `rowKey` and contains only
presentation data:

```ts
type SidebarSessionActivity = {
  active: boolean;
  phase: "idle" | "submitted" | "running" | "blocked" | "error";
  source: "lifecycle" | "terminal-lifecycle" | "session-status" | "workspace-busy" | null;
  updatedAt: number;
};

type SidebarSessionActivityByRowKey = Record<string, SidebarSessionActivity>;
```

The controller evaluates all session aliases represented by a row: UI session
ID, OpenCode session ID, and conversation ID. Lifecycle authority is defined
solely from the existing diagnostic contract; it must not invent an
`updatedAt` convention:

- active lifecycle: `stale !== true` and status is `submitted`, `running`, or
  `blocked`;
- terminal lifecycle: `stale !== true` and status is `completed`, `failed`,
  or `aborted`;
- `stale === true` is never release authority and is ignored by the
  projection.

Its priority is:

1. a non-stale durable terminal lifecycle status correlated to the current
   activity token, which authoritatively clears activity even if an old
   status/busy mirror remains active;
2. a non-stale durable active lifecycle status;
3. non-idle **scoped-only** `sessionStatusById`;
4. matching workspace-scoped `workspaceBusy` entry;
5. otherwise idle.

The controller must retain the prior map object when the computed record for a
row is equal. It must write only when `active`, `phase`, or `source` changes;
`updatedAt` changes only with such a presentation transition. This prevents
status/busy mirror noise from becoming a sidebar UI update.

Terminal phase mapping is fixed:

- `completed` and `aborted` -> `{ active: false, phase: "idle", source:
  "terminal-lifecycle" }`;
- `failed` -> `{ active: false, phase: "error", source:
  "terminal-lifecycle" }`.

`error` is an inactive visual phase. It must not render the active spinner.

## Audit-gated execution

### Audit gate

Branch B is selected. Execute its slices in the stated order only; do not
merge rollback work into them. Green unit tests do not replace the required
desktop preservation check in B03.

#### Branch A - rollback only with its own regression proof

Do not select this merely because the change might be unshipped or because the
original bounce has not been reproduced. The projection is already integrated
in this checkout: both sidebar surfaces and project opening consume it.
Select rollback only after a release/consumer-scope review and a focused
regression case show that restoring direct mirrors preserves the required
behavior. B03 is the decisive preservation test for retaining the projection;
a failure there is a reason to evaluate this branch, not to roll back by
default.

1. Remove the activity-token model, projection, app/view prop wiring, and
   sidebar activity trace effect introduced by the partial implementation.
2. Restore the direct sidebar activity read for both render paths and
   `rowForcesProjectOpen` together. Do not restore only one of those paths.
3. Keep the persistent spinner wrapper only if it is adapted to the restored
   shared direct activity helper and its focused test stays green. This is an
   isolated visual continuity improvement, not evidence for a projection.
4. Do not execute the trace batching/priority plan. Once its producer is gone,
   take a new trace baseline before proposing transport work again.
5. Create a new plan only after a real Tauri runtime trace or pilot scenario
   demonstrates either a false `active -> inactive -> active` transition or a
   spinner restart while activity stayed true.

**Branch A acceptance:** direct activity semantics are identical in recent and
project views; no sidebar activity trace is emitted; the existing sidebar
source tests and app typecheck pass; no desktop runtime is launched merely to
make the rollback green.

#### Branch B - retain the projection and repair the real gap

This selected branch preserves the integrated UI boundary and completes only
the proven token-lifetime and consumer-test gaps. Batching, `updatedAt`, map
memoization, and row-identity work remain deferred.

##### B02 - repair the consumer contract and coverage (first)

**Owners:** Dashboard/Session view props, `WorkspaceSessionList`, and the
sidebar wiring test.

1. Replace the stale Dashboard test that expects direct
   `sessionStatusById`/`busySessionByWorkspaceId` props with an assertion for
   the single `sidebarSessionActivityByRowKey` prop.
2. Assert that both recent and grouped spinner paths plus
   `rowForcesProjectOpen` use that same projection helper.
3. Keep the executable test paths aligned with the checkout: the two sidebar
   activity tests live in `src/app/tests/context/`.
4. Keep the scoped-status collision test. It is the meaningful reason not to
   reintroduce the bare-ID fallback into the projection.

##### B01 - reconcile committed tokens against final sidebar rows (second)

**Owners:** the sidebar activity-token model and the app composition root.

The current token model retains each committed durable record indefinitely.
The only removal call is the send `finally` path for an uncommitted token. Add
one explicit reconciliation operation, for example `reconcileFinalRows(rows)`,
with this contract:

1. Its input is the final flattened rows built by the same
   `workspace-session-list-model.ts` path as the renderer, not raw groups.
2. It derives the full scoped alias set for every final row with the existing
   alias helper.
3. It removes a **durable** record only when none of its aliases are present
   in the current final row set. A rekey that retains a
   session/OpenCode/conversation alias must preserve the record.
4. A local pending token is not eligible for visibility pruning. Existing
   failure and materialization paths still own its removal/migration, so an
   intermediate pending-to-final render cannot delete it early.
5. It publishes only if records changed and does not clear all tokens on a
   workspace switch. The app observes final rows and invokes it after sidebar
   row updates; the projection itself stays pure.

This is **row-bound availability pruning**, not universal terminal cleanup: it
limits committed durable tokens to aliases still available as sidebar rows. A
still-present row retains its durable token until the existing terminal/run
correlation rules act; reconciliation must not infer completion from time,
workspace switches, or an otherwise unchanged row.

Add focused model cases for row removal, alias-preserving rekey, a pending
local token surviving an intermediate empty/final-row snapshot, and an
alias-collision during migration. The collision case must preserve the
replacement-generation winner atomically, leave no stale alias index, and not
prune a token merely because its aliases were rekeyed. Keep the existing tests
for alias migration, replacement generation, and terminal run correlation.

##### B03 - decisive preservation-of-functionality check

This is the decisive test that the already integrated projection preserves the
required sidebar behavior. Add one focused Tauri Pilot scenario or extend an
existing sidebar scenario. It must use a deterministic fixture to cover a
normal send followed by a row archive/removal or alias-preserving rekey. It
verifies the visible result only: the active row is released for its own
terminal run, the active child row still opens its project as before, and a
different visible row never gains that spinner. The B01 model tests support
this scenario but do not replace it.

After B02 and B01, take one fresh desktop trace with tracing enabled and three
short sends. Record the runtime start timestamp and analyse only that segment.
This trace is diagnostic evidence for the Pilot result, not a reason to add
performance work. The pass condition is:

- no initial inactive sidebar trace;
- exactly one activation and one terminal release per send in ordinary trace;
- no `active -> inactive -> active` sequence for one send;
- after archiving the terminal row, exactly one
  `sidebar-session-activity:token-pruned` event for its durable `runId`, and
  never before that row's terminal release;
- no claim about row remounts unless row instrumentation is deliberately
  added for a reproduced visual restart.

The normal `pnpm dev` wrapper already enables this trace and mirrors it to
`.tmp/send-workflow-trace.ui.ndjson`. The transition effect writes the
activation/release events; B01's final-row reconciliation now additionally
writes `sidebar-session-activity:token-pruned` with the durable `runId` and
scoped aliases. These are diagnostics only and must never affect sidebar
state.

If the trace passes and the UI is visually stable, mark row identity and trace
transport as deferred rather than extending this plan.

##### B04 - deferred work, not completion criteria

Do not implement any of the following without new evidence:

- generic batched `send-workflow-trace` IPC;
- trace priorities or a verbose-mode migration for every producer;
- `updatedAt` or stable projection-map identity solely as an optimization;
- row mount/unmount instrumentation or a `<For>` identity rewrite;
- status-writer changes, debouncing, or lifecycle polling in the sidebar.

The trace-volume plan may be re-opened only if a post-B03 fresh baseline still
shows a material volume problem. It is a development diagnostics plan, not a
release fix.

### Verification commands

Run from `packages/app` after Branch B implementation. The paths below are
the actual current locations:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm `
  src/app/tests/context/sidebar-session-activity-token.test.ts `
  src/app/tests/context/sidebar-session-activity-projection.test.ts `
  src/app/tests/pages/session-send-workflow.test.ts `
  src/app/tests/pending-session-send-flow.test.ts `
  src/app/tests/context/session-event-stream.test.ts `
  src/app/context/session-lifecycle-recovery.test.ts `
  src/app/tests/components/session/workspace-session-list-active-row.test.ts `
  src/app/tests/pages/sidebar-directory-session-wiring.test.ts

corepack pnpm@10.27.0 --filter @neatech/veslo-ui typecheck
git diff --check
```

Before a Tauri Pilot run, follow the desktop preflight in
`docs/dev/testing-playbook.md`; never start a second dev runtime beside a
user-owned one.

### Completion rules

- Branch B is selected and this plan is not complete until B02, B01, then B03
  pass in that order.
- Branch A may be considered only after its separate release/consumer-scope
  and regression proof; it is not an alternative completion path by default.
- Branch B completes only after B02's consumer-path assertions, B01's
  row-bound cleanup and alias-collision coverage, the focused suite, typecheck,
  and one captured desktop runtime result all pass.
- A passing unit suite alone cannot mark a spinner/remount claim as resolved.

### Rollback safety

The projection is UI-only. Rolling it back removes only sidebar presentation
and its app-local tokens; it does not migrate server data, durable run state,
or transcripts. Preserve accepted-run lifecycle recovery independently: it
solves missed SSE completion/transcript reconciliation and is not part of this
sidebar decision.

## Superseded detailed implementation slices

The original SAI00-SAI05 slices below are retained as design history. They are
not executable instructions. Branch B is selected, and the B01-B04 constraints
above override conflicting historical instructions, notably the shadow-only
sequencing, token cleanup, test paths, and runtime evidence requirements.

### SAI00 - Introduce scoped activity identity before terminal authority

**Files:**

- Create or extend a small app-local sidebar activity-token context/model.
- Modify `session-send-workflow.ts` and its dependency contract.
- Modify `app.tsx` only to construct the model and provide workflow callbacks;
  do not add view props or change sidebar rendering in this slice.
- Create `packages/app/src/app/tests/context/sidebar-session-activity-token.test.ts`.

Requirements:

- Advance a local generation at the send-workflow point that establishes a new
  user send; it must precede any resulting activity presentation. For a first
  send, begin against its pending aliases rather than requiring a final session
  ID.
- On `onMaterializedSessionId` / the corresponding accepted submit result,
  atomically migrate the pending alias set to the final UI session ID,
  OpenCode session ID, and conversation ID. This is migration, not row cleanup.
- Promote atomically with every accepted outcome: `submitted -> runId` and
  `queued -> reservedRunId`. Handle both existing-session and first-session
  server-submit paths.
- Use the same full scoped alias set as lifecycle diagnostics. No alias may be
  promoted, migrated, or removed independently.
- For a submitted outcome, promotion must happen before lifecycle admission
  publishes initial status/busy/diagnostic evidence. Implement this with an
  admission callback invoked inside `admitAcceptedConversationRun` before its
  first publication, or a shared app-level batch that promotes then admits.
  Do not promote only after that function returns.
- For a queued outcome, promote the `reservedRunId` before queue/UI outcome
  publication; later queue materialization must preserve that same token.
- Remove the token on send failure, send-boundary block, or materialization
  failure. This does not apply to lifecycle status `blocked`, which remains an
  active durable phase.
- Retain enough per-token association to reject a late terminal diagnostic for
  an older run after a newer token has begun.
- Retain a durable token after its run becomes terminal until a newer token or
  row removal/rekey replaces it; otherwise the projection could not correlate
  that terminal result with the stale mirrors it is allowed to release.
- Clear token state only when its final sidebar row disappears/rekeys after no
  pending-to-final migration is in progress, alongside projected-row cleanup.
  Do not globally clear tokens on workspace switches.

**Acceptance criteria:**

- A retained terminal diagnostic plus a new local send and running/busy mirror
  is active.
- A retained terminal diagnostic for run A cannot release active durable run
  B on the same row.
- A terminal result for the current durable run releases that run.
- No `session.status` or `workspaceBusy` writer gains a run-ID requirement.
- A terminal diagnostic without a token cannot suppress a non-idle mirror.
- Queued existing and first-session sends promote to `reservedRunId` and their
  later terminal result is correlated to that token.
- A first-session token survives `pending -> materialized` migration, is found
  through each final alias, and is removed on materialization failure.

### SAI01 — Add diagnostic evidence before changing presentation

**Files:**

- Create `packages/app/src/app/context/sidebar-session-activity-projection.ts`
- Modify `packages/app/src/app/components/session/workspace-session-list.tsx`
- Modify `packages/app/src/app/app.tsx`
- Modify `packages/app/src/app/app-view-props.ts`
- Modify `packages/app/src/app/pages/dashboard.tsx`
- Modify `packages/app/src/app/pages/session.tsx`
- Create `packages/app/src/app/tests/context/sidebar-session-activity-projection.test.ts`

Implement the same pure projection calculation as SAI02, but expose it only
as a dev-only **shadow projection**. `WorkspaceSessionList` must continue to
render from its current inputs during this slice. Add dev-only, bounded
diagnostics with two distinct event classes:

- `sidebar-session-activity:transition` — only when a projected row activity
  changes; include row key, workspace ID, aliases, previous/next phase and
  source, but no prompt or transcript content.
- `sidebar-session-row:mount` / `sidebar-session-row:unmount` — only for a
  row that currently has projected activity. Include row key and a monotonic
  mount generation.

Use the existing send-workflow trace facility for persistence and retain a
small browser debug tail for live inspection. Diagnostics must be no-ops when
the existing developer/send trace mode is disabled.

**Acceptance criteria:**

- A normal send yields at most one visual activation and one visual release
  for its row unless durable lifecycle truth genuinely changes phase.
- A spinner restart can be classified from one trace as either a false
  activity transition or a row remount while activity stayed true.
- This slice does not alter a sidebar spinner, active-row state, or
  project-open decision.
- The shadow instance receives the same app-level inputs as the eventual live
  instance: flattened renderer rows, scoped status, workspace busy, lifecycle
  diagnostics, and activity tokens. Dashboard and Session receive the same
  accessor so the shadow cannot accidentally test only one route.

### SAI02 — Implement the projection controller

**Files:**

- Create `packages/app/src/app/context/sidebar-session-activity-projection.ts`
- Modify `packages/app/src/app/app.tsx`
- Modify `packages/app/src/app/app-view-props.ts`
- Modify the props types that carry sidebar state into `Dashboard` and
  `Session` views.
- Modify `packages/app/src/app/lib/scoped-session-status.ts`
- Extract the private row-alias helper from `workspace-session-list.tsx` into
  a pure sidebar-session model/helper module shared by the projection and the
  list. Do not duplicate alias logic.

Create a small controller/factory, for example:

```ts
createSidebarSessionActivityProjection({
  sidebarRows,
  sessionStatusById,
  workspaceBusy,
  conversationRunDiagnosticsBySessionKey,
  activityTokenByScopedSessionKey,
  now,
  trace,
})
```

It returns an accessor for `activityByRowKey`.

Requirements:

- Consume the final flattened sidebar rows produced by the same
  `workspace-session-list-model.ts` path as the renderer. Do not derive
  `rowKey` from raw `workspaceSessionGroups`: private/subagent rows can inherit
  root-project context and have a rewritten key.
- Derive aliases from that final row; do not use the active workspace as a
  fallback for another row's status.
- Add and use an explicit `readScopedSessionStatus` helper which reads only
  `scopedSessionStatusKey(workspaceId, sessionId)`. Do **not** use
  `readSessionStatus`: its intentional bare-ID fallback can leak status across
  workspaces if IDs collide. Existing callers retain their current fallback
  behavior unchanged.
- Read lifecycle diagnostics with the same scoped alias keys already used by
  `session.ts` and `session.tsx`.
- Treat a fresh active lifecycle diagnostic as stronger evidence than an idle
  engine observation. This preserves the recently added `session.idle`
  hardening in the sidebar too.
- Treat a non-stale terminal diagnostic as the strongest release authority,
  above active lifecycle, status, and busy evidence **only after SAI00 token
  correlation**. A stale or non-current terminal result does not release
  activity. Do not add a local timeout or polling loop.
- Preserve `active: true` when a status/busy mirror changes but another source
  remains active.
- Do not mutate input maps or sidebar session rows.
- On every recomputation, remove entries whose `rowKey` is no longer present.
  A rekey is a removal plus creation: it must not leave a prior-row activity
  entry reachable by the old key.

**Acceptance criteria:**

- A row remains active through a lifecycle-owned SSE idle observation until
  durable lifecycle says terminal.
- A non-stale terminal lifecycle result clears a row even if an old scoped
  running status or workspace-busy entry is still present, but only for the
  terminal's correlated current run.
- A background workspace row resolves only against its own workspace scope.
- An alias match on UI session ID, OpenCode session ID, or conversation ID
  activates the intended row and no unrelated row.

### SAI03 — Migrate `WorkspaceSessionList` to the sole UI projection

**Files:**

- Modify `packages/app/src/app/components/session/workspace-session-list.tsx`
- Modify `packages/app/src/app/pages/dashboard.tsx`
- Modify `packages/app/src/app/pages/session.tsx`
- Modify matching view-prop type files.

Pass `activityByRowKey` into `WorkspaceSessionList` and replace all direct
activity decisions with one shared helper that reads the projection by
`row.rowKey`. This includes both spinner render paths **and**
`rowForcesProjectOpen`; otherwise the project-open rule and the spinner would
continue to implement conflicting definitions of activity.

Remove direct sidebar reads of `sessionStatusById` and
`busySessionByWorkspaceId` after all call sites use the projection. Those maps
remain available to non-sidebar consumers and remain controller inputs.

Extend `Dashboard`'s sidebar prop wiring with
`conversationRunDiagnosticsBySessionKey` and the one projection accessor;
`Dashboard` currently does not receive lifecycle diagnostics. Wire the same
accessor through `Session` so both views observe one map, not independently
computed page state.

The visual component may render `phase` for accessibility/tooltip use, but
the initial UI should retain the current spinner appearance. Do not add
additional badges in this slice.

**Acceptance criteria:**

- Recent and grouped sidebar render paths use the same helper and produce the
  same spinner decision for the same row.
- `rowForcesProjectOpen` uses that same helper, so a project with an active
  child is expanded by the exact visual activity result.
- The sidebar has exactly one direct activity input prop.
- Existing background-session activity remains visible.

### SAI04 — Regression coverage and verification

**Files:**

- Create `packages/app/src/app/tests/context/sidebar-session-activity-projection.test.ts`
- Modify `packages/app/src/app/tests/pages/session-send-workflow.test.ts`
- Modify `packages/app/src/app/tests/pending-session-send-flow.test.ts`
- Modify `packages/app/src/app/tests/components/session/workspace-session-list-active-row.test.ts`
- Modify `packages/app/src/app/tests/pages/sidebar-directory-session-wiring.test.ts`

Cover at minimum:

1. status active, busy absent;
2. busy active, status idle;
3. both active, one clears, projection remains active;
4. lifecycle active plus SSE idle, projection remains active;
5. durable terminal lifecycle releases projection;
6. current durable run A's non-stale terminal lifecycle overrides A's stale
   running/busy mirror;
7. retained terminal run A cannot suppress a newer local activity token or
   newer durable run B on the same row;
8. queued existing-session and first-session submits promote the token to
   `reservedRunId` before queue evidence, then correlate that run's terminal
   lifecycle result;
9. pending first-session aliases migrate atomically to final aliases without
   losing the token, while a materialization/send-boundary failure removes it;
10. a stale terminal lifecycle does not release active lifecycle/status/busy
   evidence;
11. a colliding bare session ID in another workspace cannot activate this row;
12. scoped background workspace aliases do not leak into the active workspace;
13. removing a row deletes its activity record and a rekey leaves no old key;
14. equal recomputation returns the same presentation map/object and emits no
   transition trace;
15. both recent and grouped rows consume the sole projection prop;
16. a project with an active child is forced open through the projection, not
   direct status/busy reads.

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm `
  src/app/tests/context/sidebar-session-activity-token.test.ts `
  src/app/tests/context/sidebar-session-activity-projection.test.ts `
  src/app/tests/pages/session-send-workflow.test.ts `
  src/app/tests/pending-session-send-flow.test.ts `
  src/app/tests/context/session-event-stream.test.ts `
  src/app/context/session-lifecycle-recovery.test.ts `
  src/app/tests/components/session/workspace-session-list-active-row.test.ts `
  src/app/tests/pages/sidebar-directory-session-wiring.test.ts
pnpm --filter @neatech/veslo-ui typecheck
git diff --check
```

### SAI05 — Make a decision on row identity only from diagnostic evidence

After SAI01–SAI04, perform one manual dev-runtime send with the sidebar open.

Interpretation:

- `activity:transition` reports false between active states: investigate an
  upstream status writer; do not change list identity yet.
- Activity remains true but active row mount generation increments: row
  identity/remount is confirmed. Create a follow-up plan to preserve row
  identity by `rowKey` without losing correct reorder behavior.
- Neither event occurs while the spinner visibly freezes: profile main-thread
  work separately; it is not an activity-writer defect.

This plan must not mark SAI05 done merely because unit tests pass. It requires
one captured runtime trace.

## Rollback

The projection is UI-only. Rollback consists of removing its prop wiring and
restoring the two existing direct sidebar activity reads. No server data,
durable run state, or conversation transcript needs migration or cleanup.
