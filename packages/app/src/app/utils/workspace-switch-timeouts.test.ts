import assert from "node:assert/strict";
import test from "node:test";

import {
  activateVesloHostWorkspaceWithTimeout,
  runWorkspaceEngineRestartWithTimeouts,
  type WorkspaceSwitchTimeouts,
} from "./workspace-switch-timeouts.js";

const shortTimeouts: WorkspaceSwitchTimeouts = {
  engineStopMs: 20,
  engineStartMs: 20,
  vesloHostWorkspaceActivateMs: 20,
};

test("runWorkspaceEngineRestartWithTimeouts runs stop before start", async () => {
  const calls: string[] = [];

  const result = await runWorkspaceEngineRestartWithTimeouts(
    {
      stop: async () => {
        calls.push("stop");
        return "stopped";
      },
      start: async () => {
        calls.push("start");
        return "started";
      },
    },
    shortTimeouts,
  );

  assert.deepEqual(calls, ["stop", "start"]);
  assert.equal(result.stopResult, "stopped");
  assert.equal(result.startResult, "started");
});

test("runWorkspaceEngineRestartWithTimeouts times out stalled engine stop", async () => {
  let startCalled = false;

  await assert.rejects(
    runWorkspaceEngineRestartWithTimeouts(
      {
        stop: async () => await new Promise<string>(() => {}),
        start: async () => {
          startCalled = true;
          return "started";
        },
      },
      shortTimeouts,
    ),
    /Timed out waiting for engine_stop after 20ms/,
  );

  assert.equal(startCalled, false);
});

test("runWorkspaceEngineRestartWithTimeouts times out stalled engine start", async () => {
  await assert.rejects(
    runWorkspaceEngineRestartWithTimeouts(
      {
        stop: async () => "stopped",
        start: async () => await new Promise<string>(() => {}),
      },
      shortTimeouts,
    ),
    /Timed out waiting for engine_start after 20ms/,
  );
});

test("activateVesloHostWorkspaceWithTimeout times out stalled activation", async () => {
  await assert.rejects(
    activateVesloHostWorkspaceWithTimeout(
      async () => await new Promise<void>(() => {}),
      shortTimeouts,
    ),
    /Timed out waiting for veslo host workspace activation after 20ms/,
  );
});
