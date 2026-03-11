import assert from "node:assert/strict";
import test from "node:test";

import { openSessionWithWorkspaceActivation } from "./session-navigation.js";

test("opens immediately when session is in active workspace", async () => {
  const opened: string[] = [];
  const activated: string[] = [];

  const result = await openSessionWithWorkspaceActivation({
    activeWorkspaceId: "ws-active",
    workspaceId: "ws-active",
    sessionId: "sess-1",
    activateWorkspace: async (id) => {
      activated.push(id);
      return true;
    },
    openSession: (id) => opened.push(id),
  });

  assert.equal(result, true);
  assert.deepEqual(activated, []);
  assert.deepEqual(opened, ["sess-1"]);
});

test("does not open session when cross-workspace activation fails", async () => {
  const opened: string[] = [];
  const activated: string[] = [];

  const result = await openSessionWithWorkspaceActivation({
    activeWorkspaceId: "ws-active",
    workspaceId: "ws-other",
    sessionId: "sess-2",
    activateWorkspace: async (id) => {
      activated.push(id);
      return false;
    },
    openSession: (id) => opened.push(id),
  });

  assert.equal(result, false);
  assert.deepEqual(activated, ["ws-other"]);
  assert.deepEqual(opened, []);
});

test("opens session after successful cross-workspace activation", async () => {
  const opened: string[] = [];
  const activated: string[] = [];

  const result = await openSessionWithWorkspaceActivation({
    activeWorkspaceId: "ws-active",
    workspaceId: "ws-other",
    sessionId: "sess-3",
    activateWorkspace: async (id) => {
      activated.push(id);
      return true;
    },
    openSession: (id) => opened.push(id),
  });

  assert.equal(result, true);
  assert.deepEqual(activated, ["ws-other"]);
  assert.deepEqual(opened, ["sess-3"]);
});
