# Session Branch Toggle Overlay Design

## Goal

Replace the inline session-branch toggle (`>` / `v`) with a centered overlay chevron below the session title, and change session-branch visibility to explicit user control only.

## Approved Product Behavior

1. Parent sessions that have subagents start collapsed in both sidebar modes (`recent` and `by-project`).
2. Creating a new subagent never auto-expands its parent branch.
3. Selecting a child session never auto-expands ancestor branches.
4. Session branches expand or collapse only when the user clicks the dedicated branch toggle.
5. Session row click behavior stays unchanged:
   - clicking a row still opens/selects the session
   - when the currently selected row is a parent session, the existing selected-row click behavior remains intact
6. The current inline text toggle before the title is removed.
7. The replacement toggle uses the same visual language as the dashboard nav collapse control:
   - small circular button
   - subtle border/shadow
   - chevron icon
8. The new toggle is visually centered below the session title instead of occupying horizontal title space.
9. The change must not alter the vertical rhythm between session title lines in the sidebar.

## Scope

In scope:

- `packages/app` session sidebar rendering and expansion behavior
- session list model helpers/tests related to expansion
- layout/interaction tests for recent and project session rows

Out of scope:

- server-side session tree state
- persistence of expanded/collapsed session branches across app restarts
- changes to message timeline subagent rendering
- changes to project-level collapse behavior

## Architecture

The sidebar already tracks expanded parents locally with `expandedParentSessionIds`. That state remains the single source of truth, but it will no longer be synchronized from `selectedSessionId` or from newly appearing child sessions.

The current selection-driven auto-expand effect in `WorkspaceSessionList` should be removed. The helper that derives expanded parents from the selected session can then be deleted, along with its tests, because it encodes the exact behavior we no longer want.

Rendering remains tree-based:

- row visibility is still computed from `rowVisibleByExpansion(...)`
- parent rows still decide whether they have children using the existing hierarchy lookup
- the dedicated toggle still calls `handleSessionExpandToggle(...)` and still stops propagation so it does not trigger row open/select behavior

## UI Layout

### Current problem

Rows with child sessions currently reserve horizontal space before the title for a tiny inline toggle. That creates a left-edge wobble where some titles begin later than others within the same nesting level.

### New layout

For rows with children:

- remove the inline toggle from the title row
- keep the title text aligned with sibling rows at the same nesting level
- render a small circular chevron button as an absolutely positioned overlay inside the row content area
- place the button horizontally centered under the title/content column, not in the left gutter

The button should feel visually borrowed from the control in `sidebar-dashboard-nav.tsx`, but the icon direction should still reflect branch state:

- collapsed branch: `ChevronRight`
- expanded branch: `ChevronDown`

### Vertical spacing constraint

The overlay button must not become its own layout row. It should sit inside existing row bounds so that:

- the title baseline stays where it is today
- `space-y-0`, `py-1`, and the current row stack cadence remain unchanged
- nested session labels do not drift vertically relative to neighboring labels

This means the button should be positioned with absolute coordinates rather than inserted as a normal block element.

## Indentation Rules

The change removes only the extra horizontal offset caused by the inline parent-toggle slot.

It does not remove the structural nesting indent for subagent rows. Child sessions should continue to be indented via the existing nesting-level padding so the tree remains legible.

Net result:

- parent rows with children align their titles with rows that do not have children
- child rows remain visibly nested under their parent

## Interaction Details

1. Clicking the centered chevron toggles only branch visibility.
2. The toggle keeps localized `aria-label` and `title` strings for expand/collapse.
3. Clicking elsewhere on the row keeps existing row-open behavior.
4. Keyboard activation on the row remains unchanged.
5. The toggle remains available in both `recent` and `by-project` session rendering paths.

## Risks and Mitigations

1. Overlay button may visually collide with timestamps or metadata in compact rows.
   - Keep the button centered in the content column and leave the existing right-side timestamp/menu rail untouched.
2. Removing auto-expand may hide the selected child session from the visible tree.
   - This is intentional and matches the approved product rule: visibility changes only through explicit user action.
3. Source-based tests may become brittle when the markup is refactored.
   - Update the tests to assert the new invariants directly: no inline text toggle, no selected-session auto-expand wiring, centered overlay chevron present.

## Testing Strategy

1. Model tests:
   - remove or replace the selected-session auto-expand contract
   - keep hierarchy/visibility behavior for explicitly expanded parents
2. Interaction tests:
   - verify the dedicated toggle still stops propagation and only toggles branch state
   - verify the selected-session auto-expand wiring is gone
3. Layout tests:
   - verify recent/project rows keep tight vertical spacing
   - verify the new toggle is rendered as an overlay centered below the title
   - verify the old inline `>` / `v` text toggle is gone
4. Full unit verification:
   - run the targeted sidebar tests first
   - then run the full app unit suite
