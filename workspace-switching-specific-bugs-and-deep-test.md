# Workspace Switching: Specific Bug Candidates And Deep Test Plan

Date: 2026-06-17

Scope: follow-up to `workspace-deep-audit-1.md`, `workspace-deep-audit-2.md`, and `workspace-deep-audit-3.md`.

This document intentionally looks for concrete process bugs rather than re-describing the whole workspace switching architecture.

No code changes or runtime tests were performed while writing this document.

## Bug Candidate 1: Active Workspace Can Be Left On A Superseded Local Switch

### Why This Looks Real

Local workspace activation publishes `activeWorkspaceId` and `projectDir` early, before Tauri persistence and before runtime activation.

Remote workspace activation publishes `activeWorkspaceId` later, after `connectToServer` succeeds.

That creates this race:

1. Current active workspace is `ws-a`.
2. User starts local switch to `ws-b`.
3. Local activation reaches `prepareLocalWorkspaceSelection()` and immediately publishes:
   - `activeWorkspaceId = ws-b`
   - `projectDir = /repo/b`
4. Before local activation finishes, user starts switch to remote `ws-r`.
5. The remote activation supersedes the local one.
6. Remote activation fails before `persistRemoteSelection()` runs.
7. The app may remain on `ws-b`, even though the `ws-b` activation was superseded and the latest user intent was `ws-r`.

This is not covered by checking only final `connectingWorkspaceId`. The overlay can clear correctly while the active workspace is stale.

### Expected Behavior

If activation B supersedes activation A, then A's optimistic active state should not become the final active state when B fails before publishing its own active state.

Possible acceptable outcomes:

- revert to the previous stable active workspace `ws-a`
- or explicitly keep `ws-b` only if `ws-b` completed activation before it was superseded

The suspicious outcome is:

- `activeWorkspaceId === ws-b`
- `workspaceConnectionStateById[ws-b]` is not actually connected from a completed activation
- latest activation attempt was `ws-r`

### Test Shape

Unit/controller-level deterministic test:

- Build a harness around `createWorkspaceActivationController()`.
- Use real local/remote activation order semantics through injected `runActivationBody`.
- Make local activation publish active id immediately, then block.
- Start remote activation while local is blocked.
- Make remote activation fail before publishing active id.
- Resolve local activation after it has been superseded.

Assertions:

- `connectingWorkspaceId` is cleared.
- Final active workspace is not the superseded local target.
- Connection state for superseded local target is not `connected`.
- Debug trace contains supersession for the local activation.

Desktop/E2E variant:

- Have two local workspaces and one intentionally broken remote workspace.
- Click local workspace B and immediately click broken remote R.
- Confirm final visible active worker is either original A or explicit failed R state, not B.
- Read Tauri workspace state and confirm `active_id` was not silently persisted as B by the superseded flow.

## Bug Candidate 2: Project-Plus Pending Draft Can Pair Target Workspace Id With Wrong Directory

### Why This Looks Real

`openPendingDirectoryDraftInWorkspace(workspaceId)` activates the target workspace, then resolves the directory from `activeWorkspaceDisplay()`.

If another activation or state mutation changes the active workspace between the activation result and the pending draft open callback, the code can create a draft like:

- `workspaceId: ws-b`
- `directory: /repo/c`

That is a corrupt scope: the draft belongs to one workspace id but points at another workspace root.

### Expected Behavior

After activation returns, the flow should verify:

- `activeWorkspaceId === targetWorkspaceId`
- and `activeWorkspaceDisplay().id === targetWorkspaceId`

If not true, it should block instead of creating a pending draft.

Alternatively it should resolve the target workspace by id from `workspaces()` instead of trusting active display state.

### Test Shape

Pure controller test:

- Instantiate `createPendingSessionDraftController()` or extract the project-plus helper through a focused harness.
- Mock `workspace.activateWorkspace("ws-b")` to return true.
- After activation, make `workspace.activeWorkspaceDisplay()` return workspace C.
- Call `openPendingDirectoryDraftInWorkspace("ws-b")`.

Assertions:

- No pending draft is written with `{ workspaceId: "ws-b", directory: "/repo/c" }`.
- Either the flow returns false or writes a draft whose directory belongs to `ws-b`.
- Error/debug trace identifies stale active workspace after activation.

Desktop/E2E variant:

- Start on workspace A.
- Create workspace B and C.
- Open the project-plus action for B.
- During the activation delay, switch to C.
- Assert no pending draft row appears under B with C's path.
- Assert subsequent send from that draft cannot create a session in the wrong directory.

## Bug Candidate 3: `replaceUserMessage` Can Leave Busy State On After Runtime Recovery If Revert Fails

### Why This Looks Real

`ensureLocalRuntimeReachableForSend()` sets busy state when recovering the active workspace runtime:

- `setBusy(true)`
- `setBusyLabel("status.connecting")`
- `setBusyStartedAt(Date.now())`

On recovery failure it clears busy. On recovery success it returns true without clearing busy.

For normal `sendPrompt`, this is probably masked because the send flow soon switches busy to `status.running` and later stops it.

