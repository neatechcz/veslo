# Workspace Cold Send UI Handoff Implementation Plan

Date: 2026-06-15
Branch context: `local/sandbox-merge`

## Goal

Fix the cold first-send experience so the user never sees the optimistic conversation replaced by an empty real conversation, reset timers, or cross-workspace UI bleed.

The fix must behave the same from the UI point of view for sandbox and sandbox-disabled runtimes. Runtime engines may run in parallel across workspaces, but the visible UI must be scoped to exactly one conversation at a time.

## Part A: Baseline Implementation Plan

This section is the original implementation plan before incorporating the second-agent findings.

### 1. Define UI Scope As The Source Of Truth

The visible conversation must be keyed by an explicit UI conversation scope, not by ambient `activeWorkspaceId`.

Required invariant:

- A visible conversation is addressed by `{ workspaceId, sessionId | pendingSessionKey }`.
- Background runtime state may update workspace/session stores, but it must not change the visible conversation unless the event matches the active UI scope.
- Send-time workspace activation must not move a run/queue/timer from the currently displayed scoped conversation.
- `activeWorkspaceId` remains legitimate for workspace chrome, routing, workspace list state, and runtime targeting. It should be replaced only in paths that mutate visible conversation state: messages, run state, timers, composer state, route/session body, and pending permission UI.

Implementation work:

- Keep using `activeUiConversationRef` as the primary read for session/run queue state.
- Audit remaining `activeWorkspaceId` reads and replace only the visible-conversation-affecting paths with scoped lookups.
- Add regression tests for cross-workspace visible session state while a different workspace becomes active for runtime startup.

### 2. Stabilize Pending Send State

Cold send must produce a stable pending conversation object before any runtime work starts.

Required invariant:

- The first user message, send timer, pending client message id, route, workspace id, and pending session key are created together.
- The timer is owned by the pending send/run state and survives materialization from pending session to real session.
- Engine startup, session list refresh, MCP refresh, and sidebar hydration cannot reset this state.

Implementation work:

- Introduce or harden a `PendingSendUiState`/equivalent object that stores:
  - `workspaceId`
  - `pendingSessionKey`
  - optional `materializedSessionId`
  - `clientMessageId`
  - `sendStartedAt`
  - `routeEntryId` or route token
  - current status: `pending-engine`, `creating-session`, `prompt-accepted`, `streaming`, `done`, `failed`
- Render the composer/session surface from this stable state until real transcript data is merged.
- Do not derive visible timer start from the selected session row alone.

### 3. Make Pending-To-Real Handoff Atomic

When the engine creates a real session, UI state must be remapped before the real route/session render can clear the optimistic view.

Required invariant:

- Pending key and real session id both point to the same visible conversation during the handoff window.
- The first real render of the materialized session includes the optimistic user message or a merged transcript; it must not briefly show zero messages.
- The selected route, session store, run state, busy state, pending message state, and sidebar row are updated in one logical batch.

Implementation work:

- Add a materialization transaction around session creation:
  1. create real session
  2. register pending-key -> real-session mapping
  3. move run/timer/queue state to the scoped real key
  4. merge optimistic message into the real session store
  5. update/sidebar-insert real row
  6. only then allow route/session selection to point at the real session
- Add tests proving that message count and timer remain stable across materialization.

### 4. Decouple Sidebar History Hydration From Main Conversation

Sidebar history loading must not drive the main session body while a send is in progress.

Required invariant:

- Sidebar list refresh can add historical sessions, but it cannot replace the active visible conversation or clear its rendered messages.
- History hydration has lower priority than the active send handoff.
- A sidebar fallback must never clear existing rows while a workspace is still hydrating.

Implementation work:

- Gate live sidebar session list refresh while an active send trace is in the critical path.
- Allow only the current pending/materialized row to be patched during this window.
- After `prompt_async` is accepted or the first transcript snapshot is merged, resume full sidebar list hydration.
- Keep existing snapshot gating on hydrated workspace and add coverage for cold-send history arriving at the same time as session creation.

### 5. Make Same-Session Selection Idempotent

Duplicate `selectSession(session.id)` calls for the same workspace/session should coalesce instead of aborting the first transcript load and producing an empty render.

Required invariant:

