# Cross-Worker Session Hydration Design

**Date:** 2026-03-29  
**Status:** Approved  
**Branch:** main

## Goal

Make cross-worker session switching feel immediate by opening the session view right away, showing cached or prefetched chat text when available, and moving worker attach plus session truth loading into the background.

## Scope

- Cross-worker session opening flow in:
  - `packages/app/src/app/pages/session-navigation.ts`
  - `packages/app/src/app/pages/dashboard.tsx`
  - `packages/app/src/app/pages/session.tsx`
  - `packages/app/src/app/app.tsx`
- Session hydration, cached snapshot state, and selected-session readiness in:
  - `packages/app/src/app/context/session.ts`
  - `packages/app/src/app/context/workspace.ts`
- Sidebar-driven prefetch policy for visible expanded workers in:
  - `packages/app/src/app/components/session/workspace-session-list.tsx`
  - supporting sidebar state in app/session pages

Out of scope:

- Full multi-worker live synchronization.
- Prefetching every session in every worker.
- Artifact, file, or binary attachment caching.
- Any change to the runtime contract that a message can only be sent after the target worker/session is ready.

## Current Problem

Today a cross-worker click waits for worker activation before the session view can really open.

Observed critical path:

1. `openSessionWithWorkspaceActivation(...)` waits for `activateWorkspace(...)`.
2. `activateWorkspace(...)` may restart or reconnect the local engine.
3. `connectToServer(...)` performs health checks, loads scoped sessions, refreshes permissions, and fetches provider state.
4. Only after that does the routed session call `selectSession(...)`, which then loads `session.messages(...)`, `session.todo(...)`, and selected-session permissions.

This creates a slow-feeling transition even when the user only needs to see chat content quickly. The current fullscreen loading overlay also blocks the rest of the app more aggressively than needed.

## Validated Product Decisions

1. Fast visible reaction matters more than immediate write capability.
2. The session view must open immediately on cross-worker click.
3. Cached or prefetched chat text is sufficient for first paint.
4. The composer may accept draft typing while hydration is still running.
5. Sending must stay disabled until worker attach and selected-session hydration complete.
6. The fullscreen loading overlay should be removed for this flow.
7. When no chat data exists yet, loading state should appear inline inside the message area, not as a blocking screen.
8. Failure must not stop the flow; Veslo should surface the problem and keep retrying automatically until superseded or clearly impossible.

## Recommended Approach (Approved)

Adopt a hybrid snapshot model:

- immediately route to the target session
- render the last known text snapshot if available
- otherwise render a cold loading placeholder inside the message list
- attach the worker and rehydrate the selected session in the background
- enable send only after the selected session reaches a ready state

To improve first paint for not-yet-opened sessions, Veslo should prefetch lightweight text snapshots only for workers that are both visible and expanded in the left sidebar, and only for the most recent few sessions in each of those workers.

## Snapshot Strategy

### Snapshot contents

The cached snapshot is intentionally text-only and should include only what is needed for fast message rendering:

- message info
- text/tool timeline parts needed to render the chat
- enough recent history for a convincing first paint

It should not try to preload artifacts, file payloads, or every derived sidebar dependency.

### Snapshot sources

Use two cache layers:

- in-memory snapshots for sessions already visited in the current app lifetime
- persistent local snapshots so the latest known chat can survive app restart

When the truth load completes, the latest backend state replaces the snapshot.

### Prefetch policy

Prefetch is limited on purpose:

- only workers visible to the user in the left menu
- only workers currently expanded
- only the most recent `3-5` sessions per eligible worker
- only low-priority, cancellable snapshot fetches

If a worker is collapsed or leaves the visible region, new prefetch work for it should stop.

## Session View States

### Hot snapshot

If a full or near-full cached snapshot exists:

- open the session immediately
- render the known chat right away
- scroll the message list to the bottom
- show a subtle inline status below the latest content such as `Loading latest state from worker...`
- keep send disabled until ready

### Warm snapshot

If only a lightweight prefetched snapshot exists:

- render that partial chat immediately
- keep the same inline loading treatment
- replace or extend the content once the truth load completes

### Cold open

If no chat data exists:

- still open the session immediately
- render a system-style loading placeholder inside the message list
- keep the composer visible
- allow the user to switch away freely without waiting for a blocking overlay to disappear

## Composer And Interaction Rules

- The composer remains visible during cross-worker hydration.
- Draft typing may remain enabled.
- Send stays disabled until the selected session is truly ready.
- The disabled state should explain why briefly instead of appearing as a silent greyed-out control.
- Draft state remains session-scoped and should survive hydration completion.

## Ready State

A selected cross-worker session becomes `ready` only after:

1. worker attach/reconnect succeeds
2. selected-session chat truth has been loaded successfully enough for normal interaction

At that point:

- the inline loading indicator disappears
- send becomes enabled
- the view behaves like any other active session

## Failure And Recovery Policy

Failures are visible but non-terminal in UX.

When attach or hydration fails:

- keep the session view open
- keep any cached snapshot visible
- replace the inline status with a concise recovery message such as `Couldn't load the latest state. Retrying...`
- continue retrying automatically in the background

Recommended retry behavior:

- use backoff rather than a tight loop
- treat transient failures aggressively
- keep slower retry cadence for long-lived hard failures such as missing worker/auth/session
- cancel or supersede recovery when the user opens another session

Design principle:

- never fail closed in the session UI if the user can still benefit from stale chat context

## Data Flow

### New cross-worker open flow

1. User clicks a session in another worker.
2. The app immediately routes to that session and renders snapshot or cold placeholder.
3. The app marks the session as hydrating and disables send.
4. Worker activation and reconnect begin in the background.
5. Selected-session truth loads after attach succeeds.
6. On success, snapshot data is replaced by backend truth and the session becomes ready.
7. On failure, inline recovery status appears and retry continues automatically.

### What leaves the critical path

The first visual response must no longer wait for:

- worker activation completion
- connection health checks
- session list refresh
- provider refresh
- permission refresh for unrelated sessions

Those tasks may still be required for correctness, but they no longer block the first visible session render.

## Testing Strategy

### Unit tests

- cross-worker open routes immediately before worker activation finishes
- cached snapshot is rendered while hydration is pending
- cold session renders inline loading placeholder without fullscreen overlay
- send remains disabled until ready
- retry state transitions keep the view alive and continue automatically
- superseding one pending hydration with another cancels stale recovery work

### App wiring tests

- prefetch runs only for visible expanded workers
- prefetch is limited to recent `3-5` sessions
- collapsing a worker stops scheduling new snapshot prefetches
- successful truth load replaces stale snapshot content

## Acceptance Criteria

- Clicking a session in another worker opens the session view immediately.
- The fullscreen loading overlay is not used for this flow.
- If a cached or prefetched snapshot exists, the user sees chat content right away.
- If no snapshot exists, the user sees an inline loading state in the message box.
- Draft typing can remain available during hydration.
- Sending is disabled until the selected session reaches ready state.
- Only visible expanded workers participate in session snapshot prefetch.
- Prefetch is limited to a small recent-session window per eligible worker.
- Attach or hydrate failure does not collapse the view or stop the flow; Veslo surfaces the issue and keeps retrying automatically.
