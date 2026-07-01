import assert from "node:assert/strict";
import test from "node:test";

import { createRoot, createSignal } from "solid-js";

import { createSessionSidebarDecorations } from "../../context/session-sidebar-decorations.js";
import type { WorkspaceSessionGroup } from "../../types.js";

const workspaceGroup = (sessions: WorkspaceSessionGroup["sessions"]): WorkspaceSessionGroup => ({
  workspace: {
    id: "workspace-a",
    name: "Workspace A",
    path: "/workspace/a",
    preset: "opencode",
    workspaceType: "local",
  },
  sessions,
  status: "ready",
});

test("session sidebar decorations creates deterministic sibling decorations after ready", async () => {
  await createRoot(async (dispose) => {
    const writes: string[] = [];
    const [groups, setGroups] = createSignal<WorkspaceSessionGroup[]>([
      workspaceGroup([
        { id: "parent", title: "Main project", parentID: null },
        { id: "child-a", title: "Research public benchmarks", parentID: "parent" },
      ]),
    ]);
    const store = createSessionSidebarDecorations({
      locale: () => "en",
      sidebarWorkspaceGroups: groups,
      readState: () => ({
        schemaVersion: 1,
        type: "subagent-decorations",
        roles: [],
        sessions: [],
      }),
      writeState: (value) => {
        writes.push(JSON.stringify(value));
      },
    });

    assert.deepEqual(store.subagentDecorationsBySessionId(), {});

    store.markReady();
    await store.flushPendingDecorations();

    assert.equal(store.subagentDecorationsBySessionId()["child-a"]?.label, "Alex");
    assert.equal(store.subagentDecorationsBySessionId()["child-a"]?.color, "#0f766e");

    setGroups([
      workspaceGroup([
        { id: "parent", title: "Main project", parentID: null },
        { id: "child-a", title: "Research public benchmarks", parentID: "parent" },
        { id: "child-b", title: "Search vendor docs", parentID: "parent" },
      ]),
    ]);
    await store.flushPendingDecorations();

    assert.equal(store.subagentDecorationsBySessionId()["child-b"]?.label, "Alex #2");
    assert.equal(store.subagentDecorationsBySessionId()["child-b"]?.color, "#2563eb");
    assert.ok(writes.length >= 2, "new decorations should be persisted");

    dispose();
  });
});

test("session sidebar decorations loads persisted state and ignores already decorated sessions", async () => {
  await createRoot(async (dispose) => {
    let writeCount = 0;
    const store = createSessionSidebarDecorations({
      locale: () => "cs",
      sidebarWorkspaceGroups: () => [
        workspaceGroup([
          { id: "parent", title: "Hlavni prace", parentID: null },
          { id: "child-a", title: "Vyhledej zdroje", parentID: "parent" },
        ]),
      ],
      readState: () => ({
        schemaVersion: 1,
        type: "subagent-decorations",
        roles: [
          {
            roleKey: "web-research",
            roleLabel: "Webovy vyzkum",
            firstNameByLocale: { cs: "Adam", en: "Alex" },
          },
        ],
        sessions: [
          {
            sessionId: "child-a",
            workspaceId: "workspace-a",
            parentSessionId: "parent",
            roleKey: "web-research",
            roleLabel: "Webovy vyzkum",
            color: "#123456",
            occurrenceIndex: 2,
          },
        ],
      }),
      writeState: () => {
        writeCount += 1;
      },
    });

    store.hydrate();
    store.markReady();
    await store.flushPendingDecorations();

    assert.deepEqual(store.subagentDecorationsBySessionId(), {
      "child-a": { label: "Adam #2", color: "#123456" },
    });
    assert.equal(store.state().sessions.length, 1);
    assert.equal(writeCount, 1, "ready persisted state should be written once without duplicate session entries");

    dispose();
  });
});