- Re-selecting the same scoped session while its transcript load is in flight joins the existing load.
- A stale selection abort should only happen when the requested scoped session actually changes.

Implementation work:

- Key selection runs by `{ workspaceId, sessionId }`.
- If the incoming selection matches the current in-flight selection, return the same promise or mark it joined.
- Update abort checks so the offline transcript application is not cancelled by a duplicate same-session select.

### 6. Scope Runtime And SSE Events Before UI Mutation

Parallel engines are allowed, but their outputs must be routed through workspace/session scope before touching visible UI.

Required invariant:

- SSE status, busy markers, transcript updates, permission polling, MCP refreshes, and runtime readiness events are first classified by workspace/session.
- Only events matching the visible UI scope update the visible conversation body.
- Events for hidden workspaces update background stores and badges only.

Implementation work:

- Audit handlers in `session.ts`, `session.tsx`, `app.tsx`, and workspace runtime controllers for ambient active workspace usage.
- Add a small helper that answers: "does this event belong to the active visible conversation?"
- Use that helper before mutating visible run state, timer state, route state, or composer state.

### 7. Preserve Runtime Adapter Boundaries

The fix must not solve UI flicker by changing sandbox semantics.

Required invariant:

- Sandbox and sandbox-disabled modes both expose the same UI lifecycle:
  - pending UI starts immediately
  - engine may start asynchronously
  - session materializes atomically
  - streaming transcript replaces/merges optimistic content without visible reset
- WSL cold start remains a runtime delay, not a UI reset.

Implementation work:

- Keep engine startup behind existing workspace runtime controller/adapters.
- Do not special-case WSL in UI code except for diagnostics.
- Test with both sandbox and sandbox-disabled paths.

### 8. Reduce Critical Path Noise

Background refreshes should not compete with first-send materialization.

Required invariant:

- Active send has priority over nonessential sidebar/MCP/permission refreshes.
- Background refreshes may be deferred, joined, or deduped, but not dropped permanently.

Implementation work:

- Keep permission polling skipped during active send.
- Extend the same principle to MCP auto-refresh if it can run during cold send.
- Validate that refresh inputs still match the workspace being refreshed at execution time.

## Part B: Verification Of Second-Agent Findings

After writing the baseline plan, I verified the second-agent findings against the manual runtime logs and current code. The findings are valid and refine the implementation order.

### Confirmed Finding 1: Handoff Order Is Wrong

Evidence:

- `pilot-logs.jsonl` shows the optimistic view with `renderedMessageCount: 1` and `sessionID: null`.
- `createSessionAndOpen:select-session:start` then selects the new real session.
- Immediately after selection, `renderedMessageCount` drops to `0` for the real session.
- Only later does the transcript render with messages again.
- In code, `sendPrompt` calls `createSessionAndOpen(...)`, but `options.onMaterializedSessionId(...)` is called only after `createSessionAndOpen` returns.
- Inside `createSessionAndOpen`, `selectSession(session.id)` is already called before that return.

Impact on plan:

- Task 3 becomes the highest-impact fix after UI scope hardening.
- `createSessionAndOpen` needs a pre-select materialization callback, but it must receive scoped input, not only the created `session`.
- The callback payload should include `workspaceId`, `pendingSessionKey`, `sessionId`, `clientMessageId`, `sendTraceId`, and when available `conversationId` / `opencodeSessionId`.
- That callback must register the pending-to-real mapping and move timer/run/optimistic message state before `selectSession(session.id)` can render the real session.

### Confirmed Finding 2: Sidebar History And Session Create Race

Evidence:

- Runtime trace shows sidebar `GET /session?limit=20` starts right after engine readiness and takes about 6157 ms.
- `POST /session` starts almost at the same time and takes about 5974 ms.
- They complete within roughly the same window, matching the observed moment where old conversations appear and the visible UI resets.

Impact on plan:

- Task 4 is not just cleanup; it is part of the cold-send fix.
- Full sidebar history hydration should be deferred during the active send critical path.
- The deferral window starts at optimistic enqueue and lasts at least until the pending-to-real handoff has completed.
- Prefer extending the deferral until `prompt_async` is accepted or the first merged transcript snapshot lands, unless a current-row materialization patch is needed.
- The current pending/materialized row may still be patched, but broad list replacement must wait until the active send handoff is stable.

