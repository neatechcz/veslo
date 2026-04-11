# Cross-Workspace Sidebar Session Prefetch Design

## Problem

The current session transcript prefetch flow still follows a viewport-visible model. In practice, that means only a subset of sessions in the left sidebar are warmed, and the behavior remains biased toward the currently active workspace.

That does not match the intended UX. If a session is already loaded in the left menu and the user can scroll to it and click it directly, it should be a preload candidate even when it belongs to a different workspace.

## Goals

- Preload every session that is already loaded and directly clickable in the left sidebar across all workspaces.
- Keep the preload scope aligned to the real sidebar dataset, not the full workspace history.
- Preserve current transcript-first session switching behavior.
- Keep expensive transcript warming on the Veslo server.
- Maintain strict priority for explicit user navigation over background warming.

## Non-Goals

- Prefetching sessions hidden behind `Load more`.
- Prefetching collapsed subagents.
- Prefetching every session in every workspace.
- Reintroducing fullscreen loading overlays for session switching.
- Moving transcript prefetch orchestration back into the UI.

## Recommended Approach

Use a per-workspace loaded-interest model.

The sidebar becomes the source of truth for prefetch interest across the entire left menu. Instead of reporting only viewport-visible IDs, the app derives a `LoadedSidebarPrefetchInterest` payload for each workspace that currently has loaded, clickable rows in the sidebar. The Veslo server then maintains a separate queue and cache policy for each workspace and warms the full loaded set in the background.

This is the best fit because it preserves the existing backend-owned transcript caching model, keeps API changes scoped, and matches the product rule precisely: preload what is loaded and clickable, nothing more.

## Architecture

Each workspace gets an independent preload-interest payload with this shape:

- `clickedSessionId`
- `selectedSessionId`
- `loadedTopLevelSessionIds`
- `expandedSubagentSessionIds`

Rules:

- `loadedTopLevelSessionIds` includes all currently loaded top-level rows for that workspace that are directly reachable in the left sidebar.
- `expandedSubagentSessionIds` includes only loaded child rows whose parent branch is expanded.
- Rows hidden behind `Load more` are excluded.
- Collapsed subagents are excluded.

The app reports interest per workspace. The server accepts the richer payload and rebuilds a workspace-scoped priority queue from it. Foreground session opens still outrank background warming at all times.

## Data Flow

### 1. Sidebar derives loaded interest

`workspace-session-list.tsx` stops deriving `visibleSessionIds` from the viewport. Instead, it derives loaded clickable rows for every workspace represented in the current sidebar dataset.

Mode semantics:

- `recent`: include all loaded recent rows across workspaces.
- `by folder`: include all loaded top-level rows from each visible group.
- Expanded subagents are added only when their parent branch is open and the child row is currently loaded.

### 2. Pages report workspace-scoped interest

`session.tsx` and `dashboard.tsx` switch from a `visibleSessionIds` callback to a richer loaded-interest callback such as:

```ts
type LoadedSidebarPrefetchInterest = {
  clickedSessionId: string | null;
  selectedSessionId: string | null;
  loadedTopLevelSessionIds: string[];
  expandedSubagentSessionIds: string[];
};
```

These pages do not re-scope the request to the active workspace. They simply resolve the Veslo workspace ID and send the interest payload for the target workspace.

### 3. Server rebuilds a queue per workspace

The transcript-prefetch endpoint accepts the richer payload and rebuilds a queue in this deterministic order:

1. `clickedSessionId`
2. `selectedSessionId`
3. `expandedSubagentSessionIds`
4. `loadedTopLevelSessionIds`

Duplicates are removed, but each session keeps its highest-priority position.

### 4. Server drains the full loaded set

The background pump keeps warming until the current loaded interest set is exhausted, subject to low concurrency and cache limits. It should no longer stop after warming a short prefix of the queue.

### 5. App hydrates warm snapshots

The app continues to hydrate prefetched transcript snapshots into the session store so that switching to a warmed session can render immediately, while slower secondary data hydrates later.

## Guardrails

- Foreground session opens always outrank background prefetch.
- Prefetch requests must never block rendering or session navigation.
- Failure to warm one session must not stall the rest of the queue or other workspaces.
- The server must not widen scope beyond the current loaded sidebar interest.
- Interest removal must remove sessions from the queue when rows leave the loaded sidebar dataset.
- Cache and queue limits stay bounded per workspace.
- Existing workspace-switch guard behavior must remain intact so stale session-store rows do not temporarily overwrite sidebar state.

## Testing

### App unit tests

- Loaded-interest derivation includes all loaded clickable rows across workspaces.
- `recent` mode is not limited to viewport-visible rows.
- `by folder` mode groups rows under the correct workspace.
- Expanded subagents are included and collapsed subagents are excluded.
- Removed rows clear prior reported interest.

### Server unit tests

- The richer payload is parsed correctly.
- Queue ordering is deterministic and deduplicated.
- Queue state remains isolated per workspace.
- The background pump covers the full loaded set, not just a short prefix.
- A failure on one session does not block the rest of the queue.

### Desktop runtime / E2E

- Sessions visible in the left menu across multiple workspaces warm in the background.
- Clicking a warmed session from a non-active workspace avoids a cold switch in the common case.
- Session switching does not reintroduce fullscreen loading overlays.
- `Load more` only extends the prefetch set after the user requests it.
- Collapsing a branch stops warming its hidden subagents.

## Acceptance Criteria

- Every session that is already loaded and directly clickable in the left sidebar is a preload candidate, regardless of workspace.
- Sessions hidden behind `Load more` or collapsed subagent branches are not preload candidates.
- Background prefetch does not degrade foreground session switching or workspace-switch UX.
