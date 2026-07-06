import assert from "node:assert/strict";
import test from "node:test";

import { resolveRunningVesloServerHostInfo } from "../../lib/veslo-server-host.js";

test("resolveRunningVesloServerHostInfo ignores stale host info when the local server is not running", () => {
  const staleInfo = {
    running: false,
    baseUrl: "http://127.0.0.1:8787",
    clientToken: "client-token",
    hostToken: "host-token",
  };

  assert.equal(resolveRunningVesloServerHostInfo(staleInfo), null);
});

test("resolveRunningVesloServerHostInfo preserves a live local host snapshot", () => {
  const liveInfo = {
    running: true,
    lifecycleStatus: "running",
    baseUrl: "http://127.0.0.1:8787",
    clientToken: "client-token",
    hostToken: "host-token",
  };

  assert.deepEqual(resolveRunningVesloServerHostInfo(liveInfo), liveInfo);
});

test("resolveRunningVesloServerHostInfo ignores pre-ready lifecycle snapshots", () => {
  const waitingInfo = {
    running: true,
    lifecycleStatus: "waiting_ready",
    baseUrl: "http://127.0.0.1:8787",
    clientToken: "client-token",
    hostToken: "host-token",
  };
  const blockedInfo = {
    ...waitingInfo,
    lifecycleStatus: "blocked",
  };

  assert.equal(resolveRunningVesloServerHostInfo(waitingInfo), null);
  assert.equal(resolveRunningVesloServerHostInfo(blockedInfo), null);
});
