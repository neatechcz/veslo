import assert from "node:assert/strict";
import test from "node:test";

import {
  beginOutageEpisode,
  clearOutageEpisode,
  createReconnectRecoveryTracker,
  createReconnectState,
  isRunningStatus,
  reconnectStateBlocksSend,
  shouldRecoverEventStreamRuntime,
  shouldShowReconnected,
  shouldShowReconnecting,
} from "../../context/session-reconnect.js";

test("initial live connection is not classified as reconnect recovery", () => {
  const tracker = createReconnectRecoveryTracker();
  assert.equal(tracker.observe(createReconnectState({ status: "live", workspaceId: "ws-a" })), false);
});

test("live connection resumes accepted watches only after an outage in the same workspace", () => {
  const tracker = createReconnectRecoveryTracker();
  assert.equal(tracker.observe(createReconnectState({ status: "reconnecting", workspaceId: "ws-a" })), false);
  assert.equal(tracker.observe(createReconnectState({ status: "live", workspaceId: "ws-b" })), false);
  assert.equal(tracker.observe(createReconnectState({ status: "live", workspaceId: "ws-a" })), true);
  assert.equal(tracker.observe(createReconnectState({ status: "live", workspaceId: "ws-a" })), false);
});

test("beginOutageEpisode captures running sessions including retry states", () => {
  const state = beginOutageEpisode({ a: "running", b: "retry", c: "idle" });
  assert.equal(state.active, true);
  assert.equal(state.hadRunningSessions, true);
  assert.deepEqual(state.runningSessionIds.sort(), ["a", "b"]);
  assert.equal(state.shownReconnecting, false);
  assert.equal(state.shownReconnected, false);
});

test("beginOutageEpisode ignores scoped status keys as fetchable session ids", () => {
  const state = beginOutageEpisode({
    a: "running",
    ["workspace-a\0a"]: "running",
  });
  assert.deepEqual(state.runningSessionIds, ["a"]);
});

test("beginOutageEpisode can snapshot running sessions for a specific workspace", () => {
  const state = beginOutageEpisode(
    {
      "shared-session": "running",
      ["workspace-a\0a"]: "running",
      ["workspace-b\0b"]: "retry",
      ["workspace-b\0idle"]: "idle",
    },
    "workspace-b",
  );
  assert.deepEqual(state.runningSessionIds, ["b"]);
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

test("reconnect state captures operational UI details without blocking sends", () => {
  const state = createReconnectState({
    status: "reconnecting",
    workspaceId: " ws-a ",
    sessionId: " sess-a ",
    attempt: 2,
    delayMs: 2000,
    lastError: "socket closed",
    now: () => 123,
  });

  assert.deepEqual(state, {
    status: "reconnecting",
    reason: null,
    workspaceId: "ws-a",
    sessionId: "sess-a",
    attempt: 2,
    delayMs: 2000,
    lastError: "socket closed",
    messagesMayBeDelayed: true,
    updatedAt: 123,
  });
  assert.equal(reconnectStateBlocksSend(state), false);
});

test("a live runtime carries no reason even if one is offered", () => {
  const state = createReconnectState({
    status: "live",
    reason: "catchup-incomplete",
    now: () => 1,
  });

  assert.equal(state.reason, null);
});

test("a degraded runtime keeps its classified reason and hides upstream error text from it", () => {
  const state = createReconnectState({
    status: "degraded",
    reason: "runtime-recovery-unavailable",
    lastError: '{"name":"UnknownError","data":{"ref":"err_112acf0f"}}',
    now: () => 1,
  });

  assert.equal(state.reason, "runtime-recovery-unavailable");
  // The envelope stays available for diagnostics but is not the reason.
  assert.notEqual(state.lastError, null);
});

test("event stream runtime recovery requires scoped runtime evidence", () => {
  assert.equal(
    shouldRecoverEventStreamRuntime({
      recoveryAvailable: true,
      textMatchedRuntimeError: true,
      scopedRuntimeReady: true,
    }),
    false,
  );
  assert.equal(
    shouldRecoverEventStreamRuntime({
      recoveryAvailable: true,
      textMatchedRuntimeError: true,
      scopedRuntimeReady: false,
    }),
    true,
  );
  assert.equal(
    shouldRecoverEventStreamRuntime({
      recoveryAvailable: false,
      textMatchedRuntimeError: true,
      scopedRuntimeReady: false,
    }),
    false,
  );
});
