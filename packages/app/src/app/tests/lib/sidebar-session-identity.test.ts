import assert from "node:assert/strict";
import test from "node:test";

import { findSidebarSessionItemMergeIndex } from "../../lib/sidebar-session-identity.js";

const session = (id: string, directory = "") => ({
  id,
  directory,
  conversationId: "",
  opencodeSessionId: "",
});

test("selects the highest-scoring sidebar session match", () => {
  const match = findSidebarSessionItemMergeIndex(
    [session("session-a", "/workspace-a"), session("session-a", "/workspace-b")],
    session("session-a", "/workspace-b"),
  );

  assert.equal(match, 1);
});

test("does not merge ambiguous sidebar session matches", () => {
  const match = findSidebarSessionItemMergeIndex(
    [session("session-a"), session("session-a")],
    session("session-a"),
  );

  assert.equal(match, -1);
});
