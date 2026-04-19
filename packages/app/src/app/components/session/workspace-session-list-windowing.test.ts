import assert from "node:assert/strict";
import test from "node:test";

import {
  computeVisibleRowLoadCount,
  planVisibleRowLoadMore,
  PROJECT_VISIBLE_DEFAULT,
  RECENT_LOAD_MORE_THRESHOLD_PX,
  RECENT_OVERSCAN_ROWS,
  VIEW_LOAD_MORE_STEP,
  computeInitialRecentVisibleCount,
  nextProjectVisibleCount,
  shouldShowLessVisibleRowsControl,
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

test("load-more count reflects the remaining loaded rows when the final page is shorter than the step", () => {
  assert.equal(computeVisibleRowLoadCount(30, 27, false), 3);
  assert.equal(computeVisibleRowLoadCount(47, 27, false), 20);
  assert.equal(computeVisibleRowLoadCount(27, 27, false), 0);
});

test("load-more count keeps the paging step when more server rows may still exist", () => {
  assert.equal(computeVisibleRowLoadCount(27, 27, true), 20);
  assert.equal(computeVisibleRowLoadCount(30, 27, true), 3);
});

test("show-less control appears only after the visible window grows beyond its baseline", () => {
  assert.equal(shouldShowLessVisibleRowsControl(27, PROJECT_VISIBLE_DEFAULT), true);
  assert.equal(shouldShowLessVisibleRowsControl(PROJECT_VISIBLE_DEFAULT, PROJECT_VISIBLE_DEFAULT), false);
  assert.equal(shouldShowLessVisibleRowsControl(11, 11), false);
  assert.equal(shouldShowLessVisibleRowsControl(12, 11), true);
});

test("load-more planning reveals already-loaded rows before fetching another server page", () => {
  assert.deepEqual(
    planVisibleRowLoadMore(30, 27, true),
    {
      nextVisibleCount: 30,
      shouldFetchServerRows: false,
    },
  );
});

test("load-more planning fetches another server page only after the loaded rows are exhausted", () => {
  assert.deepEqual(
    planVisibleRowLoadMore(30, 30, true),
    {
      nextVisibleCount: 50,
      shouldFetchServerRows: true,
    },
  );
});
