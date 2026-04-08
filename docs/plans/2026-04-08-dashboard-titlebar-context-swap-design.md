# Dashboard Titlebar Context Swap Design

## Goal

Swap top-bar context ownership so the left side consistently shows `Veslo by Neatech`, while the centered titlebar slot shows the current page context:

- Session: current workspace/directory context.
- Dashboard: current dashboard area (including concrete Settings subsection).

## Approved Product Behavior

1. Left titlebar area should always show `Veslo by Neatech` in app screens using the shared titlebar.
2. Session view should move directory/workspace context from left slot to centered slot.
3. Dashboard should use centered slot to show where the user is:
   - Automations / Soul / Skills / Extensions / Advanced (per current tab mapping).
   - For `Settings`, show the concrete subsection, not generic `Settings`.
4. Settings subsection center labels should follow the active `settingsTab`:
   - `general` -> `General`
   - `model` -> `Model`
   - `advanced` -> `Advanced`
   - `debug` -> `Debug`
5. Unknown/invalid settings tab should safely fall back to `General`.

## Scope

In scope:

- `packages/app/src/app/pages/session.tsx`
- `packages/app/src/app/pages/dashboard.tsx`
- Titlebar layout source-contract tests in `packages/app/src/app/pages/*.test.ts`

Out of scope:

- Redesign of `TitlebarMenuToggles` API/structure.
- Sidebar toggle behavior changes.
- Settings page internal tab UI changes.
- Localization strategy overhaul for settings subsection labels.

## Options Considered

### Option 1: Page-owned center context with existing shared titlebar (chosen)

- Keep `TitlebarMenuToggles` unchanged.
- Session and Dashboard pass their own `centerContent`.
- Keep left brand as component fallback.

Pros:

- Smallest safe change.
- Minimal regression risk.
- Preserves current shared component boundaries.

Cons:

- Some titlebar-label logic remains page-specific.

### Option 2: Central shared resolver helper

- Add one helper to resolve all center-title text for both pages.

Pros:

- Centralized mapping.

Cons:

- More refactor overhead than needed for this change.

### Option 3: Move view-mode logic into `TitlebarMenuToggles`

- Add `mode` props and route-specific rendering in shared titlebar component.

Pros:

- Single component controls all title behavior.

Cons:

- Unnecessary coupling between shared chrome and page semantics.
- Higher risk for unrelated titlebar regressions.

## Recommended Approach

Use Option 1.

- Session:
  - stop sending `leftContent` and `showBrand={false}`
  - send current session context as `centerContent`
- Dashboard:
  - keep default left brand
  - send computed dashboard context as `centerContent`
  - when tab is `settings`, resolve centered label from `settingsTab`

## Architecture

### Shared titlebar responsibilities (unchanged)

- Render left/right toggle controls.
- Render brand fallback on the left when no `leftContent` is supplied.
- Render optional centered content via `centerContent`.
- Keep platform-specific offsets and drag-region behavior.

### Page responsibilities (updated)

- `SessionView`: computes workspace/directory label and passes it to `centerContent`.
- `DashboardView`: computes current area label and passes it to `centerContent`.
- `DashboardView`: refines settings title to active subsection label via `settingsTab`.

## Component And Data Flow

1. `session.tsx`
   - existing `sessionTitlebarContext()` remains the source of context text.
   - `TitlebarMenuToggles` uses `centerContent={sessionTitlebarContext()}`.
   - left side falls back to brand.

2. `dashboard.tsx`
   - existing `title()` mapping remains base for non-settings tabs.
   - new `dashboardTitlebarContext()` resolves:
     - non-settings -> `title()`
     - settings -> subsection label from `settingsTab`
   - `TitlebarMenuToggles` uses `centerContent={dashboardTitlebarContext()}`.

## Error Handling And Edge Cases

1. Invalid/unexpected `settingsTab` uses fallback `General`.
2. If session titlebar context is unavailable, centered slot remains empty and left brand remains visible.
3. Reactive updates are synchronous memo-based; no async fetch is needed for center labels.

## Testing Strategy

1. Update `packages/app/src/app/pages/session-titlebar-layout.test.ts`:
   - assert Session passes context into `centerContent`.
   - assert Session no longer overrides left slot / no longer disables brand fallback.

2. Update `packages/app/src/app/pages/dashboard-menu-navigation.test.ts` (or equivalent dashboard titlebar source-contract test):
   - assert Dashboard passes `centerContent` into `TitlebarMenuToggles`.
   - assert settings subsection mapping is present and uses `settingsTab` with fallback.

3. Run targeted tests for modified files after implementation.

## Acceptance Criteria

- Left titlebar consistently shows `Veslo by Neatech` in Session and Dashboard.
- Session context appears centered, not on the left.
- Dashboard center shows current area.
- Dashboard Settings center shows active subsection (`General`, `Model`, `Advanced`, `Debug`).
- Unknown settings tab does not break UI and falls back to `General`.
- Updated titlebar source-contract tests cover this behavior.
