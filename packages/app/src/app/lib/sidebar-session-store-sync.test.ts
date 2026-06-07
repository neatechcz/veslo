import assert from "node:assert/strict";
import test from "node:test";

import type { Session } from "@opencode-ai/sdk/v2/client";

import type { SidebarSessionItem } from "../types";
import { deriveSidebarRowsFromSessionStore } from "./sidebar-session-store-sync.js";

const session = (id: string, updated: number): Session => ({
  id,
  title: id,
  time: { created: updated - 1, updated },
  directory: "/workspace",
}) as Session;

const row = (id: string, updated: number): SidebarSessionItem => ({
  id,
  title: id,
  time: { created: updated - 1, updated },
  directory: "/workspace",
});

const mapSession = (value: Session): SidebarSessionItem => ({
  id: value.id,
  title: value.title,
  slug: value.slug,
  parentID: value.parentID,
  time: value.time,
  directory: value.directory,
});

test("retains existing sidebar rows when active workspace session store is partial", () => {
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

test("upserts incoming rows without duplicating retained sidebar rows", () => {
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
  assert.equal(rows[0]?.time?.updated, 500);
});