### Confirmed Finding 3: Duplicate Same-Session Select Aborts Transcript Hydration

Evidence:

- Logs show `session.select:aborting: selection changed before offline transcript applied` for the same materialized session path.
- This happens after the first `selectSession` starts and another select follows quickly.

Impact on plan:

- Task 5 should be done together with Task 3, not later.
- Same-session select joining will prevent a materialized session from briefly rendering empty because its first transcript load was aborted by an equivalent selection.

### Confirmed Finding 4: MCP Refresh Adds Noise During Active Send

Evidence:

- Runtime trace shows `/opencode/mcp` requests during the cold send path.
- One request runs for `test-repo2` while the active send is for `test-repo1`, taking about 8249 ms.
- `createPermissionPollingScheduler` already has `activeSendTraceId` skip behavior, but `createMcpAutoRefreshScheduler` does not.

Impact on plan:

- Task 8 should explicitly add `activeSendTraceId` gating to MCP auto-refresh.
- MCP refresh must validate that `projectDir` still belongs to the workspace being refreshed at execution time.
- This is secondary to the UI reset, but it reduces cross-workspace pressure during cold send.

### Confirmed Finding 5: Cold WSL Startup Is Expected Runtime Delay

Evidence:

- Engine startup in the manual run takes several seconds before session create can proceed.
- This delay is expected for cold pooled-per-workspace WSL startup.

Impact on plan:

- Do not try to hide or bypass engine startup in runtime code.
- UI should show stable pending/conversation state during the wait.
- The user must not perceive the transition from pending to real as a different conversation or reset.

## Revised Implementation Order

1. Harden active UI conversation scope and remove remaining visible-session reliance on ambient `activeWorkspaceId`.
2. Add pre-select materialization callback to `createSessionAndOpen`.
3. Move pending run/timer/optimistic message state before `selectSession(session.id)`.
4. Make same-session selection idempotent and join duplicate transcript loads.
5. Defer broad sidebar history hydration during active send; allow only current row materialization patches.
6. Add `activeSendTraceId` gating and workspace/project validation to MCP auto-refresh.
7. Audit runtime/SSE/background event routing so hidden workspace events cannot mutate visible conversation state.
8. Verify both sandbox and sandbox-disabled runtime modes with the same UI assertions.

## Part C: Additional Root-Cause Review

The later review notes are materially useful. They identify one deeper root cause that should move ahead of the already confirmed handoff bug.

### Confirmed Finding 6: Default UI Scope Is A Real Root Cause

Evidence:

- In the cold-send run, `sendPrompt:start` has `activeWorkspaceId: "ws-5251eba6af25"`.
- The same trace has `uiScopeKey: "ws:default:pending-workspace:active"` and `uiScopeWorkspaceId: null`.
- `createWorkspaceSessionSelection` is initialized with accessors that read `workspaceStoreRef`.
- `workspaceStoreRef` is a plain `let` that can be `null` during first memo execution.
- If a memo first runs while `workspaceStoreRef` is null, it does not subscribe to the real workspace store signals, so later assigning `workspaceStoreRef = workspaceStore` does not necessarily invalidate the UI scope.

Impact on plan:

- The first implementation step should be a reactive workspace scope bridge, not a simple init-order shuffle.
- The selection controller should receive reactive accessors/signals that always invalidate after workspace store hydration.
- Avoid moving `workspaceStore` creation blindly earlier, because the store currently depends on session/selection functions and that can introduce a new initialization cycle.

### Confirmed Finding 7: SQLite Read Count And Live Engine Count Diverge

Evidence:

- `sidebar:conversation-read` and `sessions:load:conversation-read` return `count: 0` from sqlite/read APIs for `ws-5251eba6af25`.
- The later live sidebar request returns `count: 7` from `/opencode/session` for the same workspace.

Impact on plan:

- Sidebar deferral is necessary for flicker, but not sufficient for history correctness.
- There is a separate data convergence issue: passive read storage does not contain the sessions that the live engine knows.
- After the UI handoff fixes, add a focused investigation/backfill task:
  - why sqlite/read API is empty
  - whether live engine sessions should be imported/backfilled after engine start
  - how to keep sidebar history stable without using live engine list as a blocking UI dependency

