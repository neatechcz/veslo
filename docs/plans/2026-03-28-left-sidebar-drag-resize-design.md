# Left Sidebar Drag Resize Design

**Date:** 2026-03-28  
**Status:** Approved  
**Branch:** main

## Goal

Enable drag resizing of the left menu in both `Session` and `Dashboard`, with shared persisted width and no visual redesign.

## Scope

- Left sidebar width behavior in:
  - `packages/app/src/app/pages/session.tsx`
  - `packages/app/src/app/pages/dashboard.tsx`
- Shared width persistence + clamping helpers.
- Session layout width calculation updates so responsive mode stays correct with dynamic left width.

Out of scope:

- Right sidebar resizing.
- Any visual restyling of sidebar chrome.
- Changes to sidebar content structure.

## Validated Product Decisions

1. Resize must work in both `Session` and `Dashboard`.
2. Shared width value across both views.
3. Limits are fixed to:
   - min `220px`
   - default `260px`
   - max `420px`
4. Width must persist across restart via `localStorage`.
5. No visual redesign; only functional drag interaction.

## Recommended Approach (Approved)

Use a shared left-sidebar width preference model consumed by both pages.

- Add a reusable helper module for width key/constants/read/write/clamp.
- Replace hardcoded left widths with reactive width state in both pages.
- Add an invisible drag hit area at the right edge of left sidebar in both pages.
- Keep visual UI unchanged (no persistent grip decoration).
- Persist final width on drag end.

## Architecture

### Shared helper module

Create a single source of truth for left sidebar width preferences:

- `LEFT_SIDEBAR_WIDTH_MIN = 220`
- `LEFT_SIDEBAR_WIDTH_DEFAULT = 260`
- `LEFT_SIDEBAR_WIDTH_MAX = 420`
- `LEFT_SIDEBAR_WIDTH_KEY = "veslo.global.sidebar.left-width.v1"`
- `clampLeftSidebarWidth(value)`
- `readLeftSidebarWidth()`
- `writeLeftSidebarWidth(value)`

Requirements:

- SSR-safe guards.
- Invalid storage payloads fall back to default.
- Writes always clamp.

### Session

- Replace fixed `260px` docked/overlay left sidebar widths with dynamic state value.
- Keep overlay viewport cap behavior (`min(width, viewport - 32px)`).
- Update available chat width calculation to use current left width so wide/narrow transitions remain correct.

### Dashboard

- Replace fixed `w-64` left width with dynamic state value.
- Keep existing visibility/toggle behavior.
- Reuse same persisted width as Session.

## Interaction Model

- Drag starts on invisible right-edge hit area of left sidebar.
- During drag:
  - compute delta from initial pointer X
  - apply clamp (`220..420`)
  - update width reactively for immediate feedback
- Drag ends on `pointerup` / `pointercancel`:
  - remove listeners
  - persist final clamped width
- Cursor:
  - `col-resize` while hovering drag zone and during active drag

## Error Handling

- Missing `window` / non-browser context: default width returned.
- Corrupted `localStorage` payload: ignored, default restored in memory.
- Pointer cancellation: gracefully finalize with last valid width.
- Cleanup listeners on component disposal to avoid stuck resize state.

## Testing Strategy

### Unit tests

1. New helper tests:
- clamp boundaries
- read fallback behavior
- write+read roundtrip with clamping

2. Session width model tests:
- dynamic left width affects `availableChatWidthForLayout`
- existing wide/narrow hysteresis expectations remain intact

### Integration/Component tests

- Session renders left sidebar width from stored value.
- Dashboard renders left sidebar width from stored value.
- Drag interaction updates width inside bounds and persists value.

### Manual verification

1. Open Session and drag left menu wider/narrower.
2. Confirm width stops at `220` and `420`.
3. Switch to Dashboard and confirm same width is applied.
4. Restart app and confirm width persists.
5. Verify no visual redesign: no permanent extra grip element visible.

## Acceptance Criteria

- Left sidebar can be resized by drag in both Session and Dashboard.
- Width is clamped to `220..420`.
- Default is `260` on clean storage.
- Value persists and is shared across both views.
- Session responsive logic remains stable with dynamic left width.
- No visible style redesign introduced.
