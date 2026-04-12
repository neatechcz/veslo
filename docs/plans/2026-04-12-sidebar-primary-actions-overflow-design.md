# Sidebar Primary Actions Overflow Design

## Summary

The session sidebar should promote only the two task-creation actions that matter most for non-technical users:

- `New`
- `Add directory / project`

All utility controls that do not create new work should move behind a third, equally sized overflow button (`…`).

This change is intentionally about visual hierarchy and progressive disclosure, not about introducing new sidebar capabilities. Archived sessions should no longer appear through an inline sidebar toggle. Instead, the overflow menu should provide a single `Archived items` entry that opens the already existing archived-session list in `Settings`, where users can review and unarchive items.

## Goals

- Make the top of the sidebar read as "what can I start right now?" instead of "all available controls."
- Keep `New` and `Add directory / project` equally prominent.
- Reduce persistent visual noise from sorting, search, and archive utilities.
- Reuse the existing archived-session settings surface instead of splitting archive management across two places.
- Keep sidebar behavior understandable for BFU users without removing power-user access.

## Non-Goals

- Redesigning the existing archived-session rows or unarchive behavior in `Settings`.
- Adding a new dedicated archive screen or a new settings tab.
- Changing session sorting logic or archive semantics.
- Changing the `New` action's underlying behavior beyond its visual placement.
- Adding any extra actions to the overflow menu beyond the approved list.

## Product Decisions

### Top Rail

The sidebar control rail should contain exactly three top-level buttons:

1. `New`
2. `Add directory / project`
3. `…`

All three buttons should share the same visual weight:

- same height
- same corner radius
- same border treatment
- same typography
- same hover/focus behavior

The only difference should be content:

- `New` uses the existing new-session affordance
- `Add directory / project` uses a folder-plus style icon and explicit text
- `…` uses the overflow glyph and no additional copy

### Overflow Menu Contents

The overflow menu may contain only these items:

- `Archived items`
- `Search`
- `By project`
- `Recent`

No group labels, no extra helper rows, and no additional actions should be added.

### Archived Items Behavior

`Archived items` is not a toggle and not an inline sidebar filter.

Clicking it should open the already existing archived-session list in `Settings > General`, where the user can:

- view all archived sessions
- unarchive sessions

The current sidebar-level `Show archived` behavior should be removed completely.

### Search Behavior

`Search` should keep using the current session-search flow. In views where no search callback is available, the menu item should be hidden rather than rendered as a dead control.

### View Mode Behavior

`By project` and `Recent` stay as the two available sidebar ordering modes, but they move into the overflow menu.

They should behave as mutually exclusive choices with a visible active state. The active state should be shown with lightweight row emphasis such as:

- a checkmark, or
- a selected row style

No separate toggle control is needed inside the menu.

## UX And Interaction Details

### Visual Hierarchy

This design intentionally moves from "toolbar" thinking to "primary actions plus utilities":

- `New` and `Add directory / project` remain always visible
- sorting, search, and archive management become secondary
- the sidebar immediately communicates task creation rather than configuration

This follows Veslo's `Progressive disclosure by default` principle in `PRINCIPLES.md`.

### Menu Placement

The overflow menu should:

- open directly below the `…` button
- align visually with the button row
- remain compact and lightweight
- close on outside click
- close after invoking an action

### Accessibility

The new arrangement must preserve the existing tooltip and screen-reader pattern:

- visible controls continue using `data-tooltip`
- controls and menu items expose accessible labels
- keyboard navigation should work for menu open/close and item activation

The `…` button should announce a meaningful label such as `More actions`, not just punctuation.

## State Model And Cleanup

The sidebar should no longer own any archived-session visibility preference.

That means removing the local preference storage and related UI for:

- `veslo.sidebar-show-archived.v1`
- `readShowArchivedSessions`
- `writeShowArchivedSessions`
- the `showArchivedSessions()` signal and toggle button

Archived sessions should simply be excluded from the regular sidebar list. Archive management remains available through the existing settings surface.

The existing archived-session row actions do not change in this design. Only the top-level archive-entry affordance changes.

## Architecture Notes

The main UI change belongs in:

- `packages/app/src/app/components/session/workspace-session-list.tsx`

The existing settings entry point already exists in both parent surfaces:

- `packages/app/src/app/pages/session.tsx`
- `packages/app/src/app/pages/dashboard.tsx`

The sidebar component should therefore gain a dedicated callback for opening archived items, and the parent views should wire that callback to the existing `openSettings("general")` flow instead of inventing a new navigation mechanism.

## Localization

The sidebar copy will need updated locale keys because the visible CTA text changes.

Expected localization work:

- add a new label for `Add directory / project`
- add a meaningful accessible label for the `…` button
- add a new menu item label for `Archived items`
- remove the now-obsolete `sidebar.show_archived` key

Locale parity must be preserved across the locale files already carrying sidebar copy.

## Testing Requirements

Implementation must update the existing source-contract tests around the sidebar rail and add focused coverage for the new overflow menu contract.

Required coverage:

- top rail order is `New` -> `Add directory / project` -> `…`
- top-level tooltip coverage reflects the new visible controls
- overflow menu contains only the approved items
- `Archived items` opens the existing settings/general archive surface
- `By project` and `Recent` still map to the existing sidebar mode state
- `Search` still maps to the current session search callback
- archived sessions are no longer displayed through a sidebar visibility preference
- archived-session preference storage helpers are removed

Required end-to-end verification after implementation:

- run the real Tauri desktop flow, not `packages/web`
- confirm the overflow menu and archive navigation path in the desktop runtime
- capture screenshots of the updated sidebar and archived-items destination if the change is prepared for PR review

## Final Decision

The approved design is:

- three equally prominent top-level sidebar buttons: `New`, `Add directory / project`, `…`
- overflow menu contains only `Archived items`, `Search`, `By project`, and `Recent`
- `Archived items` opens the existing archived-session list in settings
- the old `Show archived` sidebar toggle and its persistence are removed