### Confirmed Finding 8: Send UI State Should Be An Overlay

Impact on plan:

- Do not replace all existing session queue keys with a new global send-state model.
- Add a scoped `SendUiRun` overlay keyed by `{ workspaceId, pendingKey | sessionId, clientMessageId | sendTraceId }`.
- Existing queue keys can remain, but the overlay owns visible timer continuity and optimistic-to-real identity during the send handoff.

### Confirmed Finding 9: Selection Dedup Must Be Workspace-Scoped

Evidence:

- Current `select-session-guard` dedupes by `sessionID`.
- The observed failure is same-session re-selection, but multi-workspace mode means session id alone is too weak as a durable identity.

Impact on plan:

- Dedup/idempotence should be keyed by conversation scope, at minimum `{ workspaceId, sessionId }`.
- Prefer the canonical `UiConversationRef.key`, or `{ workspaceId, sessionId, opencodeSessionId? }` when a full ref is not available.
- This applies equally to sandbox and sandbox-disabled paths.

### Confirmed Finding 10: Workspace Registration Failure May Explain History Divergence

Evidence:

- The manual run logs `conversation-read:workspace-register:failed` with `Workspace already exists` for `ws-5251eba6af25`.
- Shortly after, sqlite/read history returns `count: 0`, while live engine history later returns `count: 7`.

Impact on plan:

- The sqlite/live history investigation should include the "already registered but not imported/backfilled" state.
- Confirm whether workspace registration is treated as a no-op after `Workspace already exists`, and whether that path skips conversation import/backfill.
- If so, make registration idempotent in a way that still verifies/imports existing engine conversations.

## Final Recommended Order After All Reviews

1. Fix reactive workspace scope so pending UI never falls back to `ws:default` when a real active workspace exists.
2. Add scoped `SendUiRun` overlay for timer/optimistic identity without replacing existing queue keys wholesale.
3. Move pending-to-real remap before the first `selectSession(session.id)` render using a scoped payload: `{ workspaceId, pendingSessionKey, sessionId, clientMessageId, sendTraceId, conversationId?, opencodeSessionId? }`.
4. Make same-session select and route hydration idempotent by `UiConversationRef.key` or equivalent scoped identity.
5. Defer broad sidebar/live history refresh during active send and keep it out of the main conversation surface.
6. Add stale-result guards for background runtime/MCP refreshes: apply only if `{ workspaceId, projectDir }` still matches.
7. Add active-send gating to automatic MCP refresh.
8. Investigate sqlite/read API empty history vs live engine history, including `conversation-read:workspace-register:failed`, and add a backfill/import strategy if needed.
9. Verify sandbox and sandbox-disabled modes with the same UI acceptance tests.

## Acceptance Criteria

- During cold first-send, `renderedMessageCount` must never go from optimistic `1` to materialized `0`.
- The visible send timer must start once and continue across engine startup, session creation, prompt acceptance, and transcript hydration.
- Sidebar history may appear late, but it must not remount/reset the active conversation body.
- Switching workspaces while another workspace engine is busy must not route messages, timers, or transcript state into the wrong visible workspace.
- Duplicate selection of the same scoped session must not abort its transcript hydration.
- MCP refresh and sidebar refresh must not block or perturb the active send critical path.
- Behavior must be equivalent for sandbox and sandbox-disabled UI flows.

## Verification Plan

- Unit tests:
  - pending-to-real handoff keeps timer/run/message state
  - same-session select joins instead of aborting
  - foreign workspace events do not mutate active visible session
  - MCP scheduler skips/defer during active send
- Integration tests:
  - cold first-send with delayed session create and delayed sidebar history
  - cross-workspace active engine event while another workspace is visible
  - sandbox-disabled and sandbox paths share the same UI state contract
- Manual Tauri pilot:
  - start app cold
  - send first message in `test-repo1`
  - verify no UI reset around 5-12 seconds
  - verify timer continuity
  - verify old sidebar conversations loading does not remount the active session
  - switch to `test-repo2`, send message, and verify the same behavior

## Non-Goals

- Do not change engine topology as part of this fix.
- Do not special-case WSL as a UI behavior.
- Do not block parallel background workspace runtimes.
- Do not remove optimistic UI; make it stable and correctly materialized.
