import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveWorkspaceSessionSnapshotAction,
} from "../../context/workspace-session-snapshots.js";

test("switching workspaces saves outgoing and loads incoming when selected session is unscoped", () => {
  assert.deepEqual(
    resolveWorkspaceSessionSnapshotAction({
      previousWorkspaceId: "ws-a",
      activeWorkspaceId: "ws-b",
      selectedScopeWorkspaceId: null,
    }),
    {
      saveWorkspaceId: "ws-a",
      loadWorkspaceId: "ws-b",
      nextPreviousWorkspaceId: "ws-b",
    },
  );
});

test("send-time activation does not overwrite outgoing snapshot with a browsed session from incoming workspace", () => {
  assert.deepEqual(
    resolveWorkspaceSessionSnapshotAction({
      previousWorkspaceId: "ws-a",
      activeWorkspaceId: "ws-b",
      selectedScopeWorkspaceId: "ws-b",
    }),
    {
      saveWorkspaceId: null,
      loadWorkspaceId: null,
      nextPreviousWorkspaceId: "ws-b",
    },
  );
});

test("switching away from the selected session workspace saves it and loads the next workspace", () => {
  assert.deepEqual(
    resolveWorkspaceSessionSnapshotAction({
      previousWorkspaceId: "ws-b",
      activeWorkspaceId: "ws-a",
      selectedScopeWorkspaceId: "ws-b",
    }),
    {
      saveWorkspaceId: "ws-b",
      loadWorkspaceId: "ws-a",
      nextPreviousWorkspaceId: "ws-a",
    },
  );
});

test("initial workspace load only loads the active workspace snapshot", () => {
  assert.deepEqual(
    resolveWorkspaceSessionSnapshotAction({
      previousWorkspaceId: null,
      activeWorkspaceId: "ws-a",
      selectedScopeWorkspaceId: null,
    }),
    {
      saveWorkspaceId: null,
      loadWorkspaceId: "ws-a",
      nextPreviousWorkspaceId: "ws-a",
    },
  );
});

test("selected session scope changes inside the same active workspace do not reload snapshot", () => {
  assert.deepEqual(
    resolveWorkspaceSessionSnapshotAction({
      previousWorkspaceId: "ws-a",
      activeWorkspaceId: "ws-a",
      selectedScopeWorkspaceId: null,
    }),
    {
      saveWorkspaceId: null,
      loadWorkspaceId: null,
      nextPreviousWorkspaceId: "ws-a",
    },
  );

  assert.deepEqual(
    resolveWorkspaceSessionSnapshotAction({
      previousWorkspaceId: "ws-a",
      activeWorkspaceId: "ws-a",
      selectedScopeWorkspaceId: "ws-b",
    }),
    {
      saveWorkspaceId: null,
      loadWorkspaceId: null,
      nextPreviousWorkspaceId: "ws-a",
    },
  );
});
