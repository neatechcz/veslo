# Session List Windowing Design (By Project + Recent)

Date: 2026-03-28  
Status: Approved

## Context

The left session sidebar currently renders all rows returned for a workspace. This does not scale for directories with tens or hundreds of sessions.

The requested UX is:

- In **By project** mode, show at most **7 rows per project** by default.
- Additional rows for a project are revealed in **batches of +20**.
- In **Recent** mode, initially show **what fits in viewport + ~3 rows** (scroll affordance), then continue via infinite scroll.
- Infinite scroll must have an explicit **Load more (+20)** fallback control.
- Expanded visibility is **ephemeral** (reset on workspace switch/reload/restart).

## Goals

- Keep sidebar responsive with large session counts.
- Keep current sorting and subagent hierarchy behavior.
- Avoid loading and rendering large lists eagerly.
- Provide explicit user control for incremental reveal.

## Non-goals

- Persisting expanded visibility in localStorage.
- Reworking session sorting rules.
- Backend API redesign in this iteration.

## Constraints

- Existing OpenCode session listing API in current integration is limit-based and does not expose cursor pagination in this flow.
- Current sidebar refresh path uses a high static limit; this must become progressive.

## Proposed Architecture

### 1) Data Window (workspace-scoped)

Introduce a workspace-scoped pagination state for sidebar sessions:

- `itemsByWorkspaceId`
- `loadedCountByWorkspaceId`
- `hasMoreByWorkspaceId`
- `loadingMoreByWorkspaceId`

Loading strategy:

- Initial fetch uses `PAGE_SIZE = 20`.
- `loadMoreWorkspaceSessions(workspaceId, amount = 20)` increases requested limit and refetches.
- Results are deduped by `session.id`, stable-sorted, then mapped into sidebar items.
- `hasMore` remains true while last fetch reaches requested boundary (heuristic until cursor API exists).

This keeps implementation compatible with current API and makes a cursor transition straightforward later.

### 2) View Window (mode-specific)

#### By project

- Keep current grouping/hierarchy model.
- Add per-project visible row count state:
  - default `7`
  - increment `+20` on explicit project-level action.
- CTA is shown only when hidden rows exist for that project.

#### Recent

- Compute initial visible rows as:
  - `floor(scrollContainerHeight / estimatedRowHeight) + 3`
- Render only the visible prefix.
- Use bottom sentinel for infinite scroll:
  - if there are already-loaded hidden rows, increase visible count locally.
  - if local rows are exhausted and `hasMore = true`, fetch another `+20` data window.
- Always expose fallback button: `Load more (+20)`.

### 3) Render Layer

Preserve `workspace-session-list-model.ts` as canonical source for:

- sort order
- hierarchy
- project grouping

Apply windowing after model build (slice/window operations), not inside sorting/hierarchy logic.

## UX Details

### By project

- Each project starts collapsed/expanded as today (existing behavior unchanged).
- Inside expanded project content, render first 7 rows.
- Show row-level continuation control under the project rows:
  - compact `…` affordance + explicit label (`Load 20 more`) where locale allows.

### Recent

- Maintain scroll affordance with initial overrun (`+3`).
- Infinite load is non-blocking; fallback button remains available for reliability/accessibility.

## State Reset Rules

All visibility window state is reset when:

- app restarts
- workspace context changes
- sidebar dataset is fully refreshed/replaced

No persistence of window expansion.

## Error Handling

- If load-more fetch fails:
  - keep already visible rows
  - set per-workspace load-more error state
  - expose retry via the same control
- Prevent duplicate concurrent load-more calls with `loadingMoreByWorkspaceId[workspaceId]` guard.

## Performance Notes

- Initial payload reduced from static large list to progressive 20-row windows.
- Rendering cost bounded by mode/window state.
- Recompute grouping only when underlying data changes; view window changes should be cheap slices.

## Testing Strategy

### Model tests

- Per-project default visibility = 7.
- Per-project increments by +20 and preserves order.
- Subagent parent-child ordering remains intact under windowing.

### Interaction/layout tests

- By-project CTA visible only when hidden rows exist.
- Recent initial visible count follows `fit + 3` rule.
- Infinite scroll increases visible rows.
- Fallback `Load more` works without IntersectionObserver.

### State tests

- Load-more guard blocks parallel fetches.
- Visibility state resets on workspace switch and data replacement.
- Fetch error preserves existing rows and supports retry.

## Rollout Notes

- This is designed to work immediately with current limit-based list API.
- If cursor pagination is introduced later, Data Window can switch from limit stepping to cursor consumption without changing View Window UX.
