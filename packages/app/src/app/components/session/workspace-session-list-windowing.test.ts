import assert from "node:assert/strict";
import test from "node:test";

import {
  PROJECT_VISIBLE_DEFAULT,
  RECENT_LOAD_MORE_THRESHOLD_PX,
  RECENT_OVERSCAN_ROWS,
  VIEW_LOAD_MORE_STEP,
  computeInitialRecentVisibleCount,
  nextProjectVisibleCount,
  shouldLoadMoreRecentRowsOnScroll,
} from "./workspace-session-list-windowing.js";

test("project window defaults and step size are stable", () => {
  assert.equal(PROJECT_VISIBLE_DEFAULT, 7);
  assert.equal(VIEW_LOAD_MORE_STEP, 20);
  assert.equal(RECENT_OVERSCAN_ROWS, 3);
});

test("project window increments by +20", () => {
  assert.equal(nextProjectVisibleCount(7), 27);
  assert.equal(nextProjectVisibleCount(27), 47);
});

test("project window normalizes invalid values", () => {
  assert.equal(nextProjectVisibleCount(0), 27);
  assert.equal(nextProjectVisibleCount(Number.NaN), 27);
});

test("recent initial visible rows follow fit + 3", () => {
  assert.equal(computeInitialRecentVisibleCount(320, 40), 11);
  assert.equal(computeInitialRecentVisibleCount(359, 40), 11);
});

test("recent initial visible rows still show overscan on missing geometry", () => {
  assert.equal(computeInitialRecentVisibleCount(0, 40), 3);
  assert.equal(computeInitialRecentVisibleCount(Number.NaN, 40), 3);
  assert.equal(computeInitialRecentVisibleCount(200, Number.NaN), 8);
});

test("recent scroll requests load-more when the viewport is near the end", () => {
  assert.equal(RECENT_LOAD_MORE_THRESHOLD_PX, 120);
  assert.equal(shouldLoadMoreRecentRowsOnScroll(700, 280, 1_090), true);
  assert.equal(shouldLoadMoreRecentRowsOnScroll(500, 280, 1_090), false);
});
