import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_WORKSPACE_SNAPSHOT_CACHE_LIMIT,
  selectWorkspaceSnapshotEvictions,
} from "../../lib/workspace-snapshot-cache.js";

test("selectWorkspaceSnapshotEvictions keeps the most recently used workspace snapshots", () => {
  const evictions = selectWorkspaceSnapshotEvictions(
    [
      { workspaceId: "ws-old", lastUsed: 10 },
      { workspaceId: "ws-new", lastUsed: 30 },
      { workspaceId: "ws-middle", lastUsed: 20 },
    ],
    2,
  );

  assert.deepEqual(evictions, ["ws-old"]);
});

test("selectWorkspaceSnapshotEvictions protects snapshots that are mid-switch", () => {
  const evictions = selectWorkspaceSnapshotEvictions(
    [
      { workspaceId: "ws-outgoing", lastUsed: 1 },
      { workspaceId: "ws-active", lastUsed: 2 },
      { workspaceId: "ws-newest", lastUsed: 100 },
    ],
    2,
    ["ws-outgoing", "ws-active"],
  );

  assert.deepEqual(evictions, ["ws-newest"]);
});

test("default workspace snapshot cache limit is intentionally small", () => {
  assert.equal(DEFAULT_WORKSPACE_SNAPSHOT_CACHE_LIMIT, 6);
});
