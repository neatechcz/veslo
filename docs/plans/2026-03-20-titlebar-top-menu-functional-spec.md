# Titlebar Top Menu Functional Specification

**Date:** 2026-03-20  
**Status:** Draft for approval  
**Scope:** Native desktop app (`packages/desktop` + `packages/app`) top-menu sidebar toggles rendered in/near the native titlebar area.

## Purpose

Define the exact behavior and function-level contracts for the top menu (left/right sidebar toggles) so implementation is deterministic across macOS, Windows, and non-native fallback contexts.

## Goals

1. Keep left/right sidebar toggles globally accessible from the top menu area.
2. On macOS native app, place controls in the titlebar overlay zone near traffic lights.
3. On Windows native app, place controls in the titlebar-safe top area without blocking native caption buttons.
4. Preserve window dragging behavior in free titlebar regions.
5. Ensure page content does not visually overlap the titlebar area.
6. Keep a deterministic fallback for non-Tauri runtime.

## Non-goals

1. Replacing native window controls (close/minimize/maximize).
2. Implementing a fully custom frameless window chrome.
3. Reworking sidebar content semantics (docked vs overlay rules remain owned by existing layout models).

## Functional Surface (Source of Truth)

### `resolveTitlebarMenuLayout(inputs)`

- File: `packages/app/src/app/components/titlebar-menu-layout.ts`
- Inputs:
  - `tauri: boolean`
  - `windows: boolean`
  - `mac: boolean`
- Output:
  - `rootClass: string`
  - `leftOffsetClass: string`
  - `rightOffsetClass: string`
  - `dragRegionClass: string | null`

#### Behavior

1. `tauri=false`:
   - Uses viewport-side fallback placement (left/right edge anchored in-app controls).
   - No drag region (`dragRegionClass=null`).
2. `tauri=true && windows=true`:
   - Uses top overlay root.
   - Left control is top-left safe offset.
   - Right control is top-right with extra right inset to avoid caption-button collision.
   - Adds drag region class.
3. `tauri=true && mac=true`:
   - Uses top overlay root.
   - Left control offset starts after traffic-light area.
   - Right control top-right safe inset.
   - Adds drag region class.
4. `tauri=true` default fallback (unknown platform):
   - Uses same top overlay pattern as mac-safe defaults.

### `resolveTitlebarContentInsetClass(inputs)`

- File: `packages/app/src/app/components/titlebar-menu-layout.ts`
- Inputs:
  - `tauri: boolean`
  - `mac: boolean`
  - `hideTitlebar: boolean`
- Output: Tailwind class string

#### Behavior

1. Returns `"pt-7"` only when all are true:
   - `tauri=true`
   - `mac=true`
   - `hideTitlebar=false`
2. Returns empty string in all other cases.
3. Purpose: reserve vertical space for content when macOS titlebar overlay is active so app HTML is not visually pushed into titlebar zone.

### `TitlebarMenuToggles(props)`

- File: `packages/app/src/app/components/titlebar-menu-toggles.tsx`
- Props:
  - `leftActive: boolean`
  - `rightActive: boolean`
  - `onToggleLeft: () => void`
  - `onToggleRight: () => void`

#### Behavior

1. Reads runtime/platform flags via:
   - `isTauriRuntime()`
   - `isWindowsPlatform()`
   - `isMacPlatform()`
2. Resolves placement classes via `resolveTitlebarMenuLayout(...)`.
3. Renders icon-only controls (no boxed panel container) for left and right toggle actions.
4. Applies active/inactive visual states only through icon color classes.
5. When `dragRegionClass` exists, renders an explicit `data-tauri-drag-region` element so free titlebar space remains draggable.

### `setWindowTitleBarStyle(style)`

- File: `packages/app/src/app/lib/tauri.ts`
- Signature: `setWindowTitleBarStyle(style: "visible" | "transparent" | "overlay")`

#### Behavior

1. Runs only in Tauri context.
2. Calls current window API for titlebar style.
3. Throws actionable error if call fails.
4. Used by app-level macOS effect to request `"overlay"` when native titlebar is visible.

