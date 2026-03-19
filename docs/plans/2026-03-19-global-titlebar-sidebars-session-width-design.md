# Global Native Titlebar Sidebar Toggles + Session Width Design

**Date:** 2026-03-19  
**Status:** Approved  
**Branch:** main

## Goal

Implement global left/right menu controls placed in the native titlebar area on macOS and Windows, reuse Session sidebar content globally, and reduce Session chat column width to `325px` for initial evaluation.

## Scope

- Global app shell layout and sidebar ownership.
- Native titlebar integration for menu toggle controls:
  - macOS native titlebar overlay area.
  - Windows native caption/titlebar area.
- Reuse existing Session sidebar content as global sidebars.
- Session chat column maximum width change to `325px`.
- Default behavior update: left menu visible on first app run.

Out of scope:

- Redesigning sidebar content structure.
- Non-desktop runtime parity beyond graceful fallback behavior.
- Final tuning of chat width values beyond initial `325px` pass.

## Validated Product Decisions

1. Titlebar integration must be in native titlebar area (not just under it).
2. Controls should work globally across app views.
3. Sidebars should be global and always available.
4. Initial global sidebar content should reuse current Session sidebar content.
5. Session text window change applies to entire chat column, not just bubbles.
6. Initial width target is exactly half of current `650px`: `325px`.
7. Left menu should be visible by default when app starts.

## Approaches Considered

### 1) Native titlebar integration on both platforms (chosen)

- macOS: use titlebar overlay style and traffic-light-aware positioning.
- Windows: use native caption/titlebar integration path so controls live in titlebar area.
- Keep app behavior consistent with one global layout model.

Pros:
- Best alignment with strict native-titlebar requirement.
- Platform-appropriate result.

Cons:
- More integration complexity, especially on Windows.

### 2) Fully custom frameless titlebar on both platforms

Pros:
- Full layout control.

Cons:
- Not truly native titlebar behavior; weaker fit for requirement.
- Higher risk for platform behavior regressions (snap/drag/accessibility polish).

### 3) True native only on macOS, near-titlebar on Windows

Pros:
- Lower implementation risk.

Cons:
- Does not satisfy strict Windows native-titlebar placement requirement.

## Architecture

- Introduce a global shell in `packages/app/src/app/app.tsx` that owns:
  - native titlebar toggle controls,
  - global sidebar visibility and mode state,
  - global sidebar rendering,
  - center-content routing for all views.
- Move sidebar host responsibilities out of Session-only layout so behavior is global.
- Preserve existing responsive semantics (wide/narrow, one-overlay-only in narrow mode) via shared layout model lifted to app scope.
- Apply Session-specific center column width cap (`325px`) through shared shell-compatible layout wrappers.

## Components and Data Flow

### Components

- `GlobalChrome`
  - titlebar-aware toggle controls.
  - platform-specific spacing and drag-region composition.
- `GlobalSidebarsHost`
  - global left (`260px`) and right (`280px`) sidebars.
  - Session sidebar content reused globally.
  - docked and overlay rendering modes.
- `GlobalLayoutModel` (pure TypeScript)
  - mode (`wide | narrow`),
  - docked visibility preferences,
  - currently open overlay side.

### Data Flow

1. Root width changes are observed.
2. Layout model resolves mode and visibility state with hysteresis.
3. Titlebar toggle clicks dispatch layout actions.
4. Sidebars and center-content layout update from the shared state.
5. Docked preferences persist to local storage.

## Defaults and Persistence

- First-run defaults:
  - left sidebar: visible.
  - right sidebar: keep current default behavior unless explicitly changed later.
- Persist preferences in a global versioned key.
- If previous Session-scoped preference exists, migrate to global key once.

## Error Handling and Fallbacks

- If native titlebar APIs are unavailable at runtime:
  - fallback to non-titlebar in-app controls rather than losing menu access.
- Web/non-Tauri environments keep no-op safety around native window APIs.
- Layout model remains deterministic when titlebar integration is disabled.

## Session Width Change

- Session center chat column max width changes from `650px` to `325px`.
- Keep associated wrappers (search strip alignment, run indicator rail, composer alignment) consistent with the same narrow content width.
- This value is intentionally temporary for iterative tuning in follow-up feedback.

## Testing Strategy

### Unit tests

- Global layout model:
  - mode transitions and hysteresis boundaries,
  - overlay one-open-only rule,
  - default initialization with left visible.
- Preference migration and initialization behavior.

### Integration/UI tests

- Titlebar controls render and toggle sidebars globally across views.
- Left sidebar is visible by default on clean startup.
- Session width cap is applied to the full chat column (`325px`).

### Manual verification

- macOS:
  - controls appear in titlebar overlay area near traffic lights.
- Windows:
  - controls appear in native caption/titlebar area with expected window behavior.
- Cross-view:
  - sidebar toggles work outside Session.
  - reused sidebar content remains functional.

## Recommended Implementation Summary

Implement a global shell-driven sidebar system with native-titlebar controls on macOS and Windows, initialize left sidebar as visible by default, reuse existing Session sidebar content globally, and reduce Session chat column max width to `325px` for iterative tuning.
