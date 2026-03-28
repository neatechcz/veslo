import assert from "node:assert/strict";
import test from "node:test";

import {
  SIDEBAR_SESSION_PAGE_SIZE,
  deriveSidebarHasMore,
  initialSidebarSessionLimit,
  nextSidebarSessionLimit,
} from "./sidebar-session-pagination.js";

test("sidebar pagination defaults to 20-item pages", () => {
  assert.equal(SIDEBAR_SESSION_PAGE_SIZE, 20);
  assert.equal(initialSidebarSessionLimit(), 20);
});

test("nextSidebarSessionLimit increments by +20", () => {
  assert.equal(nextSidebarSessionLimit(20), 40);
  assert.equal(nextSidebarSessionLimit(40), 60);
});

test("nextSidebarSessionLimit normalizes invalid inputs", () => {
  assert.equal(nextSidebarSessionLimit(0), 40);
  assert.equal(nextSidebarSessionLimit(Number.NaN), 40);
  assert.equal(nextSidebarSessionLimit(60, Number.NaN), 80);
  assert.equal(nextSidebarSessionLimit(60, -5), 80);
});

test("deriveSidebarHasMore follows limit-boundary heuristic", () => {
  assert.equal(deriveSidebarHasMore(20, 20), true);
  assert.equal(deriveSidebarHasMore(40, 40), true);
  assert.equal(deriveSidebarHasMore(19, 20), false);
  assert.equal(deriveSidebarHasMore(39, 40), false);
});
