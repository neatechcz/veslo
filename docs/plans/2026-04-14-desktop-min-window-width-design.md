# Desktop Min Window Width Design

## Goal

Prevent the Veslo desktop window from being resized below a phone-standard width by enforcing a `390px` minimum width for the main Tauri window.

## Approved Direction

- Set the native desktop window minimum width to `390px`.
- Keep the existing responsive UI thresholds unchanged.
- Add a small named desktop contract so the chosen value is discoverable outside `tauri.conf.json`.
- Extend the desktop config test so the minimum width stays pinned.

## Storage Model

### Enforced Value

- `packages/desktop/src-tauri/tauri.conf.json`
  - `app.windows[0].minWidth = 390`
  - This is the only place where Tauri and the operating system can actually prevent resizing below the minimum width.

### Documented Contract

- `packages/desktop/scripts/window-size-contract.mjs`
  - Exports the named desktop contract value `APP_WINDOW_MIN_WIDTH = 390`.
  - Explains that the value is mirrored into `tauri.conf.json` because the Tauri config is static JSON.
  - Lists the related UI files that use separate layout thresholds.

### Verified Contract

- `packages/desktop/scripts/tauri-config.test.mjs`
  - Verifies that every configured desktop window keeps `dragDropEnabled = false`.
  - Verifies that every configured desktop window keeps `minWidth = APP_WINDOW_MIN_WIDTH`.

## Related But Separate UI Thresholds

- `packages/app/src/app/components/session/sidebar-layout-model.ts`
  - Keeps `SESSION_CHAT_MIN_WIDTH = 360` and `SESSION_CHAT_MIN_WIDTH_EXIT = 392`.
- `packages/app/src/app/components/layout/global-sidebar-layout-model.ts`
  - Keeps `GLOBAL_CENTER_MIN_INTERACTIVE_WIDTH = 360` and `GLOBAL_CENTER_MIN_INTERACTIVE_WIDTH_EXIT = 392`.

These values describe when the Solid UI switches between wide and narrow layouts. They are not the native window minimum and should stay separate from the desktop window contract.

## Testing Scope

- Add a failing desktop config test for the missing `minWidth`.
- Update the Tauri config and desktop contract file.
- Re-run the focused desktop config test after implementation.
