# Dashboard Left Nav Relocation Design

**Date:** 2026-03-28  
**Status:** Approved  
**Branch:** main

## Goal

Move `Automations`, `Soul`, `Skills`, and `Extensions` from the right desktop dashboard sidebar into the left sidebar above the `Settings` and login/status area, without changing the existing sidebar visibility logic.

## Scope

- Desktop dashboard layout in:
  - `packages/app/src/app/pages/dashboard.tsx`
- Placement adjacency around:
  - `packages/app/src/app/components/sidebar-status-controls.tsx`
- Existing dashboard tab switching and active-state behavior for:
  - `scheduled`
  - `soul`
  - `skills`
  - `mcp` / `plugins`

Out of scope:

- Mobile bottom navigation behavior.
- `Session` page sidebar layout.
- Sidebar docked visibility persistence or toggle logic.
- New routing, new dashboard tabs, or new settings behavior.
- Hiding or auto-collapsing an empty right sidebar.

## Validated Product Decisions

1. The target repo is `/Users/vaclavsoukup/AI agent projects/Veslo`.
2. The four items to move are `Automations`, `Soul`, `Skills`, and `Extensions`.
3. These items move into the left dashboard sidebar.
4. They should sit above the existing `Settings` / login-status area.
5. `Settings` stays where it is today as a utility action in the bottom status block.
6. The order remains `Automations`, `Soul`, `Skills`, `Extensions`.
7. The right sidebar visibility logic must not change.
8. After the move, the right sidebar can remain empty in non-developer mode.
9. In developer mode, the right sidebar may still show `Advanced`.
10. Mobile navigation remains unchanged.

## Options Considered

### Option 1: Insert a dedicated nav section into the left sidebar

Add a new navigation block between the workspace/session list and the bottom `Settings` / status controls.

Pros:

- Matches the requested placement exactly.
- Keeps workspace/session browsing separate from product-area navigation.
- Preserves `Settings` as a lower-priority utility control.
- Requires only a small layout change in `dashboard.tsx`.

Cons:

- The right sidebar can become visually empty in non-developer mode.
- The left sidebar becomes denser and needs careful spacing.

### Option 2: Merge the four items into `SidebarStatusControls`

Extend the bottom controls component so it contains both `Settings` and the four product navigation items.

Pros:

- Small surface area change.
- Keeps all lower sidebar actions in one component.

Cons:

- Mixes primary navigation with connection status and identity.
- Makes `SidebarStatusControls` responsible for page navigation, which is the wrong boundary.
- Harder to scan than a separate nav section.

### Option 3: Move the four items to the top of the left sidebar

Place them above the workspace/session list.

Pros:

- Maximum visibility.
- Stronger emphasis on dashboard sections.

Cons:

- Pushes the workspace/session model down, even though that is the primary control surface.
- Competes with the sidebar's main job of selecting workers and sessions.
- Does not match the requested placement near `Settings`.

## Recommended Approach

Use Option 1.

- Keep `dashboard.tsx` as the source of truth for dashboard tab navigation.
- Add a dedicated desktop-only navigation block to the left sidebar between `WorkspaceSessionList` and `SidebarStatusControls`.
- Reuse the existing `navItem(...)` rendering logic, icon set, active-state logic, and tab switching behavior.
- Remove the four product nav items from the right sidebar.
- Keep the right sidebar wrapper and visibility logic unchanged, so only `Advanced` remains there in developer mode.

## Architecture

### Left sidebar composition

The desktop left sidebar in `dashboard.tsx` should become:

1. update pill
2. workspace/session list
3. dashboard section nav block
4. bottom `Settings` / status controls

The new nav block should:

- use the same button styling as the current right-sidebar nav
- reuse the same labels and icons
- preserve the current order:
  - `Automations`
  - `Soul`
  - `Skills`
  - `Extensions`

### Right sidebar composition

The desktop right sidebar should keep its current `Show when={rightSidebarVisible()}` wrapper and sizing, but its content changes:

- non-developer mode: no product nav items remain
- developer mode: show only `Advanced`

This preserves the existing sidebar toggle and persistence model exactly as requested.

### Component boundaries

- `dashboard.tsx` owns dashboard tab navigation and layout placement.
- `SidebarStatusControls` remains focused on:
  - `Settings`
  - login / user identity display
  - service status indicator
- No new route or state model is introduced.
- No new shared abstraction is required unless implementation needs a small helper for testability.

## Interaction And State Behavior

- Clicking any of the four moved items still calls `props.setTab(...)`.
- Active-state behavior stays unchanged.
- `Extensions` must stay active when either:
  - `props.tab === "mcp"`
  - `props.tab === "plugins"`
- The `Settings` button still opens the settings view via the existing `openSettings("general")` flow.
- Left and right sidebar visibility still come from the existing docked-visibility localStorage model.

## Risks

1. The left sidebar is already dense, so the new nav block could visually crowd the bottom area if spacing is not tuned.
2. The right sidebar remains logically available even when empty, which is a deliberate UX compromise from the requirement to keep visibility logic unchanged.
3. If the `Extensions` active-state special case is accidentally changed during the move, the highlight behavior for `plugins` would regress.

## Testing Strategy

### Unit / source-contract verification

- Add or update a dashboard source-layout test that verifies:
  - the left sidebar contains the four nav items above `SidebarStatusControls`
  - the right sidebar no longer renders those four items
  - the right sidebar still renders `Advanced` in developer mode
- Preserve coverage that `Settings` remains in `SidebarStatusControls`.

### Manual verification

1. Open the dashboard in desktop mode.
2. Confirm the four moved items appear in the left sidebar above `Settings`.
3. Click `Automations`, `Soul`, `Skills`, and `Extensions` and confirm the main content switches correctly.
4. Confirm the `Settings` button still works independently from the moved nav items.
5. Toggle the right sidebar and confirm behavior is unchanged even if the panel is empty.
6. Enable developer mode and confirm `Advanced` remains in the right sidebar.
7. Confirm mobile bottom navigation still looks and behaves the same.

## Acceptance Criteria

- On desktop dashboard, `Automations`, `Soul`, `Skills`, and `Extensions` are rendered in the left sidebar above the bottom `Settings` / login-status area.
- `Settings` remains in the bottom status controls block.
- The four moved items no longer render in the right sidebar.
- `Advanced` still renders in the right sidebar in developer mode.
- Right sidebar visibility logic and persistence are unchanged.
- Mobile bottom navigation is unchanged.
- `Extensions` remains active for both `mcp` and `plugins` dashboard tabs.