For `replaceUserMessage`, the flow is:

1. Ensure scoped workspace active.
2. Ensure managed AI ready.
3. Ensure local runtime reachable.
4. Get routed client.
5. Abort session.
6. Revert session.
7. Call `sendPrompt`.

If runtime recovery succeeds at step 3, then `revertSession()` throws before `sendPrompt()` starts, there is no surrounding `try/finally` in `replaceUserMessage()` to clear the busy state.

This can leave the app in a connecting/busy state with no active send.

### Expected Behavior

`replaceUserMessage()` should not rely on `sendPrompt()` to clean up busy state for failures that happen before `sendPrompt()` is called.

Possible fixes:

- make `ensureLocalRuntimeReachableForSend()` clear busy on successful recovery when it set busy
- or wrap `replaceUserMessage()` pre-send work in `try/finally`
- or return metadata from readiness helper indicating it changed busy state

### Test Shape

Focused unit test for readiness helper:

- Active local workspace.
- Existing routed client health throws `ECONNREFUSED`.
- `ensureEngineForWorkspace()` returns true and installs recovered client.
- Call `ensureLocalRuntimeReachableForSend("replaceUserMessage", preflight)`.

Assertions:

- If helper owns busy lifecycle, it must clear busy on success.
- If helper intentionally does not own cleanup, caller tests must cover every caller cleanup path.

Focused `replaceUserMessage` flow test:

- Mock runtime readiness to enter recovery path and return true.
- Mock `revertSession()` to throw.
- Assert busy is cleared and error is surfaced.
- Assert no prompt send is attempted.

Desktop/E2E variant:

- Open a session in active local workspace.
- Simulate stale runtime endpoint so replace triggers recovery.
- Make revert fail, for example by deleting/invalidating the target message or forcing the client route to fail after recovery.
- Assert the global busy overlay/spinner clears.
- Assert the composer remains usable.

## Bug Candidate 4: Superseded Remote Connect Can Mutate Global Client/Base URL Before Activation Fails

### Why This Looks Plausible

Remote activation calls `connectToServer()` before `persistRemoteSelection()`.

`connectToServer()` commits:

- global `client`
- `baseUrl`
- `clientDirectory`
- session loading side effects

Only after `connectToServer()` returns does remote activation check whether it was superseded.

That means a superseded remote activation can still commit a routed/global client before returning false.

Local connection has stronger stale root checks in `workspace-connection-controller.ts`. Remote relies more on activation supersession and workspace id.

### Expected Behavior

If a remote activation is superseded before or during `connectToServer()`, it should not mutate the global active client or session state for the superseded workspace.

### Test Shape

Controller/integration test:

- Active workspace A.
- Start activation to remote R.
- Let `connectToServer()` create and commit a client for R, but pause before remote activation's post-connect supersession check.
- Start activation to workspace B.
- Finish R activation with superseded state.

Assertions:

- `client`, `baseUrl`, and `clientDirectory` reflect B or A, not R.
- `workspaceRouting.entry("remote-r")` may exist, but active/global client should not be R.
- session list/snapshot state is not replaced by R's load.

Desktop/E2E variant:

- Configure a slow remote OpenCode-compatible endpoint that passes health after a delay.
- Start remote switch.
- Immediately switch to a local workspace.
- Let remote health complete.
- Assert app active worker and visible sessions remain local.
- Assert sending a prompt goes through the local workspace route, not the remote route.

## Deep End-To-End Test: Cross-Workspace Browse, Switch, Send, Replace, And Recovery

This is the main proposed test. It should be a real desktop E2E, not only API-like or source-contract.

### Purpose

Prove that the user-visible workspace model stays coherent across:

- browse-only cross-workspace session opening
- explicit project switching
- send-time activation
- lazy local runtime attach
- Tauri persisted active id
- local Veslo server active order
- orchestrator active id
- pending draft scope
- busy overlay cleanup
- route/session snapshot behavior

### Setup

Use the real Tauri desktop runtime and WebdriverIO harness.

Create three local workspaces:

- Workspace A: `/tmp/veslo-e2e-a`
- Workspace B: `/tmp/veslo-e2e-b`
- Workspace C: `/tmp/veslo-e2e-c`

Seed or create:

- one real session in A
- one real session in B
- a pending directory draft target for B
- at least one message in B that can be replaced

Enable developer/runtime diagnostics if available so the test can read:

- app active workspace id
- `engineReady`
- active route
- selected session id
- active UI conversation scope
- routed workspace count
- visible busy/overlay state

Also query backend/native state where possible:

- Tauri workspace state via a command or local file read
- Veslo server `/workspaces`
- orchestrator `/workspaces`

### Phase 1: Browse-Only Session Open

Steps:

1. Activate workspace A.
2. Open sidebar session from workspace B without explicit project switch.
3. Wait for transcript display.

Assertions:

- UI shows B session transcript.
- App `activeWorkspaceId` is still A.
- Tauri `active_id` is still A.
- Orchestrator `activeId` is still A.
- Veslo server active workspace remains A unless server registry intentionally changed for runtime reasons.
- `selectedSessionBrowseScope.workspaceId === B`.
- No workspace switch overlay remains open.
- No engine attach for B happened solely because of browsing.

Bug caught:

- accidental full switch on ordinary session click
- accidental runtime attach on browse
- loss of browse scope before transcript load

### Phase 2: Send-Time Activation From Browse Scope

Steps:

1. While viewing B session from browse-only state, type a prompt.
2. Send.
3. Wait for send preflight and runtime activation.

Assertions:

- `activateWorkspace` origin includes `send-target:selected-session-workspace`.
- App `activeWorkspaceId === B`.
- Tauri `active_id === B`.
- Orchestrator `activeId === B`.
- Routed client for B exists and is used.
- Prompt is appended to B session, not A.
- A session list/snapshot is not overwritten with B's selected session.
- Busy state transitions through connecting/running and clears after completion.

Bug caught:

- send goes to active A instead of browsed B
- B activation happens but routed client falls back to A
- snapshot restore wipes browsed B session during activation

### Phase 3: Project-Plus Pending Draft Scope

Steps:

1. Activate workspace A.
2. Start project-plus/open-pending-directory-draft for workspace B.
3. During activation, trigger a switch to workspace C.
4. Let both operations settle.

Assertions:

- No pending draft exists with `workspaceId === B` and `directory` under C.
- If the B draft opens, `activeWorkspaceId === B` and directory belongs to B.
- If C supersedes B, B draft open is blocked.
- Sidebar does not show a phantom B project row backed by C path.

Bug caught:

- workspace id/directory mismatch in pending drafts

### Phase 4: Superseded Local Then Failing Remote

Steps:

1. Activate workspace A.
2. Trigger local switch to B.
3. Before B activation completes, trigger switch to intentionally broken remote R.
4. Let R fail.

Assertions:

- Final active workspace is not silently B unless B completed before R started.
- If the app chooses to remain on A, Tauri and app state agree.
- If the app shows failed R, connection state and UI clearly reflect R failure.
- `connectingWorkspaceId` clears.
- No stale B connected state is shown.

Bug caught:

- optimistic local active publication survives supersession incorrectly

### Phase 5: Replace Message After Runtime Recovery Failure

Steps:

1. Activate workspace B.
2. Open a B session.
3. Force B runtime client health to fail so replace triggers recovery.
4. Make recovery succeed.
5. Make `revertSession` fail before `sendPrompt` starts.

Assertions:

- Busy overlay clears.
- Busy label clears.
- Composer remains enabled.
- No prompt send happens.
- Error is visible and scoped to the displayed session.
- Session revert state is not partially applied.

Bug caught:

- stuck busy state after recovery success followed by pre-send failure

### Phase 6: Superseded Remote Connect

Steps:

1. Activate workspace A.
2. Trigger switch to slow remote R.
3. Let remote R pass health/connect slowly.
4. Before R finishes, switch to local B.
5. Let R's connect finish.

Assertions:

- Final active workspace is B.
- Global active client/base URL is B, not R.
- Sending a prompt uses B.
- Remote R may remain in routing entries, but only as explicit `client("R")`.
- Visible session list is B's snapshot, not R's session load.

Bug caught:

- superseded remote connect mutates global client/session state

## Lower-Level Tests To Add Alongside E2E

The E2E above is the proof. These lower-level tests make failures easier to diagnose.

### Unit Test 1: Superseded Optimistic Local Activation

Create a deterministic controller test for:

- local activation publishes early
- remote activation supersedes and fails before publish
- final active workspace should not be the superseded local target

### Unit Test 2: Pending Draft Target Directory Guard

Test that `openPendingDirectoryDraftInWorkspace("ws-b")` cannot create:

```ts
{
  workspaceId: "ws-b",
  directory: "/repo/c"
}
```

after activation returns true but active display points at C.

### Unit Test 3: Runtime Recovery Busy Cleanup

Test all callers of `ensureLocalRuntimeReachableForSend()`:

- `sendPrompt`
- `replaceUserMessage`
- `createSessionAndOpen`

For each caller, simulate:

- active workspace recovery path sets busy
- recovery succeeds
- next caller-specific operation throws

Assert busy is cleared.

### Unit Test 4: Superseded Remote Connect Does Not Commit Active Client

Mock `connectToServer()` to commit R client, then supersede before remote activation completes.

Assert superseded activation either:

- does not commit global R client
- or rolls it back before returning false

## Notes On Existing Coverage

Existing tests already cover many invariants, especially:

- browse-only session click
- send-time activation
- snapshot save/load rules
- stale routed client guard
- pending draft creation ordering
- rapid navigation queues

The main gap is that many tests are source-contract regex tests or pure helper tests. They do not exercise the combined observable behavior across:

- actual UI state
- Tauri workspace state
- server active order
- orchestrator active id
- routed client selection
- busy overlay lifecycle
- pending draft persistence

The proposed E2E should intentionally assert every one of those layers after each phase.

