import assert from "node:assert/strict";
import test from "node:test";

import {
  SIDEBAR_SESSION_PAGE_SIZE,
  deriveSidebarHasMore,
  expandSidebarSessionSliceWithAncestors,
  initialSidebarSessionLimit,
  nextSidebarSessionLimit,
} from "./sidebar-session-pagination.js";
import { buildRecentRows } from "../components/session/workspace-session-list-model.js";

test("sidebar pagination defaults to 20-item pages", () => {
  assert.equal(SIDEBAR_SESSION_PAGE_SIZE, 20);
  assert.equal(initialSidebarSessionLimit(), 20);
});

test("nextSidebarSessionLimit increments by +20", () => {
  assert.equal(nextSidebarSessionLimit(20), 40);
  assert.equal(nextSidebarSessionLimit(40), 60);
});

test("nextSidebarSessionLimit normalizes invalid inputs", () => {
  assert.equal(nextSidebarSessionLimit(0), 40);
  assert.equal(nextSidebarSessionLimit(Number.NaN), 40);
  assert.equal(nextSidebarSessionLimit(60, Number.NaN), 80);
  assert.equal(nextSidebarSessionLimit(60, -5), 80);
});

test("deriveSidebarHasMore follows limit-boundary heuristic", () => {
  assert.equal(deriveSidebarHasMore(20, 20), true);
  assert.equal(deriveSidebarHasMore(40, 40), true);
  assert.equal(deriveSidebarHasMore(19, 20), false);
  assert.equal(deriveSidebarHasMore(39, 40), false);
});

test("expandSidebarSessionSliceWithAncestors keeps paginated subagents nested under their parent", () => {
  const workspace = {
    id: "workspace-1",
    name: "workspace-1",
    path: "/tmp/workspace-1",
    preset: "starter",
    workspaceType: "local" as const,
  };

  const visible = expandSidebarSessionSliceWithAncestors([
    {
      id: "child-subagent",
      title: "child-subagent",
      parentID: "root-parent",
      time: { created: 200, updated: 2_000 },
    },
    {
      id: "regular-session",
      title: "regular-session",
      time: { created: 150, updated: 1_500 },
    },
    {
      id: "root-parent",
      title: "root-parent",
      time: { created: 100, updated: 1_000 },
    },
  ], 2);

  const rows = buildRecentRows([
    {
      workspace,
      sessions: visible,
      status: "ready",
    },
  ]);

  assert.deepEqual(
    rows.map((row) => row.session.id),
    ["root-parent", "child-subagent", "regular-session"],
  );
  assert.deepEqual(
    rows.map((row) => row.nestingLevel),
    [0, 1, 0],
  );
});