### `startWindowDragging()`

- File: `packages/app/src/app/lib/tauri.ts`
- Signature: `startWindowDragging(): Promise<void>`

#### Behavior

1. Runs only in Tauri context.
2. Calls current window `startDragging()` API.
3. Throws actionable error if drag start fails.
4. Used as explicit fallback on top-menu drag-strip mouse-down so drag behavior does not depend on one mechanism only.

### App-level overlay activation effect

- File: `packages/app/src/app/app.tsx`
- Current rule:
  - If `isTauriRuntime() && isMacPlatform() && !hideTitlebar()` then call `setWindowTitleBarStyle("overlay")`.
  - Errors are logged with context.

## Placement and Visual Rules

1. Controls must be visually aligned to titlebar control row height.
2. Controls must be icon-only in top menu mode.
3. Controls must stay at opposite sides (left toggle left zone, right toggle right zone).
4. In Tauri mode, the top-menu titlebar strip must actively receive pointer events so drag gestures are captured reliably.
5. The drag strip (`data-tauri-drag-region`) must exist as a dedicated full-width layer across the top-menu titlebar zone, underneath control hit targets.
6. Content area must be inset from titlebar overlay area where required (macOS overlay path).

## Interaction Rules

1. Left icon toggles left menu visibility via `onToggleLeft()`.
2. Right icon toggles right menu visibility via `onToggleRight()`.
3. Behavior of docked/overlay sidebars remains governed by existing sidebar layout models:
   - session: `packages/app/src/app/components/session/sidebar-layout-model.ts`
   - global: `packages/app/src/app/components/layout/global-sidebar-layout-model.ts`
4. Top menu controls must not alter sidebar model invariants; they only dispatch toggle intent.

## Runtime Matrix

1. macOS + Tauri + titlebar visible:
   - Native titlebar overlay enabled.
   - Top menu controls rendered with mac offsets.
   - Content inset applied.
2. Windows + Tauri:
   - Top menu controls rendered with Windows-safe offsets.
   - Drag region present.
   - No mac-specific content inset.
3. Non-Tauri runtime:
   - Fallback side-anchored in-app placement.
   - No drag region.

## Failure Handling

1. If titlebar style cannot be applied, app logs a contextual error and continues with control rendering.
2. Native drag must include capability permission `core:window:allow-start-dragging`; missing permission is a blocking configuration error.
3. If runtime/platform detection is ambiguous, use deterministic default branch in `resolveTitlebarMenuLayout`.
4. Fallback must keep menu toggles usable even when native integration is unavailable.

## Accessibility Requirements

1. Left control must include `aria-label="Toggle left menu"`.
2. Right control must include `aria-label="Toggle right menu"`.
3. Controls must remain keyboard focusable and invokable.

## Test Requirements

Minimum test coverage:

1. `titlebar-menu-layout.test.ts`
   - macOS tauri branch class contract
   - windows tauri branch class contract
   - non-tauri fallback branch class contract
   - content inset contract (`resolveTitlebarContentInsetClass`)
2. Typecheck must pass for any consumer updates (`dashboard.tsx`, toggle component, layout helper).

## Acceptance Criteria

1. In macOS native app, controls appear in the top titlebar row and do not overlap page content.
2. In Windows native app, controls are top-aligned and do not collide with caption buttons.
3. User can drag the window from free top menu area.
4. Left/right toggles keep existing sidebar behavior semantics.
5. Non-native fallback remains functional.
6. Regression guard: top-menu changes must never break window dragging again; any PR touching titlebar menu must verify drag behavior manually in native app.

## Related Files

- `packages/app/src/app/components/titlebar-menu-layout.ts`
- `packages/app/src/app/components/titlebar-menu-layout.test.ts`
- `packages/app/src/app/components/titlebar-menu-toggles.tsx`
- `packages/app/src/app/pages/dashboard.tsx`
- `packages/app/src/app/pages/session.tsx`
- `packages/app/src/app/app.tsx`
- `packages/app/src/app/lib/tauri.ts`
