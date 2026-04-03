import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProjectGroups,
  buildRecentRows,
  buildRowHierarchyLookup,
  displayTimestamp,
  formatSessionRelativeAge,
  formatSessionTimestampTooltip,
  isProjectCollapsed,
  resolveSessionRowClickAction,
  splitSessionDisplayLabel,
  requiredVisibleCountForExpandedSession,
  rowVisibleByExpansion,
  shouldShowNewSessionLabelText,
  shouldUseExpandedNewSessionLabel,
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

test("rowVisibleByExpansion keeps child rows hidden until the branch is explicitly expanded", () => {
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
          time: { created: 100, updated: 1_000 },
        },
        {
          id: "sub-a-1",
          title: "sub-a-1",
          parentID: "root-a",
          time: { created: 200, updated: 2_000 },
        },
        {
          id: "sub-a-2",
          title: "sub-a-2",
          parentID: "sub-a-1",
          time: { created: 300, updated: 3_000 },
        },
      ],
      status: "ready",
    },
  ]);

  const hierarchy = buildRowHierarchyLookup(rows);

  assert.equal(rowVisibleByExpansion(rows[0], hierarchy, new Set()), true);
  assert.equal(rowVisibleByExpansion(rows[1], hierarchy, new Set()), false);
  assert.equal(rowVisibleByExpansion(rows[1], hierarchy, new Set(["root-a"])), true);
});

test("session row click behavior after restart keeps first click for selection and second click for subagent expansion", () => {
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
          id: "root-parent",
          title: "root-parent",
          time: { created: 100, updated: 1_000 },
        },
        {
          id: "child-subagent",
          title: "child-subagent",
          parentID: "root-parent",
          time: { created: 200, updated: 900 },
        },
      ],
      status: "ready",
    },
  ]);
  const hierarchy = buildRowHierarchyLookup(rows);
  const hasChildren = (sessionId: string) =>
    (hierarchy.childrenByParentId.get(sessionId)?.length ?? 0) > 0;

  const firstClick = resolveSessionRowClickAction({
    selectedSessionId: null,
    clickedSessionId: "root-parent",
    hasChildren: hasChildren("root-parent"),
  });
  assert.deepEqual(firstClick, {
    openSession: true,
    toggleExpandedParent: false,
  });

  const secondClick = resolveSessionRowClickAction({
    selectedSessionId: "root-parent",
    clickedSessionId: "root-parent",
    hasChildren: hasChildren("root-parent"),
  });
  assert.deepEqual(secondClick, {
    openSession: true,
    toggleExpandedParent: true,
  });
});

test("requiredVisibleCountForExpandedSession requests enough rows to reveal direct children", () => {
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
          time: { created: 100, updated: 4_000 },
        },
        {
          id: "root-b",
          title: "root-b",
          time: { created: 200, updated: 3_000 },
        },
        {
          id: "sub-b-1",
          title: "sub-b-1",
          parentID: "root-b",
          time: { created: 210, updated: 2_900 },
        },
        {
          id: "root-c",
          title: "root-c",
          time: { created: 300, updated: 2_000 },
        },
      ],
      status: "ready",
    },
  ]);

  assert.equal(requiredVisibleCountForExpandedSession(rows, new Set(["root-b"]), "root-b"), 3);
  assert.equal(requiredVisibleCountForExpandedSession(rows, new Set(["root-a"]), "root-a"), null);
});

test("requiredVisibleCountForExpandedSession includes nested expanded descendants", () => {
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
          time: { created: 100, updated: 5_000 },
        },
        {
          id: "root-b",
          title: "root-b",
          time: { created: 200, updated: 4_000 },
        },
        {
          id: "sub-b-1",
          title: "sub-b-1",
          parentID: "root-b",
          time: { created: 210, updated: 3_900 },
        },
        {
          id: "sub-b-2",
          title: "sub-b-2",
          parentID: "sub-b-1",
          time: { created: 220, updated: 3_800 },
        },
      ],
      status: "ready",
    },
  ]);

  assert.equal(
    requiredVisibleCountForExpandedSession(rows, new Set(["root-b", "sub-b-1"]), "root-b"),
    4,
  );
});

test("splitSessionDisplayLabel keeps colored subagent name and still shows session description", () => {
  const label = splitSessionDisplayLabel("Vytvor shrnutí release notes", "Adam #2");

  assert.deepEqual(label, {
    decoratedName: "Adam #2",
    description: "Vytvor shrnutí release notes",
    tooltip: "Adam #2 · Vytvor shrnutí release notes",
  });
});

test("splitSessionDisplayLabel avoids duplicating the same text twice", () => {
  const label = splitSessionDisplayLabel("Adam", "Adam");

  assert.deepEqual(label, {
    decoratedName: "Adam",
    description: null,
    tooltip: "Adam",
  });
});

test("buildProjectGroups keeps directory groups in workspace insertion order", () => {
  const workspaceA = {
    id: "workspace-a",
    name: "workspace-a",
    path: "/tmp/workspace-a",
    preset: "starter",
    workspaceType: "local" as const,
  };
  const workspaceB = {
    id: "workspace-b",
    name: "workspace-b",
    path: "/tmp/workspace-b",
    preset: "starter",
    workspaceType: "local" as const,
  };

  const groups = buildProjectGroups([
    {
      workspace: workspaceA,
      sessions: [
        {
          id: "a-1",
          title: "a-1",
          directory: "/tmp/workspace-a",
          time: { created: 100, updated: 120 },
        },
      ],
      status: "ready",
    },
    {
      workspace: workspaceB,
      sessions: [
        {
          id: "b-1",
          title: "b-1",
          directory: "/tmp/workspace-b",
          time: { created: 90, updated: 9_000 },
        },
      ],
      status: "ready",
    },
  ]);

  assert.deepEqual(
    groups.map((group) => group.workspace.id),
    ["workspace-a", "workspace-b"],
  );
});

test("formatSessionRelativeAge uses compact d/h/m/s labels", () => {
  const now = 10 * 24 * 60 * 60 * 1000;
  assert.equal(formatSessionRelativeAge(now - 3 * 24 * 60 * 60 * 1000, now), "3d ago");
  assert.equal(formatSessionRelativeAge(now - 2 * 60 * 60 * 1000, now), "2h ago");
  assert.equal(formatSessionRelativeAge(now - 7 * 60 * 1000, now), "7m ago");
  assert.equal(formatSessionRelativeAge(now - 12 * 1000, now), "12s ago");
});

test("formatSessionTimestampTooltip provides exact datetime text for hover tooltip", () => {
  const text = formatSessionTimestampTooltip(0, "en-US");
  assert.ok(text.length > 0);
  assert.match(text, /1970/);
});

test("displayTimestamp prefers created time over updated time", () => {
  const value = displayTimestamp({
    id: "session-1",
    title: "session-1",
    time: {
      created: 100,
      updated: 9_000,
    },
  });

  assert.equal(value, 100);
});

test("shouldUseExpandedNewSessionLabel expands the label at 300px", () => {
  assert.equal(shouldUseExpandedNewSessionLabel(299), false);
  assert.equal(shouldUseExpandedNewSessionLabel(300), true);
});

test("shouldShowNewSessionLabelText hides text at tight sidebar widths", () => {
  assert.equal(shouldShowNewSessionLabelText(219), false);
  assert.equal(shouldShowNewSessionLabelText(220), true);
});
