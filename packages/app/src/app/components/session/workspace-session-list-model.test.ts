import assert from "node:assert/strict";
import test from "node:test";

import {
  PRIVATE_PROJECT_GROUP_KEY,
  buildProjectGroups,
  buildRecentRows,
  buildRowHierarchyLookup,
  directChildRowsForParent,
  descendantRowsForParent,
  displayTimestamp,
  filterVisibleProjectGroups,
  formatSessionRelativeAge,
  formatSessionTimestampTooltip,
  isProjectCollapsed,
  resolveSessionRowClickAction,
  rootRowsForSessionTree,
  sessionChatLabel,
  splitSessionDisplayLabel,
  splitProjectGroupsForSidebar,
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

test("buildRecentRows keeps private chat sessions mixed with project sessions by activity", () => {
  const privateRoot = "/Users/test/.veslo/private-workspaces";
  const isPrivateWorkspacePath = (folder: string | null | undefined) =>
    typeof folder === "string" && folder.startsWith(privateRoot);

  const rows = buildRecentRows(
    [
      {
        workspace: {
          id: "chat-a",
          name: "Private workspace",
          path: `${privateRoot}/chat-a`,
          preset: "starter",
          workspaceType: "local" as const,
        },
        sessions: [
          {
            id: "chat-middle",
            title: "Chat Middle",
            directory: `${privateRoot}/chat-a`,
            time: { created: 10, updated: 30 },
          },
        ],
        status: "ready",
      },
      {
        workspace: {
          id: "project-a",
          name: "Project A",
          path: "/Users/test/project-a",
          preset: "starter",
          workspaceType: "local" as const,
        },
        sessions: [
          {
            id: "project-newest",
            title: "Project Newest",
            directory: "/Users/test/project-a",
            time: { created: 20, updated: 50 },
          },
          {
            id: "project-oldest",
            title: "Project Oldest",
            directory: "/Users/test/project-a",
            time: { created: 5, updated: 20 },
          },
        ],
        status: "ready",
      },
    ],
    isPrivateWorkspacePath,
  );

  assert.deepEqual(
    rows.map((row) => row.session.id),
    ["project-newest", "chat-middle", "project-oldest"],
  );
});

test("buildRecentRows keeps subagents of private chats under the parent chat context", () => {
  const privateRoot = "/Users/test/.veslo/private-workspaces";
  const isPrivateWorkspacePath = (folder: string | null | undefined) =>
    typeof folder === "string" && folder.startsWith(privateRoot);

  const rows = buildRecentRows(
    [
      {
        workspace: {
          id: "chat-a",
          name: "Private workspace",
          path: `${privateRoot}/chat-a`,
          preset: "starter",
          workspaceType: "local" as const,
        },
        sessions: [
          {
            id: "private-parent",
            title: "Private parent",
            directory: `${privateRoot}/chat-a`,
            time: { created: 100, updated: 100 },
          },
        ],
        status: "ready",
      },
      {
        workspace: {
          id: "project-a",
          name: "Project A",
          path: "/Users/test/project-a",
          preset: "starter",
          workspaceType: "local" as const,
        },
        sessions: [
          {
            id: "private-child",
            title: "Private child",
            parentID: "private-parent",
            directory: "/Users/test/project-a",
            time: { created: 200, updated: 2_000 },
          },
          {
            id: "project-peer",
            title: "Project peer",
            directory: "/Users/test/project-a",
            time: { created: 300, updated: 1_500 },
          },
        ],
        status: "ready",
      },
    ],
    isPrivateWorkspacePath,
  );

  assert.deepEqual(
    rows.map((row) => row.session.id),
    ["private-parent", "private-child", "project-peer"],
  );

  const child = rows.find((row) => row.session.id === "private-child");
  assert.equal(child?.workspace.id, "chat-a");
  assert.equal(child?.isPrivateProject, true);
  assert.equal(child?.projectLabel, "");
  assert.equal(child?.projectRoot, `${privateRoot}/chat-a`);
  assert.equal(child?.nestingLevel, 1);
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

test("buildProjectGroups surfaces the most recently active project first within a workspace", () => {
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
          id: "old-project-session",
          title: "old-project-session",
          directory: "/tmp/workspace-1/a-project-old",
          time: { created: 100, updated: 100 },
        },
        {
          id: "new-project-session",
          title: "new-project-session",
          directory: "/tmp/workspace-1/z-project-new",
          time: { created: 200, updated: 2_000 },
        },
      ],
      status: "ready",
    },
  ]);

  assert.deepEqual(
    groups.map((group) => group.projectLabel),
    ["z-project-new", "a-project-old"],
  );
});

