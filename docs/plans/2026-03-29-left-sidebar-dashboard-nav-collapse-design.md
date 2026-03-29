# Left Sidebar Dashboard Nav Collapse Design

**Date:** 2026-03-29  
**Status:** Approved  
**Branch:** main

## Goal

Hide the four left-sidebar dashboard navigation items (`Automations`, `Soul`, `Skills`, `Extensions`) by default and add a small expand/collapse arrow control on the divider line directly above the settings/status block. Persist this state globally across the app.

## Scope

- Shared left sidebar dashboard nav component:
  - `packages/app/src/app/components/session/sidebar-dashboard-nav.tsx`
- New localStorage prefs helper for this nav's collapsed state.
- Left sidebar behavior in both desktop surfaces that reuse this component:
  - `packages/app/src/app/pages/dashboard.tsx`
  - `packages/app/src/app/pages/session.tsx`

Out of scope:

- Mobile bottom navigation behavior.
- Reordering existing nav items.
- Changing routing/tab semantics for nav item clicks.
- Per-workspace preference scoping.

## Validated Product Decisions

1. The target repo is `/Users/vaclavsoukup/AI agent projects/Veslo`.
2. Preference scope is global (single shared state), not per-workspace.
3. Default state is collapsed (the four items are hidden by default).
4. Collapsed state must persist across reloads.
5. If currently on one of those tabs and nav is collapsed, it must remain collapsed.
6. The control is a standalone tiny arrow button on the separator line above the gear icon.
7. The arrow control has no text label.
8. `Automations`, `Soul`, `Skills`, and `Extensions` remain unchanged in behavior when expanded.

## Options Considered

### Option A: Keep collapse logic inside `SidebarDashboardNav` (chosen)

Implement localStorage-backed collapsed state directly in the shared nav component and render both the nav items and arrow toggle there.

Pros:

- Single implementation path for Dashboard and Session.
- No duplicated state or layout branching in page-level files.
- Matches requested placement naturally (between session list and bottom status block).
- Lowest regression risk for existing sidebar composition tests.

Cons:

- Component takes on one additional responsibility (state persistence).

### Option B: Control collapsed state in page layouts (`dashboard.tsx` / `session.tsx`)

Pros:

- Parent pages explicitly own visibility state.

Cons:

- Duplicated wiring in two files.
- Higher chance of behavior drift between Dashboard and Session.
- More brittle for shared UX updates.

### Option C: Put toggle inside `SidebarStatusControls`

Pros:

- Keeps nav component visually minimal.

Cons:

- Incorrect boundary: mixes nav visibility with settings/identity/status controls.
- Harder to reason about placement and behavior ownership.

## Recommended Approach

Use Option A.

- Add a dedicated preferences helper for collapsed state with a versioned key.
- Keep rendering and persistence logic local to `SidebarDashboardNav`.
- Render the tiny arrow as a centered control on a thin divider line above `SidebarStatusControls`.
- Preserve existing nav button classes, icons, order, and tab selection behavior.

## Architecture

### Component structure

`SidebarDashboardNav` will render:

1. Existing nav block (only when expanded).
2. A compact divider row containing a tiny center arrow toggle button.

This keeps placement stable:

- top: workspace/session list
- middle: dashboard nav (conditionally visible) and collapse toggle
- bottom: `SidebarStatusControls` (gear + connection/account block)

### Preferences model

Create `sidebar-dashboard-nav-prefs.ts` with:

- key: `veslo.sidebar-dashboard-nav.collapsed.v1`
- `DEFAULT_SIDEBAR_DASHBOARD_NAV_COLLAPSED = true`
- `readSidebarDashboardNavCollapsed(storage?)`
- `writeSidebarDashboardNavCollapsed(value, storage?)`

Behavior:

- missing/invalid payload -> default `true`
- write normalized boolean as string (`"true"`/`"false"`)
- ignore storage failures

### Data flow

On component init:

1. Read collapsed state from helper.
2. Initialize local signal.

On arrow click:

1. Flip signal (`collapsed = !collapsed`).
2. Persist via write helper.
3. Re-render nav block accordingly.

## Interaction Details

- Collapsed by default: only divider + tiny arrow is visible.
- Expanded: shows the four existing buttons plus the divider/arrow control.
- Arrow direction updates with state (collapsed vs expanded) to communicate affordance.
- No automatic expansion tied to active tab.
- Keyboard and accessibility:
  - arrow is a real `<button type="button">`
  - includes `aria-label` and `title` for expand/collapse action.

## Risks

1. Very compact arrow affordance could be overlooked if contrast/hover states are too subtle.
2. Layout tests that assert strict source ordering may need minor updates if wrapper markup changes.
3. Mis-scoped storage key could accidentally collide with other sidebar prefs if naming is not explicit/versioned.

## Testing Strategy

### Unit tests

- New tests for prefs helper:
  - defaults to `true` when key is missing
  - reads stored `"true"` / `"false"`
  - falls back to `true` for invalid values
  - writes normalized values

### Source/layout tests

- Add a focused test for `SidebarDashboardNav` source contract:
  - contains collapse toggle control
  - nav items render conditionally from collapsed state
- Keep/adjust existing page layout tests so component order remains:
  - `WorkspaceSessionList`
  - `SidebarDashboardNav`
  - `SidebarStatusControls`

### Manual verification

1. Open desktop app (Dashboard and Session surfaces).
2. Confirm nav starts collapsed on first load.
3. Click arrow to expand; verify four items appear in expected order.
4. Click arrow to collapse; verify items disappear.
5. Reload app/view and confirm last state persists globally.
6. While on one of the four tabs, collapse nav and reload; confirm it stays collapsed.
7. Confirm settings gear and status controls remain directly below divider and keep behavior.

## Acceptance Criteria

- The four nav items are hidden by default.
- A tiny standalone arrow button is present on a divider line immediately above the gear/status block.
- Clicking arrow toggles expanded/collapsed visibility of those four nav items.
- Toggle state persists globally across app views and reloads.
- Existing nav item click behavior remains unchanged when expanded.
- Mobile bottom nav remains unchanged.
