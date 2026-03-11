import assert from "node:assert/strict";

import {
  buildProjectGroups,
  buildRecentRows,
  PRIVATE_PROJECT_GROUP_KEY,
} from "../src/app/components/session/workspace-session-list-model.ts";

const makeWorkspace = ({
  id,
  path,
  workspaceType = "local",
  directory = null,
}) => ({
  id,
  name: id,
  path,
  preset: "starter",
  workspaceType,
  directory,
});

const makeSession = ({
  id,
  created,
  updated = created,
  directory = null,
}) => ({
  id,
  title: id,
  directory,
  time: {
    created,
    updated,
  },
});

const privateRoot = "/Users/test/.veslo/workspaces/private";
const isPrivateWorkspacePath = (folder) =>
  typeof folder === "string" && (folder === privateRoot || folder.startsWith(`${privateRoot}/`));

const workspaceSessionGroups = [
  {
    workspace: makeWorkspace({
      id: "private-a",
      path: `${privateRoot}/a`,
    }),
    sessions: [
      makeSession({
        id: "private-newest",
        created: 500,
        updated: 505,
        directory: `${privateRoot}/a`,
      }),
    ],
    status: "ready",
  },
  {
    workspace: makeWorkspace({
      id: "project-alpha",
      path: "/Users/test/projects/alpha",
    }),
    sessions: [
      makeSession({
        id: "alpha-session",
        created: 350,
        updated: 450,
        directory: "/Users/test/projects/alpha",
      }),
    ],
    status: "ready",
  },
  {
    workspace: makeWorkspace({
      id: "private-b",
      path: `${privateRoot}/b`,
    }),
    sessions: [
      makeSession({
        id: "private-middle",
        created: 420,
        updated: 421,
        directory: `${privateRoot}/b`,
      }),
      makeSession({
        id: "private-oldest",
        created: 120,
        updated: 600,
        directory: `${privateRoot}/b`,
      }),
    ],
    status: "ready",
  },
  {
    workspace: makeWorkspace({
      id: "remote-beta",
      path: "/tmp/remote-beta",
      workspaceType: "remote",
      directory: "/srv/beta",
    }),
    sessions: [
      makeSession({
        id: "remote-session",
        created: 410,
        updated: 411,
        directory: "/srv/beta",
      }),
    ],
    status: "ready",
  },
];

const projectGroups = buildProjectGroups(workspaceSessionGroups, isPrivateWorkspacePath);
assert.equal(projectGroups.length, 3, "sidebar should bundle private workspaces into one grouped project");

const privateGroup = projectGroups.find((group) => group.key === PRIVATE_PROJECT_GROUP_KEY);
assert.ok(privateGroup, "sidebar should expose a synthetic grouped project for private workspaces");
assert.equal(privateGroup.projectLabel, "", "private grouped project should render without a visible name");
assert.equal(privateGroup.projectTitle, "", "private grouped project should not expose a folder tooltip");
assert.deepEqual(
  privateGroup.sessions.map((row) => row.session.id),
  ["private-newest", "private-middle", "private-oldest"],
  "private grouped sessions should follow the same newest-first order as the Recent view",
);
assert.equal(
  privateGroup.workspace.id,
  "private-a",
  "private grouped actions should target the workspace with the most recent session",
);

assert.deepEqual(
  projectGroups.map((group) => group.key),
  [PRIVATE_PROJECT_GROUP_KEY, "/Users/test/projects/alpha", "/srv/beta"],
  "project groups should still sort by latest activity across bundled and named projects",
);

const recentRows = buildRecentRows(workspaceSessionGroups, isPrivateWorkspacePath);
assert.equal(
  recentRows.find((row) => row.session.id === "private-newest")?.projectLabel,
  "",
  "Recent rows should hide the project label for private workspaces",
);
assert.equal(
  recentRows.find((row) => row.session.id === "alpha-session")?.projectLabel,
  "alpha",
  "Recent rows should keep the basename label for normal local projects",
);
assert.equal(
  recentRows.find((row) => row.session.id === "remote-session")?.projectLabel,
  "beta",
  "Recent rows should keep the basename label for remote projects",
);

console.log(JSON.stringify({ ok: true, checks: 8 }));
