# Archived Sessions Settings Tab Design

## Summary

The Settings screen already contains a working archived-session management block, but it is currently embedded at the top of `General`. This makes the `Archived items` entry in the sidebar feel misleading because it opens `Settings` without a dedicated archive destination.

The approved change is to promote archived-session management into its own first-class settings tab, alongside the existing `General`, `Model`, and `Advanced` tabs. The sidebar action `Archived items` should open this new `Archived` tab directly.

This is a navigation and information-architecture fix, not a rewrite of archive storage, archive semantics, or unarchive behavior.

## Goals

- Add a dedicated `Archived` settings tab next to `General`, `Model`, and `Advanced`.
- Move the existing archived-session settings block out of `General` and into that tab.
- Route the sidebar action `Archived items` directly to `Settings > Archived`.
- Keep the current archive data source and unarchive flow intact.
- Preserve the current empty state and "unavailable on this device" messaging.

## Non-Goals

- Changing how sessions are archived or unarchived in the backend.
- Introducing a new standalone dashboard page outside Settings.
- Redesigning the archived-session row visuals beyond the minimum needed for the tab move.
- Changing archive availability detection or workspace matching logic.
- Changing the developer-only `Debug` tab behavior.

## Product Decisions

### Settings Information Architecture

Settings should expose the following user-facing tabs:

- `General`
- `Archived`
- `Model`
- `Advanced`

`Debug` remains conditional on developer mode and continues to appear only when enabled.

The new `Archived` tab is a peer of the other tabs, not a subsection nested under `General`.

### Archived Tab Content

The new tab should reuse the existing archived-session management UI and behavior that already lives in `settings.tsx`:

- archived-session count badge
- archived-session rows sorted by archive recency
- archived timestamp display
- "Unavailable on this device" badge when applicable
- `Unarchive` action wired to the existing handler
- empty state when there are no archived sessions

This content should move as-is into the new tab rather than being duplicated or redesigned.

### General Tab Cleanup

Once the archive block moves, `General` should contain only general settings concerns such as:

- providers
- appearance
- language

Archive management should no longer appear in `General`.

### Sidebar Navigation Behavior

The sidebar overflow action `Archived items` should open the Settings screen with the new `Archived` tab selected.

This applies consistently from both parent surfaces that host the session sidebar:

- `packages/app/src/app/pages/dashboard.tsx`
- `packages/app/src/app/pages/session.tsx`

The current `openSettings("general")` wiring for archived items should be replaced with `openSettings("archived")`.

## Architecture Notes

### Existing Data Flow Stays Intact

No archive data plumbing changes are needed.

The app already exposes archived sessions through:

- `sessionArchiveRecords`
- `sessionArchives()`
- `toSessionArchiveItem(...)`
- `listSessionArchives()`
- `deleteSessionArchive(...)` for unarchive

The new tab should continue to receive `props.sessionArchives` and `props.onUnarchiveSession` exactly as the current Settings screen does today.

### Tab Model Changes

The settings tab model must treat `archived` as a first-class tab, which means updating:

- `packages/app/src/app/types.ts`
- `packages/app/src/app/lib/settings-tab-label.ts`
- any visible-tab resolution that currently assumes only `general`, `model`, and `advanced`

The visible-tab resolver should keep `archived` available regardless of developer mode, while still gating `debug` behind developer mode.

### Localization

The tab bar needs a dedicated localized label for the new tab.

Existing archive-section copy can stay unchanged:

- `settings.archived_sessions_label`
- `settings.archived_sessions_description`
- `settings.archived_sessions_empty`
- related status/action strings

Only the top-level tab label needs to be added for locale parity.

## UX Details

### Tab Order

The new tab should appear immediately after `General` so the archive destination is easy to discover and still feels like a settings concern:

1. `General`
2. `Archived`
3. `Model`
4. `Advanced`
5. `Debug` when developer mode is enabled

### Empty State

If there are no archived sessions, the tab should still render a clear empty state instead of looking blank or broken.

### Device Availability

If an archived session is not available on the current device, the row should keep showing the existing availability badge. The new tab should not hide this distinction.

## Testing Requirements

Implementation must cover all three layers below.

### 1. Settings Tab Model

Add or update focused tests for:

- `SettingsTab` supporting `archived`
- `resolveVisibleSettingsTab(...)` accepting `archived`
- settings-tab label resolution for the new tab

### 2. Settings UI Contract

Add or update tests verifying:

- the archived-session block renders only in the `Archived` tab
- `General` no longer contains the archived-session block
- the archived tab still renders the existing empty state and unarchive action copy

### 3. Navigation Wiring

Add or update tests verifying:

- dashboard sidebar wiring opens `openSettings("archived")`
- session sidebar wiring opens `openSettings("archived")`
- the existing desktop e2e path for `Archived items` lands on the settings screen with archive content visible

Desktop verification must follow the repository rule in `AGENTS.md`: test the real Tauri desktop runtime, not `packages/web`.

## Final Decision

The approved design is:

- add a new first-class `Archived` settings tab
- move the existing archived-session management block from `General` into that tab
- route sidebar `Archived items` navigation to `Settings > Archived`
- keep the current archive storage, archive list loading, availability matching, and unarchive behavior unchanged
