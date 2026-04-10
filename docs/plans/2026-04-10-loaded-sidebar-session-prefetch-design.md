# Loaded Sidebar Session Prefetch Design

## Problem

The current visible-session prefetch implementation improved session switching, but it still uses the wrong interest model for the sidebar.

Today:

- the app reports only rows that are currently visible in the sidebar viewport
- the server queue warms only a small bounded subset per update
- sessions that are already loaded in the sidebar but scrolled out of view can remain cold
- subagents are not handled with the product rules the user asked for

That does not match the intended UX. The target behavior is:

- every session currently loaded in the left sidebar should be warmed in the background
- this applies to both sidebar modes: `by folder` and `recent`
- subagents should not be prefetched while collapsed
- once subagents are expanded, they should start warming in the background immediately, ordered from newest to oldest
- if the user clicks a session or subagent, that target must be prioritized immediately

## Goals

- Treat the entire currently loaded sidebar dataset as the prefetch interest set, not just the viewport.
- Keep prefetch scoped to sessions already loaded by the sidebar.
- Support both sidebar modes with the same correctness guarantees.
- Warm expanded subagents only after expansion.
- Prioritize clicked and selected sessions above the rest of the queue.
- Keep all expensive transcript work on the backend.
- Preserve transcript-first switching and inline-only loading on cache misses.

## Non-Goals

- Prefetching every session in a workspace.
- Prefetching sessions that have not been loaded yet via `Load more`.
- Prefetching collapsed subagents.
- Moving transcript warming back into the UI.
- Reintroducing any fullscreen session loading state.

## Architecture

### Loaded-sidebar interest model

Replace the current `viewport-visible session` interest model with a `loaded sidebar session` interest model.

The sidebar becomes the source of truth for prefetch interest:

- if a session row is currently loaded in the sidebar dataset, it is eligible for background warming
- if a session row is not yet loaded because the user has not clicked `Load more`, it is out of scope
- if a subagent row is collapsed, it is out of scope
- if a subagent row is expanded and loaded, it becomes eligible immediately

This keeps prefetch aligned with what the user can realistically navigate to next, without widening the scope to the whole workspace.

### Three interest buckets

The app should report three logical buckets per workspace:

1. `clickedSessionId`
- the latest explicit user click target, whether top-level or subagent

2. `selectedSessionId`
- the currently selected session, if any

3. loaded rows
- `loadedTopLevelSessionIds`: all currently loaded top-level sidebar rows in sidebar order
- `expandedSubagentSessionIds`: all currently loaded subagent rows that are visible because their parent branch is expanded

The server queue will derive priority from these buckets rather than treating all IDs the same.

### Sidebar-mode semantics

#### `recent`

The interest set is the full currently loaded recent list.

That means:
- all loaded recent rows are candidates for warming
- nested subagent rows only count once they are expanded and loaded into the list
- clicking `Load more` extends the loaded recent list and therefore extends prefetch interest

#### `by folder`

The interest set is the full currently loaded top-level list for every currently shown workspace/folder group.

That means:
- each visible group contributes its loaded top-level rows
- subagents are excluded while collapsed
- expanded subagents join the interest set only when their parent is opened
- clicking `Load more` for a group extends only that group's loaded top-level set

### Server-owned warm cache

The server remains responsible for:

- maintaining a workspace-scoped transcript cache
- deduplicating repeated transcript loads
- keeping foreground transcript fetches ahead of background prefetch
- protecting active interest items from avoidable eviction

The main semantic change is that `bounded background work` should no longer mean `load only the first few items from the loaded sidebar set`.

Instead it should mean:
- low concurrency
- bounded memory
- bounded transcript size per session
- but eventual warming of the whole currently loaded interest set

## Data Flow

### 1. Sidebar derives loaded interest

Whenever the loaded sidebar dataset changes, the app derives per-workspace prefetch interest from:

- current sidebar mode
- loaded top-level rows
- expanded subagent rows
- selected session
- latest clicked session, if present

Changes that should trigger recomputation:

- switching between `recent` and `by folder`
- clicking `Load more`
- expanding or collapsing a branch
- clicking a session or subagent row
- data refresh that changes the loaded row set

