# Session Subagents Nested Sidebar Design

**Date:** 2026-03-29  
**Status:** Approved

## Summary

Show subagent sessions in the left session list as children of their parent session instead of hiding them completely. Keep behavior local-first and UI-driven: parent rows stay visible, child rows are visible when parent is expanded.

This applies to both sidebar modes:
- `Recent`
- `By project`

Session title hover in the left menu must show full session title (tooltip via `title` attribute).

## Goals

- Preserve visibility of sub-sessions (including completed/ended ones).
- Keep sub-sessions grouped under their parent session.
- Keep primary click behavior unchanged: clicking a different session opens it.
- Add secondary behavior: clicking the already-open parent session toggles child expansion.
- Support identical interaction in `Recent` and `By project`.
- Keep expansion state temporary in memory only (no persistence).

## Non-goals

- Persist expanded/collapsed state across reloads.
- Introduce new API surfaces or server-side hierarchy endpoints.
- Redesign row visuals/timestamps/menu alignment.

## User Interaction Rules

1. Clicking a non-selected session row opens that session (current behavior preserved).
2. Clicking an already-selected parent session row toggles expand/collapse of its sub-sessions.
3. Clicking an already-selected session with no children does nothing new.
4. Session title hover shows full title in both sidebar modes.

## Architecture Decision

Use **Approach A**:

- Keep existing hierarchical model based on `parentID`.
- Stop hard-hiding subagent sessions from sidebar data.
- Apply expansion/collapse as a UI visibility layer in sidebar rendering.

Why:

- Minimal change footprint.
- Reuses existing row hierarchy model/tests.
- Avoids risky refactor of data model contracts.

## Detailed Design

### 1) Session Inclusion for Sidebar Data

Current behavior filters internal child sessions out from sidebar-facing session lists.  
New behavior keeps those sessions available so they can be rendered as children.

Files affected:

- `packages/app/src/app/context/session.ts`
- `packages/app/src/app/app.tsx`

Change intent:

- Remove/relax hard filters that exclude internal subagent sessions from sidebar data flow.
- Keep internal subagent detection metadata if needed for diagnostics/other guards, but do not use it for unconditional sidebar removal.

### 2) Hierarchy + Visibility

Current model already computes:

- `parentSessionId`
- `rootSessionId`
- `nestingLevel`
- ordering with children directly under parent

File:

- `packages/app/src/app/components/session/workspace-session-list-model.ts`

Change intent:

- Preserve current hierarchy behavior.
- Optionally add helper lookup for parent -> children presence to keep rendering efficient and simple.

### 3) Expand/Collapse UI State

File:

- `packages/app/src/app/components/session/workspace-session-list.tsx`

Add:

- in-memory signal (e.g. `expandedParentSessionIds`) for active session tree expansion.
- No `localStorage` writes for this state.

Behavior:

- Parent rows always visible.
- Child rows visible only when their parent is expanded.
- If parent is missing from current loaded slice (orphan child due pagination/limit), child remains visible as fallback root-like row.

### 4) Click Handling

In both `Recent` and `By project` row render paths:

- If clicked row is not selected -> `onOpenSession(...)`.
- If clicked row is selected and has child sessions -> toggle expanded state.
- Otherwise preserve existing no-op behavior.

### 5) Title Hover Tooltip

In both row variants:

- Add `title={session().title}` on the title text element so truncated labels reveal full name on hover.

## Error Handling and Edge Cases

- Missing parent row (pagination/workspace limits): do not hide child; show it.
- Empty/undefined title: tooltip can be empty string; no throw.
- Workspace switching should naturally reset/rehydrate temporary expand state with reactive sidebar rows.

## Testing Strategy

Update/add tests in:

- `packages/app/src/app/components/session/workspace-session-list-model.test.ts`
  - hierarchy retains sub-sessions in output.
  - orphan fallback behavior remains visible.
- `packages/app/src/app/components/session/workspace-session-list-interactions.test.ts`
  - selected parent click toggles expand/collapse behavior.
  - non-selected click still opens session behavior pattern stays intact.
- `packages/app/src/app/components/session/workspace-session-list-recent-layout.test.ts`
  - assert title tooltip wiring for session labels in both views.

## Risks and Mitigations

- Risk: previously hidden internal sessions may appear unexpectedly as top-level rows.
  - Mitigation: strict parent-based visibility + orphan fallback only when parent missing.
- Risk: interaction regressions in one sidebar mode.
  - Mitigation: mirror logic in both render branches and add tests for both.

## Acceptance Criteria

- Subagent sessions are visible in sidebar under their parent session.
- Completed subagent sessions remain visible (not removed after completion).
- Clicking active parent session toggles child visibility.
- Clicking other sessions still opens them.
- Behavior works in `Recent` and `By project`.
- Session title hover shows full title tooltip in left menu.
