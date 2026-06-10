import assert from "node:assert/strict";
import test from "node:test";

import { resolveRenderableProjectGroups } from "../../../components/session/workspace-session-list-render-model.js";

type Group = { key: string };

test("keeps previous project group order while rendering is suspended", () => {
  const previous: Group[] = [{ key: "alpha" }, { key: "beta" }, { key: "gamma" }];
  const next: Group[] = [{ key: "beta" }, { key: "gamma" }, { key: "alpha" }];

  const resolved = resolveRenderableProjectGroups<Group>({
    suspended: true,
    previousGroups: previous,
    nextGroups: next,
  });

  assert.deepEqual(
    resolved.map((group) => group.key),
    ["alpha", "beta", "gamma"],
  );
});

test("uses latest project group contents while rendering is suspended", () => {
  type GroupWithSessions = { key: string; sessions: string[] };
  const previous: GroupWithSessions[] = [
    { key: "alpha", sessions: ["archived-session"] },
    { key: "beta", sessions: ["beta-old"] },
  ];
  const next: GroupWithSessions[] = [
    { key: "beta", sessions: ["beta-current"] },
    { key: "alpha", sessions: [] },
  ];

  const resolved = resolveRenderableProjectGroups<GroupWithSessions>({
    suspended: true,
    previousGroups: previous,
    nextGroups: next,
  });

  assert.deepEqual(resolved, [
    { key: "alpha", sessions: [] },
    { key: "beta", sessions: ["beta-current"] },
  ]);
});

test("uses next project order when rendering is not suspended", () => {
  const previous: Group[] = [{ key: "alpha" }, { key: "beta" }, { key: "gamma" }];
  const next: Group[] = [{ key: "beta" }, { key: "gamma" }, { key: "alpha" }];

  const resolved = resolveRenderableProjectGroups<Group>({
    suspended: false,
    previousGroups: previous,
    nextGroups: next,
  });

  assert.deepEqual(
    resolved.map((group) => group.key),
    ["beta", "gamma", "alpha"],
  );
});

test("falls back to next groups when suspended but no previous groups are available", () => {
  const resolved = resolveRenderableProjectGroups<Group>({
    suspended: true,
    previousGroups: [],
    nextGroups: [{ key: "delta" }],
  });

  assert.deepEqual(
    resolved.map((group) => group.key),
    ["delta"],
  );
});