test("buildProjectGroups orders private and named project groups by latest activity", () => {
  const privateRoot = "/Users/test/.veslo/workspaces/private";
  const isPrivateWorkspacePath = (folder: string | null | undefined) =>
    typeof folder === "string" && (folder === privateRoot || folder.startsWith(`${privateRoot}/`));

  const groups = buildProjectGroups(
    [
      {
        workspace: {
          id: "private-a",
          name: "private-a",
          path: `${privateRoot}/a`,
          preset: "starter",
          workspaceType: "local" as const,
        },
        sessions: [
          {
            id: "private-newest",
            title: "private-newest",
            directory: `${privateRoot}/a`,
            time: { created: 500, updated: 505 },
          },
        ],
        status: "ready",
      },
      {
        workspace: {
          id: "project-alpha",
          name: "project-alpha",
          path: "/Users/test/projects/alpha",
          preset: "starter",
          workspaceType: "local" as const,
        },
        sessions: [
          {
            id: "alpha-session",
            title: "alpha-session",
            directory: "/Users/test/projects/alpha",
            time: { created: 350, updated: 450 },
          },
        ],
        status: "ready",
      },
      {
        workspace: {
          id: "private-b",
          name: "private-b",
          path: `${privateRoot}/b`,
          preset: "starter",
          workspaceType: "local" as const,
        },
        sessions: [
          {
            id: "private-middle",
            title: "private-middle",
            directory: `${privateRoot}/b`,
            time: { created: 420, updated: 421 },
          },
          {
            id: "private-oldest",
            title: "private-oldest",
            directory: `${privateRoot}/b`,
            time: { created: 120, updated: 600 },
          },
        ],
        status: "ready",
      },
      {
        workspace: {
          id: "remote-beta",
          name: "remote-beta",
          path: "/tmp/remote-beta",
          preset: "starter",
          workspaceType: "remote" as const,
          directory: "/srv/beta",
        },
        sessions: [
          {
            id: "remote-session",
            title: "remote-session",
            directory: "/srv/beta",
            time: { created: 410, updated: 411 },
          },
        ],
        status: "ready",
      },
    ],
    isPrivateWorkspacePath,
  );

  assert.deepEqual(
    groups.map((group) => group.key),
    ["project:veslo-private", "/Users/test/projects/alpha", "/srv/beta"],
  );
});

test("splitProjectGroupsForSidebar separates private chat group from project groups", () => {
  const privateRoot = "/Users/test/.veslo/private-workspaces";
  const isPrivateWorkspacePath = (folder: string | null | undefined) =>
    typeof folder === "string" && folder.startsWith(privateRoot);

  const groups = buildProjectGroups(
    [
      {
        workspace: {
          id: "chat-a",
          name: "Private workspace",
          path: `${privateRoot}/chat-a`,
          preset: "starter",
          workspaceType: "local" as const,
        },
        sessions: [
          {
            id: "chat-session",
            title: "Plan weekend",
            directory: `${privateRoot}/chat-a`,
            time: { created: 100, updated: 200 },
          },
        ],
        status: "ready",
      },
      {
        workspace: {
          id: "project-a",
          name: "Project A",
          path: "/Users/test/projects/project-a",
          preset: "starter",
          workspaceType: "local" as const,
        },
        sessions: [
          {
            id: "project-session",
            title: "Implement feature",
            directory: "/Users/test/projects/project-a",
            time: { created: 90, updated: 190 },
          },
        ],
        status: "ready",
      },
    ],
    isPrivateWorkspacePath,
  );

  const split = splitProjectGroupsForSidebar(groups);

  assert.equal(split.chatGroup?.key, PRIVATE_PROJECT_GROUP_KEY);
  assert.deepEqual(split.projectGroups.map((group) => group.key), ["/Users/test/projects/project-a"]);
});

