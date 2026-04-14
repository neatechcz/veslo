// Tauri reads window sizing from static JSON, so the native min width must stay
// mirrored in packages/desktop/src-tauri/tauri.conf.json.
export const APP_WINDOW_MIN_WIDTH = 390;

export const APP_WINDOW_MIN_WIDTH_LOCATIONS = Object.freeze({
  enforcedIn: "packages/desktop/src-tauri/tauri.conf.json",
  documentedIn: "docs/plans/2026-04-14-desktop-min-window-width-design.md",
  verifiedBy: "packages/desktop/scripts/tauri-config.test.mjs",
  relatedUiThresholds: Object.freeze([
    "packages/app/src/app/components/session/sidebar-layout-model.ts",
    "packages/app/src/app/components/layout/global-sidebar-layout-model.ts",
  ]),
});
