import assert from "node:assert/strict";
import test from "node:test";

import {
  beginOutageEpisode,
  clearOutageEpisode,
  isRunningStatus,
  shouldShowReconnected,
  shouldShowReconnecting,
} from "./session-reconnect.js";

test("beginOutageEpisode captures running sessions including retry states", () => {
  const state = beginOutageEpisode({ a: "running", b: "retry", c: "idle" });
  assert.equal(state.active, true);
  assert.equal(state.hadRunningSessions, true);
  assert.deepEqual(state.runningSessionIds.sort(), ["a", "b"]);
  assert.equal(state.shownReconnecting, false);
  assert.equal(state.shownReconnected, false);
});

test("beginOutageEpisode tracks idle-only outages without notices", () => {
  const state = beginOutageEpisode({ idleA: "idle", idleB: "idle" });
  assert.equal(state.active, true);
  assert.equal(state.hadRunningSessions, false);
  assert.deepEqual(state.runningSessionIds, []);
  assert.equal(shouldShowReconnecting(state), false);
  assert.equal(shouldShowReconnected(state), false);
});

test("running status helper treats retry as active work", () => {
  assert.equal(isRunningStatus("running"), true);
  assert.equal(isRunningStatus("retry"), true);
  assert.equal(isRunningStatus("idle"), false);
  assert.equal(isRunningStatus(""), false);
});

test("notice helpers allow exactly one reconnecting and one reconnected notice", () => {
  const initial = beginOutageEpisode({ s1: "running" });
  assert.equal(shouldShowReconnecting(initial), true);
  assert.equal(shouldShowReconnecting({ ...initial, shownReconnecting: true }), false);
  assert.equal(shouldShowReconnected(initial), true);
  assert.equal(shouldShowReconnected({ ...initial, shownReconnected: true }), false);
});

test("clearOutageEpisode resets the tracker", () => {
  const state = clearOutageEpisode();
  assert.equal(state.active, false);
  assert.equal(state.hadRunningSessions, false);
  assert.deepEqual(state.runningSessionIds, []);
  assert.equal(state.shownReconnecting, false);
  assert.equal(state.shownReconnected, false);
});