test("sessionChatLabel prefers title, then Chat fallback without generated slug", () => {
  assert.equal(sessionChatLabel({ id: "one", title: "  Research trip  " }, "Chat"), "Research trip");
  assert.equal(sessionChatLabel({ id: "two", title: "", slug: "draft-chat" }, "Chat"), "Chat");
  assert.equal(sessionChatLabel({ id: "three", title: "", slug: "" }, "Chat"), "Chat");
});

test("rowVisibleByExpansion keeps a three-level branch closed until each parent is explicitly expanded", () => {
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
  const visibleIds = (expandedParents: ReadonlySet<string>) =>
    rows.filter((row) => rowVisibleByExpansion(row, hierarchy, expandedParents)).map((row) => row.session.id);

  assert.deepEqual(visibleIds(new Set()), ["root-a"]);
  assert.deepEqual(visibleIds(new Set(["root-a"])), ["root-a", "sub-a-1"]);
  assert.deepEqual(visibleIds(new Set(["root-a", "sub-a-1"])), ["root-a", "sub-a-1", "sub-a-2"]);
});

test("session tree helpers expose roots, direct children, and descendants in row order", () => {
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
        { id: "root-a", title: "root-a", time: { created: 100, updated: 100 } },
        { id: "child-a", title: "child-a", parentID: "root-a", time: { created: 110, updated: 110 } },
        { id: "grandchild-a", title: "grandchild-a", parentID: "child-a", time: { created: 120, updated: 120 } },
        { id: "child-b", title: "child-b", parentID: "root-a", time: { created: 105, updated: 105 } },
        { id: "root-b", title: "root-b", time: { created: 90, updated: 90 } },
      ],
      status: "ready",
    },
  ]);

  assert.deepEqual(rootRowsForSessionTree(rows).map((row) => row.session.id), ["root-a", "root-b"]);
  assert.deepEqual(directChildRowsForParent(rows, "root-a").map((row) => row.session.id), ["child-a", "child-b"]);
  assert.deepEqual(descendantRowsForParent(rows, "root-a").map((row) => row.session.id), [
    "child-a",
    "grandchild-a",
    "child-b",
  ]);
});

test("session tree helpers treat rows whose parent is missing from the slice as roots", () => {
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
        { id: "root-a", title: "root-a", time: { created: 100, updated: 100 } },
        { id: "child-a", title: "child-a", parentID: "root-a", time: { created: 110, updated: 110 } },
      ],
      status: "ready",
    },
  ]);

  const sliced = rows.slice(1);

  assert.deepEqual(rootRowsForSessionTree(sliced).map((row) => row.session.id), ["child-a"]);
});

test("session tree helpers do not treat grandchildren with missing parents as descendants", () => {
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
        { id: "root-a", title: "root-a", time: { created: 100, updated: 100 } },
        { id: "child-a", title: "child-a", parentID: "root-a", time: { created: 110, updated: 110 } },
        { id: "grandchild-a", title: "grandchild-a", parentID: "child-a", time: { created: 120, updated: 120 } },
      ],
      status: "ready",
    },
  ]);

  const sliced = rows.filter((row) => row.session.id !== "child-a");

  assert.deepEqual(rootRowsForSessionTree(sliced).map((row) => row.session.id), ["root-a", "grandchild-a"]);
  assert.deepEqual(descendantRowsForParent(sliced, "root-a").map((row) => row.session.id), []);
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
    allowSelectedParentExpansion: true,
  });
  assert.deepEqual(firstClick, {
    openSession: true,
    toggleExpandedParent: false,
  });

  const secondClick = resolveSessionRowClickAction({
    selectedSessionId: "root-parent",
    clickedSessionId: "root-parent",
    hasChildren: hasChildren("root-parent"),
    allowSelectedParentExpansion: true,
  });
  assert.deepEqual(secondClick, {
    openSession: true,
    toggleExpandedParent: true,
  });
});

