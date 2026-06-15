import assert from "node:assert/strict";
import test from "node:test";

import { createRoot } from "solid-js";

import { createWorkspaceBusyState } from "../../context/workspace-busy-state";

test("workspace busy state tracks and clears by session id", () => {
  createRoot((dispose) => {
    const events: Array<{ event: string; payload?: Record<string, unknown> }> = [];
    const busy = createWorkspaceBusyState((event, payload) => {
      events.push({ event, payload });
    });

    busy.markWorkspaceBusy(" ws-a ", "session-1");
    assert.equal(busy.workspaceBusy()["ws-a"]?.sessionId, "session-1");

    busy.clearWorkspaceBusy("ws-a", "different-session");
    assert.equal(busy.workspaceBusy()["ws-a"]?.sessionId, "session-1");

    busy.clearWorkspaceBusy("ws-a", "session-1");
    assert.equal(busy.workspaceBusy()["ws-a"], undefined);
    assert.deepEqual(events.map((entry) => entry.event), ["mark", "clear"]);
    assert.equal(events[1]?.payload?.workspaceId, "ws-a");
    assert.equal(events[1]?.payload?.sessionId, "session-1");

    dispose();
  });
});

test("workspace busy state preserves startedAt for repeated busy marks of the same session", () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;

  try {
    createRoot((dispose) => {
      const events: Array<{ event: string; payload?: Record<string, unknown> }> = [];
      const busy = createWorkspaceBusyState((event, payload) => {
        events.push({ event, payload });
      });

      busy.markWorkspaceBusy("ws-a", "session-1");
      const startedAt = busy.workspaceBusy()["ws-a"]?.startedAt;
      assert.equal(startedAt, 1_000);

      now = 2_000;
      busy.markWorkspaceBusy("ws-a", "session-1");

      assert.equal(busy.workspaceBusy()["ws-a"]?.startedAt, startedAt);
      assert.deepEqual(events.map((entry) => entry.event), ["mark", "mark-existing"]);

      dispose();
    });
  } finally {
    Date.now = originalNow;
  }
});

test("clear all except preserves the selected workspace only", () => {
  createRoot((dispose) => {
    const events: Array<{ event: string; payload?: Record<string, unknown> }> = [];
    const busy = createWorkspaceBusyState((event, payload) => {
      events.push({ event, payload });
    });

    busy.markWorkspaceBusy("ws-a", "session-a");
    busy.markWorkspaceBusy("ws-b", "session-b");
    busy.clearWorkspaceBusyAllExcept("ws-b");

    assert.equal(busy.workspaceBusy()["ws-a"], undefined);
    assert.equal(busy.workspaceBusy()["ws-b"]?.sessionId, "session-b");
    assert.equal(events.at(-1)?.event, "clear-all-except");
    assert.equal(events.at(-1)?.payload?.keepWorkspaceId, "ws-b");
    assert.deepEqual(events.at(-1)?.payload?.droppedWorkspaceIds, ["ws-a"]);

    dispose();
  });
});
