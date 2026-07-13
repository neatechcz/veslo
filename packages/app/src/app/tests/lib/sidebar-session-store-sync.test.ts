import assert from "node:assert/strict";
import test from "node:test";

import type { Session } from "@opencode-ai/sdk/v2/client";

const session = (id: string, updated: number, directory = "/workspace") => ({
  id,
  title: id,
  slug: id,
  projectID: "project",
  version: "1",
  time: { created: updated - 1, updated },
  directory,
}) as Session;

const row = (id: string, updated: number, directory = "/workspace") => ({
  id,
  title: id,
  time: { created: updated - 1, updated },
  directory,
});

const mapSession = (value: ReturnType<typeof session>) => ({
  id: value.id,
  title: value.title,
  time: value.time,
  directory: value.directory,
});

test("retains existing sidebar rows when active workspace session store is partial", async () => {
  const { deriveSidebarRowsFromSessionStore } = await import("../../lib/sidebar-session-store-sync.js")
    .catch((error) => assert.fail(`sidebar session store sync helper should exist: ${error.message}`));

  const rows = deriveSidebarRowsFromSessionStore({
    incomingSessions: [session("new-session", 400)],
    existingRows: [
      row("old-a", 300),
      row("old-b", 200),
      row("old-c", 100),
    ],
    requestLimit: 20,
    mapSession,
    expandVisibleSessions: (sessions) => sessions,
  });

  assert.deepEqual(
    rows.map((item) => item.id),
    ["new-session", "old-a", "old-b", "old-c"],
  );
});

test("upserts incoming rows without duplicating retained sidebar rows", async () => {
  const { deriveSidebarRowsFromSessionStore } = await import("../../lib/sidebar-session-store-sync.js")
    .catch((error) => assert.fail(`sidebar session store sync helper should exist: ${error.message}`));

  const rows = deriveSidebarRowsFromSessionStore({
    incomingSessions: [session("old-b", 500), session("new-session", 400)],
    existingRows: [
      row("old-a", 300),
      row("old-b", 200),
      row("old-c", 100),
    ],
    requestLimit: 20,
    mapSession,
    expandVisibleSessions: (sessions) => sessions,
  });

  assert.deepEqual(
    rows.map((item) => item.id),
    ["old-b", "new-session", "old-a", "old-c"],
  );
  assert.equal(rows[0]?.time?.updated, 200, "runtime session updates must not rewrite sidebar activity time");
});

test("preserves stored conversation identity when session-store rows refresh", async () => {
  const { deriveSidebarRowsFromSessionStore } = await import("../../lib/sidebar-session-store-sync.js")
    .catch((error) => assert.fail(`sidebar session store sync helper should exist: ${error.message}`));

  const rows = deriveSidebarRowsFromSessionStore({
    incomingSessions: [session("same-session", 500, "/workspace/project-a")],
    existingRows: [
      {
        ...row("same-session", 200, "/workspace/project-a"),
        title: "Stored A",
        conversationId: "conv-a",
        opencodeSessionId: "same-session",
      },
      {
        ...row("same-session", 100, "/workspace/project-b"),
        title: "Stored B",
        conversationId: "conv-b",
        opencodeSessionId: "same-session",
      },
    ],
    requestLimit: 20,
    mapSession,
    expandVisibleSessions: (sessions) => sessions,
  });

  assert.deepEqual(
    rows.map((item) => `${item.title}:${item.directory}:${item.conversationId ?? ""}`),
    [
      "same-session:/workspace/project-a:conv-a",
      "Stored B:/workspace/project-b:conv-b",
    ],
  );
  assert.equal(rows[0]?.time?.updated, 200, "stored sidebar time survives a session-store refresh");
});
