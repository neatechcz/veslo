import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProjectGroups,
  buildRecentRows,
  isProjectCollapsed,
  toggleProjectCollapsed,
} from "./workspace-session-list-model.js";

test("toggleProjectCollapsed collapses an expanded project", () => {
  const next = toggleProjectCollapsed({}, "project:alpha");

  assert.equal(isProjectCollapsed(next, "project:alpha"), true);
});

test("toggleProjectCollapsed expands a collapsed project", () => {
  const next = toggleProjectCollapsed({ "project:alpha": true }, "project:alpha");

  assert.equal(isProjectCollapsed(next, "project:alpha"), false);
});

test("toggleProjectCollapsed keeps other project keys unchanged", () => {
  const next = toggleProjectCollapsed({ "project:alpha": true, "project:beta": false }, "project:beta");

  assert.equal(isProjectCollapsed(next, "project:alpha"), true);
  assert.equal(isProjectCollapsed(next, "project:beta"), true);
});

test("buildRecentRows sorts by latest activity before creation time", () => {
  const workspace = {
    id: "workspace-1",
    name: "workspace-1",
    path: "/tmp/workspace-1",
    preset: "starter",
    workspaceType: "local" as const,
  };

  const rows = buildRecentRows([
    {
      workspace,
      sessions: [
        {
          id: "older-but-active",
          title: "older-but-active",
          time: { created: 100, updated: 1000 },
        },
        {
          id: "newer-but-inactive",
          title: "newer-but-inactive",
          time: { created: 900, updated: 900 },
        },
      ],
      status: "ready",
    },
  ]);

  assert.deepEqual(
    rows.map((row) => row.session.id),
    ["older-but-active", "newer-but-inactive"],
  );
});

test("buildRecentRows keeps subagents directly below their parent session", () => {
  const workspace = {
    id: "workspace-1",
    name: "workspace-1",
    path: "/tmp/workspace-1",
    preset: "starter",
    workspaceType: "local" as const,
  };

  const rows = buildRecentRows([
    {
      workspace,
      sessions: [
        {
          id: "root-a",
          title: "root-a",
          time: { created: 100, updated: 1000 },
        },
        {
          id: "sub-a-1",
          title: "sub-a-1",
          parentID: "root-a",
          time: { created: 200, updated: 2000 },
        },
        {
          id: "root-b",
          title: "root-b",
          time: { created: 300, updated: 1500 },
        },
      ],
      status: "ready",
    },
  ]);

  assert.deepEqual(
    rows.map((row) => row.session.id),
    ["root-a", "sub-a-1", "root-b"],
  );
  assert.deepEqual(
    rows.map((row) => row.nestingLevel),
    [0, 1, 0],
  );
});

test("buildProjectGroups keeps subagents nested under their parent in by-project mode", () => {
  const workspace = {
    id: "workspace-1",
    name: "workspace-1",
    path: "/tmp/workspace-1",
    preset: "starter",
    workspaceType: "local" as const,
  };

  const groups = buildProjectGroups([
    {
      workspace,
      sessions: [
        {
          id: "root-a",
          title: "root-a",
          directory: "/tmp/workspace-1/project-a",
          time: { created: 100, updated: 1000 },
        },
        {
          id: "sub-a-1",
          title: "sub-a-1",
          parentID: "root-a",
          directory: "/tmp/workspace-1/project-a/other-folder",
          time: { created: 200, updated: 2000 },
        },
        {
          id: "root-b",
          title: "root-b",
          directory: "/tmp/workspace-1/project-a",
          time: { created: 300, updated: 1500 },
        },
      ],
      status: "ready",
    },
  ]);

  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].sessions.map((row) => row.session.id),
    ["root-a", "sub-a-1", "root-b"],
  );
  assert.deepEqual(
    groups[0].sessions.map((row) => row.nestingLevel),
    [0, 1, 0],
  );
});
