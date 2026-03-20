import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveTitlebarContentInsetClass,
  resolveTitlebarMenuLayout,
} from "./titlebar-menu-layout.js";

test("macOS Tauri titlebar menu uses overlay-aligned spacing", () => {
  assert.deepEqual(resolveTitlebarMenuLayout({ tauri: true, windows: false, mac: true }), {
    rootClass: "pointer-events-none fixed inset-x-0 top-0 z-[60] flex items-start justify-between",
    leftOffsetClass: "pointer-events-auto relative z-10 mt-1 ml-[66px]",
    rightOffsetClass: "pointer-events-auto relative z-10 mt-1 mr-2",
    dragRegionClass: "pointer-events-auto fixed inset-x-0 top-0 z-[59] h-9",
  });
});

test("Windows Tauri titlebar menu keeps right-side safe spacing", () => {
  assert.deepEqual(resolveTitlebarMenuLayout({ tauri: true, windows: true, mac: false }), {
    rootClass: "pointer-events-none fixed inset-x-0 top-0 z-[60] flex items-start justify-between",
    leftOffsetClass: "pointer-events-auto relative z-10 mt-1 ml-2.5",
    rightOffsetClass: "pointer-events-auto relative z-10 mt-1 mr-[136px]",
    dragRegionClass: "pointer-events-auto fixed inset-x-0 top-0 z-[59] h-9",
  });
});

test("non-Tauri titlebar menu falls back to side-anchored placement", () => {
  assert.deepEqual(resolveTitlebarMenuLayout({ tauri: false, windows: false, mac: false }), {
    rootClass: "pointer-events-none fixed inset-y-0 left-0 right-0 z-[60] flex items-center justify-between",
    leftOffsetClass: "pointer-events-auto ml-2",
    rightOffsetClass: "pointer-events-auto mr-2",
    dragRegionClass: null,
  });
});

test("macOS Tauri titlebar reserves top inset when native titlebar is visible", () => {
  assert.equal(
    resolveTitlebarContentInsetClass({ tauri: true, mac: true, hideTitlebar: false }),
    "pt-7",
  );
});

test("titlebar inset is disabled when not in macOS Tauri overlay mode", () => {
  assert.equal(
    resolveTitlebarContentInsetClass({ tauri: false, mac: true, hideTitlebar: false }),
    "",
  );
  assert.equal(
    resolveTitlebarContentInsetClass({ tauri: true, mac: false, hideTitlebar: false }),
    "",
  );
  assert.equal(
    resolveTitlebarContentInsetClass({ tauri: true, mac: true, hideTitlebar: true }),
    "",
  );
});
