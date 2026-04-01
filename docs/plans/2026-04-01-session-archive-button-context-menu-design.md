# Session Archive Button + Context Menu Design

## Goal

Replace session-row three-dot action with an explicit archive action, and move the previous session-row submenu behavior to right-click on session rows.

## Approved Product Behavior

1. Session row primary action on hover is `Archive` (not three dots).
2. Session right-click opens the same submenu that previously opened from three dots.
3. Archiving is non-destructive in this phase:
   - session metadata/messages stay intact
   - files/workspace are untouched
4. Archived sessions are hidden from active list by default.
5. User can reveal archived sessions via a sidebar control (`Show archived`).
6. When archived sessions are visible, clicking the archive action on an archived row unarchives it.

## Scope

In scope:
- `packages/app` session sidebar behavior and preferences
- tests for sidebar preferences and session-row interactions

Out of scope:
- server/cloud archival persistence model
- delete semantics for sessions
- workspace lifecycle changes

## Architecture

Use a local-first UI state for archived sessions in sidebar preferences:
- Persist archived session IDs in `localStorage`.
- Persist `showArchived` boolean in `localStorage`.
- Filter rendered rows in `WorkspaceSessionList` according to these prefs.

No backend API changes are required for this phase. This keeps behavior reversible and low risk while preserving complete session data.

## UX Details

1. Session rows:
   - replace row hover action icon `MoreHorizontal` with `Archive`
   - action label/tooltip changes according to state:
     - non-archived row: `Archive session`
     - archived row: `Unarchive session`
2. Right-click:
   - row `onContextMenu` opens existing workspace/session submenu at the same anchor key
   - default browser context menu is suppressed for session rows
3. Sidebar control:
   - add `Show archived` toggle button near existing sidebar utility controls
   - when active, archived sessions are shown and can be unarchived inline

## Risks and Mitigations

1. Session IDs can appear in multiple grouped views (recent/by-project):
   - archive state keyed by `sessionId`, shared across both views.
2. Existing submenu anchor behavior must stay stable:
   - keep existing `workspaceMenuTarget` mechanism; only change open trigger.
3. Preference corruption in localStorage:
   - normalize parsed payloads and fail closed to safe defaults.

## Testing Strategy

1. Preference unit tests:
   - read/write archived session IDs and showArchived flag.
2. Session list interaction tests:
   - archive icon exists as row action
   - right-click opens menu anchor for session rows
   - filter pipeline uses archived state + showArchived toggle
3. Full app unit suite:
   - ensure no regressions in existing sidebar behavior.
