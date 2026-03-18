# Session Responsive Sidebar Toggle Design

**Date:** 2026-03-18
**Status:** Approved
**Branch:** TBD

## Goal

Add a standard, predictable sidebar toggle experience in Session view so users can always open/close left and right menus when window size changes hide docked sidebars.

## Scope

- Session page layout in `packages/app/src/app/pages/session.tsx`.
- New top-fixed toggle controls for left and right menus.
- Responsive behavior based on **message area width**, not static breakpoints.
- Overlay behavior for narrow layouts.

Out of scope:
- Dashboard page layout changes.
- New global icon system abstractions.
- Reworking sidebar content structure.

## UX Decisions (Validated)

1. Menu controls are fixed at the top of the window (not mid-height).
2. Controls use custom SVG icons:
- rounded rectangle container line-art
- left icon has an inner vertical line on the left
- right icon has an inner vertical line on the right
- stroke style matches existing app icon language (Lucide-like)
3. Responsive trigger is based on message area width.
4. Minimum message area width target is **760px**.
5. Add hysteresis to avoid flicker while resizing:
- enter narrow mode when message width `< 760px`
- return to wide mode when message width `>= 784px`
6. In narrow mode, docked sidebars are hidden and only overlay sidebars are shown.
7. In narrow mode, only one overlay can be open at a time.
8. If one overlay is open and the opposite menu button is clicked, do nothing.

## Interaction Model

### Wide mode (message width >= 784px)

- Left and right sidebars can be shown as docked columns.
- Top buttons toggle docked visibility of their respective sidebars.
- User preference for docked visibility persists in local storage.

### Narrow mode (message width < 760px)

- Both docked sidebars are automatically hidden.
- Top buttons can open overlay sidebars.
- Overlay sidebars appear above chat content.
- At most one overlay can be open.
- Opposite-button click while overlay is open is ignored.
- Same-button click toggles the active overlay.

### Transition behavior

- On enter narrow mode: force docked sidebars hidden; preserve preference state for later wide restoration.
- On return to wide mode: close overlays and restore docked sidebars from persisted preference.

## Layout + Sizing

- Existing docked widths remain:
- left sidebar `260px`
- right sidebar `280px`
- Overlay widths:
- left: `min(260px, calc(100vw - 32px))`
- right: `min(280px, calc(100vw - 32px))`
- Available message width calculation:
- `available = rootWidth - (leftDocked ? 260 : 0) - (rightDocked ? 280 : 0)`

## Component Changes

### Session shell

In `session.tsx`:

- Add state for:
- `layoutMode`: `"wide" | "narrow"`
- docked visibility: `leftDockedVisible`, `rightDockedVisible`
- overlay visibility: `overlayOpen`: `null | "left" | "right"`
- Add top-fixed toggle button container.
- Render docked sidebars conditionally from state instead of static breakpoint-only hiding.
- Render overlay sidebar wrappers for narrow mode.

### Icon assets

Add two dedicated inline SVG components (or tiny local components in file):

- `LeftSidebarToggleIcon`
- `RightSidebarToggleIcon`

Icon style requirements:

- `viewBox="0 0 24 24"`
- `fill="none"`
- round joins/caps
- stroke width and visual weight aligned with existing icons

### Measurement and responsiveness

- Use `ResizeObserver` on session shell container (or chat layout container).
- Recompute mode from measured width via `requestAnimationFrame`-guarded updates.
- Apply hysteresis thresholds (`760/784`) to prevent mode thrash.

## Data Flow

1. Resize observer updates measured layout width.
2. Width evaluator determines target mode (`wide` vs `narrow`) with hysteresis.
3. State transition logic applies mode side effects:
- wide -> narrow: close docked view and enforce narrow constraints
- narrow -> wide: close overlays and restore persisted docked visibility
4. Toggle button actions route by mode:
- wide: update docked visibility + persist preference
- narrow: update overlay state with one-open-only rule

## Persistence

Local storage key (new):

- `veslo.session.sidebar.docked.v1`

Stored value:

```json
{ "left": true, "right": true }
```

Rules:

- Read on mount with safe fallback.
- Write only when docked visibility is changed in wide mode.
- Narrow mode does not overwrite docked preference.

## Accessibility

- Buttons use `button` elements with clear `aria-label`.
- Add `title` tooltips for pointer users.
- Preserve focus ring styling consistent with app controls.
- Overlay close support:
- `Esc` key
- backdrop click
- explicit close via same toggle button

## Error Handling + Edge Cases

- Missing `window`/SSR-safe guards around local storage and observer setup.
- If `ResizeObserver` unavailable (unlikely): fallback to window resize listener.
- On rapid resize, apply RAF coalescing to avoid extra reflows.
- Ensure overlay z-index stays below modal layers and above chat content.

## Testing Strategy

### Unit tests

Add tests for a new or extracted sidebar-layout model:

- hysteresis transitions (`760/784` boundaries)
- narrow mode one-overlay rule
- opposite-button click no-op when overlay open
- persistence read/write behavior
- docked visibility restoration after returning wide

### Integration/UI tests

- Session layout renders top-fixed toggle buttons.
- Docked sidebars can be hidden/restored in wide mode.
- Narrow mode auto-hides both docked sidebars.
- Overlay open/close behavior follows agreed rules.
- Ensure chat remains usable with overlay open/closed.

### Manual verification

1. Start app and open Session view.
2. Resize window below threshold and confirm both docked sidebars hide.
3. Open left overlay, then click right toggle and confirm no switch occurs.
4. Close left overlay, then open right overlay.
5. Resize above threshold and verify overlays close and docked preferences restore.
6. Refresh app and verify docked visibility preferences persist.

## Approach Options Considered

1. **State machine + measured width (chosen)**
- Most explicit and testable behavior model.
- Best fit for one-overlay-only rule.
2. Breakpoint-first with width fallback
- Simpler but less accurate for message-width requirement.
3. CSS/container-query heavy
- Less JS but harder to enforce interaction constraints.

## Recommended Implementation Summary

Implement a small, explicit layout state machine in Session view using measured message-width constraints, top-fixed custom SVG toggle buttons, and narrow-mode overlay sidebars with one-open-only behavior.