test("selected parent session navigation clicks can open without expanding subagents", () => {
  const action = resolveSessionRowClickAction({
    selectedSessionId: "root-parent",
    clickedSessionId: "root-parent",
    hasChildren: true,
    allowSelectedParentExpansion: false,
  });

  assert.deepEqual(action, {
    openSession: true,
    toggleExpandedParent: false,
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

test("buildProjectGroups orders directory groups by latest activity", () => {
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
    ["workspace-b", "workspace-a"],
  );
});

test("buildProjectGroups includes a local workspace without sessions", () => {
  const groups = buildProjectGroups([
    {
      workspace: {
        id: "company-searcher",
        name: "Company searcher",
        path: "/Users/test/ai discussion projects/Company searcher",
        preset: "starter",
        workspaceType: "local" as const,
      },
      sessions: [],
      status: "ready",
    },
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, "/Users/test/ai discussion projects/Company searcher");
  assert.equal(groups[0].projectLabel, "Company searcher");
  assert.equal(groups[0].projectTitle, "/Users/test/ai discussion projects/Company searcher");
  assert.equal(groups[0].sessions.length, 0);
});

test("filterVisibleProjectGroups keeps empty workspace-only projects visible", () => {
  const groups = buildProjectGroups([
    {
      workspace: {
        id: "company-searcher",
        name: "Company searcher",
        path: "/Users/test/ai discussion projects/Company searcher",
        preset: "starter",
        workspaceType: "local" as const,
      },
      sessions: [],
      status: "ready",
    },
  ]);

  const visibleGroups = filterVisibleProjectGroups(groups, () => true);

  assert.equal(visibleGroups.length, 1);
  assert.equal(visibleGroups[0].projectLabel, "Company searcher");
});

test("filterVisibleProjectGroups keeps a local workspace visible when its last session is filtered out", () => {
  const groups = buildProjectGroups([
    {
      workspace: {
        id: "weather-veslo",
        name: "Weather - Veslo",
        path: "/Users/test/projects/Weather - Veslo",
        preset: "starter",
        workspaceType: "local" as const,
      },
      sessions: [
        {
          id: "archived-session",
          title: "Archived session",
          directory: "/Users/test/projects/Weather - Veslo",
          time: { created: 100, updated: 200 },
        },
      ],
      status: "ready",
    },
  ]);

  const visibleGroups = filterVisibleProjectGroups(groups, () => false);

  assert.equal(visibleGroups.length, 1);
  assert.equal(visibleGroups[0].projectLabel, "Weather - Veslo");
  assert.equal(visibleGroups[0].sessions.length, 0);
  assert.equal(visibleGroups[0].isWorkspaceOnlyProject, true);
});

test("buildProjectGroups keeps empty private workspaces hidden", () => {
  const privateRoot = "/Users/test/.veslo/workspaces/private";
  const isPrivateWorkspacePath = (folder: string | null | undefined) =>
    typeof folder === "string" && (folder === privateRoot || folder.startsWith(`${privateRoot}/`));

  const groups = buildProjectGroups(
    [
      {
        workspace: {
          id: "scratch",
          name: "Scratch",
          path: `${privateRoot}/scratch`,
          preset: "starter",
          workspaceType: "local" as const,
        },
        sessions: [],
        status: "ready",
      },
    ],
    isPrivateWorkspacePath,
  );

  assert.deepEqual(groups, []);
});

test("formatSessionRelativeAge uses compact d/h/m/s labels", () => {
  const now = 10 * 24 * 60 * 60 * 1000;
  assert.equal(formatSessionRelativeAge(now - 3 * 24 * 60 * 60 * 1000, now), "3d");
  assert.equal(formatSessionRelativeAge(now - 2 * 60 * 60 * 1000, now), "2h");
  assert.equal(formatSessionRelativeAge(now - 7 * 60 * 1000, now), "7m");
  assert.equal(formatSessionRelativeAge(now - 12 * 1000, now), "12s");
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