### 2. App reports interest in the background

The app sends background interest updates to the Veslo server, per workspace, containing:

- `clickedSessionId`
- `selectedSessionId`
- `loadedTopLevelSessionIds`
- `expandedSubagentSessionIds`
- transcript limit for the initial chat window

These requests never block rendering.

### 3. Server rebuilds the queue from current interest

The server treats each update as the latest truth for that workspace.

Priority order:

1. `clickedSessionId`
2. `selectedSessionId`
3. `expandedSubagentSessionIds` ordered newest to oldest
4. `loadedTopLevelSessionIds` in sidebar order

Queue behavior:

- warm snapshots drop out immediately
- stale snapshots stay queued until refreshed
- items removed from interest are removed from queue
- expanded subagents disappear from interest when the branch collapses
- a click promotes that target to the front even if it was previously deeper in the queue

### 4. Server drains the whole loaded interest set

The queue should keep draining until the currently loaded interest set is warm, subject to concurrency and memory limits.

This is the core behavior change from the current implementation.

The server may still:
- limit concurrent transcript fetches
- cap cache size per workspace
- evict non-interest items first

But it should not stop after warming only a small prefix of the loaded set.

### 5. App hydrates warm snapshots

The app continues to hydrate returned transcript snapshots directly into the per-session store.

This preserves the current transcript-first click path:

- click updates route and selection immediately
- if the transcript is already hydrated, chat renders immediately
- if not, inline loading appears only in the center pane
- todos, permissions, artifacts, and other secondary data hydrate later

## Queue Semantics And Guardrails

### Priority rules

Priority must be deterministic and stable:

- the latest clicked session or subagent always wins
- the selected session is next
- expanded subagents outrank non-subagent remainder rows
- top-level rows preserve sidebar order

If the same session appears in multiple buckets, it should only appear once at its highest priority.

### Coverage rules

The server must aim to warm the whole loaded set, not just the viewport and not just a short prefix.

That includes:
- all loaded rows in `recent`
- all loaded top-level rows in `by folder`
- all loaded expanded subagents

That excludes:
- not-yet-loaded rows behind `Load more`
- collapsed subagents
- non-sidebar sessions

### Eviction rules

Interest-aware eviction should prefer dropping:

1. non-interest sessions
2. stale non-selected sessions
3. oldest untouched sessions outside the loaded set

Loaded interest items should not be evicted while they remain part of the current interest set unless memory pressure forces it.

### Failure rules

- A failed session load must not stall the rest of the queue.
- A failed item remains cold and falls back to the normal inline-loading path on click.
- If the backend is busy, reduce concurrency before reducing coverage of the loaded set.
- Foreground session fetches always outrank background prefetch.

## UI Behavior

- The left sidebar remains clickable during all session switches.
- No fullscreen session loading overlay is reintroduced.
- `Load more` extends the background warming scope only after the user clicks it.
- Expanding a branch starts background warming for newly visible subagents immediately.
- Clicking a session or subagent reprioritizes its transcript load immediately.

## Testing And Acceptance

### Unit tests

- sidebar interest derivation for `recent` includes all loaded rows, not just the viewport
- sidebar interest derivation for `by folder` includes all loaded top-level rows per workspace group
- collapsed subagents are excluded
- expanded subagents are included in newest-to-oldest order
- `Load more` extends the interest set only after activation
- queue reprioritizes clicked sessions above the rest
- queue continues draining until all interest items are warm
- interest-aware eviction keeps loaded items longer than non-interest items

### Integration tests

- switching among loaded sidebar sessions is usually a warm hit
- expanding a branch starts warming subagents in the background
- clicking a freshly expanded subagent promotes it ahead of remaining queue work
- `Load more` appends new sessions to warming without affecting already warmed ones

### Acceptance criteria

- Every session currently loaded in the sidebar is eventually warmed in the background.
- This works in both `recent` and `by folder` modes.
- Collapsed subagents are not warmed.
- Expanded subagents are warmed newest to oldest.
- Clicking any loaded session or subagent gives it immediate priority.
- Nothing outside the currently loaded sidebar dataset is prefetched.
- Transcript-first switching and inline-only loading behavior remain intact.
