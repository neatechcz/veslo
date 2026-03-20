import assert from "node:assert/strict";
import test from "node:test";

import { resolveTitlebarMenuLayout } from "./titlebar-menu-layout.js";

test("macOS Tauri titlebar menu uses overlay-aligned spacing", () => {
  assert.deepEqual(resolveTitlebarMenuLayout({ tauri: true, windows: false, mac: true }), {
    rootClass: "pointer-events-none fixed inset-x-0 top-1 z-[60] flex items-center justify-between",
    leftOffsetClass: "pointer-events-auto ml-[72px]",
    rightOffsetClass: "pointer-events-auto mr-3",
  });
});

test("Windows Tauri titlebar menu keeps right-side safe spacing", () => {
  assert.deepEqual(resolveTitlebarMenuLayout({ tauri: true, windows: true, mac: false }), {
    rootClass: "pointer-events-none fixed inset-x-0 top-1 z-[60] flex items-center justify-between",
    leftOffsetClass: "pointer-events-auto ml-3",
    rightOffsetClass: "pointer-events-auto mr-[140px]",
  });
});

test("non-Tauri titlebar menu falls back to side-anchored placement", () => {
  assert.deepEqual(resolveTitlebarMenuLayout({ tauri: false, windows: false, mac: false }), {
    rootClass: "pointer-events-none fixed inset-y-0 left-0 right-0 z-[60] flex items-center justify-between",
    leftOffsetClass: "pointer-events-auto ml-2",
    rightOffsetClass: "pointer-events-auto mr-2",
  });
});
