import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureSidebarSessionInWorkspaceRows,
  materializePendingSidebarSessionRows,
  moveSidebarSessionBetweenWorkspaceRows,
  prependSidebarSessionToWorkspaceRows,
  removeSidebarSessionFromWorkspaceRows,
  replaceSidebarWorkspaceSessionRows,
} from "../../context/sidebar-workspace-sessions.js";
import type { SidebarSessionItem } from "../../types.js";

const item = (id: string, directory = `/repo/${id}`): SidebarSessionItem => ({
  id,
  title: id.toUpperCase(),
  directory,
});

test("remove only deletes the session from the targeted workspace", () => {
  const current = {
    "ws-a": [item("a1"), item("a2")],
    "ws-b": [item("b1")],
  };

  assert.deepEqual(removeSidebarSessionFromWorkspaceRows(current, "ws-a", "a1"), {
    "ws-a": [item("a2")],
    "ws-b": [item("b1")],
  });
});

test("replace workspace rows leaves other workspace rows intact and marks status ready", () => {
  assert.deepEqual(
    replaceSidebarWorkspaceSessionRows({
      sessionsByWorkspaceId: { "ws-a": [item("old")], "ws-b": [item("b1")] },
      statusByWorkspaceId: { "ws-a": "loading", "ws-b": "ready" },
      workspaceId: "ws-a",
      items: [item("new")],
    }),
    {
      sessionsByWorkspaceId: { "ws-a": [item("new")], "ws-b": [item("b1")] },
      statusByWorkspaceId: { "ws-a": "ready", "ws-b": "ready" },
    },
  );
});

test("prepend adds a session to the target workspace without duplicating existing rows", () => {
  const current = { "ws-a": [item("a1"), item("a2")] };
  assert.deepEqual(prependSidebarSessionToWorkspaceRows(current, "ws-a", item("a2")), current);
  assert.deepEqual(prependSidebarSessionToWorkspaceRows(current, "ws-a", item("a0")), {
    "ws-a": [item("a0"), item("a1"), item("a2")],
  });
});

test("materialize pending replaces the pending row in the target workspace", () => {
  const pending = {
    ...item("pending-session:abc", "/repo/ws-a"),
    pendingSessionInstanceId: "pending-session:abc",
  };
  const real = {
    ...item("real-session", "/repo/ws-a"),
    pendingSessionInstanceId: "pending-session:abc",
  };
  const current = {
    "ws-a": [pending, item("a1", "/repo/ws-a")],
    "ws-b": [item("b1", "/repo/ws-b")],
  };

  assert.deepEqual(
    materializePendingSidebarSessionRows({
      current,
      workspaceId: "ws-a",
      pendingSessionInstanceId: "pending-session:abc",
      item: real,
    }),
    {
      "ws-a": [real, item("a1", "/repo/ws-a")],
      "ws-b": [item("b1", "/repo/ws-b")],
    },
  );
});

test("move transfers a session between workspaces and preserves unrelated rows", () => {
  assert.deepEqual(
    moveSidebarSessionBetweenWorkspaceRows({
      current: {
        "ws-a": [item("a1"), item("move")],
        "ws-b": [item("b1")],
      },
      sourceWorkspaceId: "ws-a",
      targetWorkspaceId: "ws-b",
      item: item("move", "/repo/ws-b"),
    }),
    {
      "ws-a": [item("a1")],
      "ws-b": [item("move", "/repo/ws-b"), item("b1")],
    },
  );
});

test("ensure only prepends when the target workspace is missing the session", () => {
  const current = { "ws-a": [item("a1")] };
  assert.equal(ensureSidebarSessionInWorkspaceRows(current, "ws-a", item("a1")), current);
  assert.deepEqual(ensureSidebarSessionInWorkspaceRows(current, "ws-a", item("a2")), {
    "ws-a": [item("a2"), item("a1")],
  });
});
