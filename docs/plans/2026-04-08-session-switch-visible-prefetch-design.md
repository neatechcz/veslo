# Session Switch Visible Prefetch Design

## Problem

Session switching currently blocks on a foreground load path:

- the UI shows a fullscreen `pendingSessionLoad` overlay
- `selectSession()` waits on `global.health()`, `session.messages()`, `session.todo()`, and `permission.list()`
- the sidebar becomes effectively unusable during the switch because the fullscreen layer captures input

That behavior is too slow for the target interaction. The user goal is to make the chat transcript appear within roughly `200-500 ms` for visible sessions in the left menu, while all remaining work happens in the background.

## Goals

- Remove the fullscreen session loading page entirely.
- Keep the left sidebar clickable during every session switch.
- Show the target chat transcript as fast as possible after a click.
- Warm visible sidebar sessions before the click so the switch path is usually a cache hit.
- Move all non-critical loading behind the first transcript paint.
- Keep all expensive loading on the backend so the UI only consumes ready snapshots.

## Non-Goals

- Reworking workspace switching overlays.
- Changing OpenCode session semantics or upstream APIs.
- Prefetching every session in a workspace.
- Making todos, permissions, artifacts, or secondary metadata part of the critical path.

## Architecture

### Transcript-first switching

The transcript becomes the only first-paint dependency for session switching.

- `route + selected session id` update immediately on click
- the center pane renders from a warmed transcript snapshot when available
- todos, permissions, artifacts, and other secondary data hydrate later

The chat transcript is therefore the product surface we optimize first. Everything else is background work.

### Backend visible-session prefetch coordinator

Add a backend coordinator in `packages/server` that tracks a workspace-scoped interest set for visible sidebar sessions.

Responsibilities:

- accept visible session IDs from the UI
- prioritize them by viewport order, with `selectedSessionId` highest
- warm transcript snapshots by calling the OpenCode upstream on the server side
- deduplicate repeated requests for the same `workspaceId + sessionId`
- enforce low-priority, bounded background work
- expose warmed snapshots back to the app

The coordinator owns:

- a `warm transcript cache`
- a `low-priority prefetch queue`
- per-workspace invalidation and TTL handling

### App-side hydrated transcript store

The UI should not fetch OpenCode directly for visible sessions after every click. Instead:

- the app asks the Veslo server to warm visible sessions
- the Veslo server returns any already-warm transcript snapshots in the background
- the app hydrates those snapshots into the existing per-session message store

This gives the click path a local, already-renderable transcript most of the time, without moving expensive prefetch work into the UI.

## Data Flow

### 1. Sidebar reports visible sessions

Whenever the visible rows change in the left menu, the UI sends the backend:

- `workspaceId`
- `visibleSessionIds`
- `selectedSessionId`
- viewport order priority
- transcript limit, matching the initial session window

This request does not block rendering. It only updates backend prefetch interest.

### 2. Backend warms transcript snapshots

The Veslo server prefetch coordinator:

- looks up visible sessions for the workspace
- queues uncached or stale sessions
- fetches transcript messages and parts from OpenCode
- stores the result as a `warm snapshot`
- returns any snapshots that are already available

Recommended endpoint shape:

- `POST /workspace/:id/sessions/transcript-prefetch`
- `GET /workspace/:id/sessions/:sessionId/transcript`

The batch endpoint is for visible-session background warming. The single-session endpoint is the fallback for cold misses.

### 3. App hydrates warmed snapshots in the background

As the server returns warm snapshots, the app writes them into the existing session store keyed by `sessionId`.

The hydrated snapshot contains the minimum data needed for immediate chat rendering:

- message infos
- message parts
- basic session header metadata
- snapshot freshness metadata

The UI can therefore switch to a visible session without waiting for a new transcript fetch.

### 4. Click path

When the user clicks a session:

- update the route immediately
- update `selectedSessionId` immediately
- render the transcript from hydrated local state if present
- if the transcript is missing, show a lightweight inline loading state only in the center message box
- fetch the single-session transcript from the backend as a fallback

There is no fullscreen session loading screen in this flow.

### 5. Secondary hydration

Only after the transcript is visible do we hydrate:

- todos
- permissions
- artifacts
- detailed run state
- secondary refreshes needed for continued interaction

These requests must never block the transcript render.

## Performance And Failure Guardrails

### Performance rules

- Prefetch is backend-only and low priority.
- Foreground session open always outranks prefetch.
- Prefetch is deduplicated per `workspaceId + sessionId`.
- Prefetch is cancelable when a session is no longer visible and not selected.
- The cache is bounded by:
  - max sessions per workspace
  - max transcript size per session
  - total memory budget
- No per-click global health check should sit on the critical path for a warm transcript switch.

### Failure behavior

- If a prefetch fails, the session remains cold and the UI falls back to inline loading in the message box.
- If the cache evicts a session, the system still works; only the instant switch benefit is lost.
- If a fresher transcript arrives while the session is open, the UI merges it quietly without reintroducing a blocking overlay.
- If the backend is busy, prefetch is throttled or paused before user-triggered work is affected.

## UI Behavior

- Remove the fullscreen `pendingSessionLoad` overlay entirely.
- Keep the left sidebar interactive during every switch.
- Show loading only inside the center message box, and only for a cold transcript miss.
- Preserve workspace switch overlays for actual workspace changes, but do not conflate them with session switching.

## Testing And Rollout

### Metrics

Track at least:

- click timestamp
- route change timestamp
- transcript first paint timestamp
- secondary hydration complete timestamp
- warm hit vs cold miss

### Automated testing

- unit tests for prefetch queue, cache eviction, dedupe, and invalidation
- unit tests for visible-session reporting from the sidebar
- integration tests for transcript-first selection behavior
- e2e coverage in the desktop runtime for repeated session switching

### Rollout

- release behind a feature flag or internal toggle first
- compare current session-switch latency with warm-hit and cold-miss latency
- verify that prompt sending and the active session are not slowed down by background prefetch
- remove the legacy fullscreen session-loading flow after the new path is proven

## Acceptance Criteria

- Visible prefetched sessions usually render the target chat within `200-500 ms`.
- Cold sessions still avoid a fullscreen blocker and keep the sidebar clickable.
- The transcript is the first painted session content.
- Secondary data loads only after transcript visibility.
- Background prefetch does not degrade the active user experience.
