import assert from "node:assert/strict";
import test from "node:test";

import { createSidebarSessionActivityTokenModel } from "../../context/sidebar-session-activity-token";
import { scopedSessionStatusKey } from "../../lib/scoped-session-status";

test("keeps one token reachable through every scoped alias and promotes atomically", () => {
  let snapshot: Record<string, unknown> = {};
  const tokens = createSidebarSessionActivityTokenModel((next) => { snapshot = next; });
  const handle = tokens.begin({ workspaceId: "ws-a", sessionId: "pending-a" });
  assert.ok(handle);

  assert.equal((snapshot[scopedSessionStatusKey("ws-a", "pending-a")] as { kind: string }).kind, "local");
  assert.equal(tokens.migrate(handle, {
    workspaceId: "ws-a",
    sessionId: "ses-a",
    opencodeSessionId: "oc-a",
    conversationId: "conv-a",
  }), true);
  assert.equal(snapshot[scopedSessionStatusKey("ws-a", "pending-a")], undefined);
  assert.equal(tokens.promote(handle, "run-a"), true);

  for (const id of ["ses-a", "oc-a", "conv-a"]) {
    assert.deepEqual(snapshot[scopedSessionStatusKey("ws-a", id)], {
      kind: "durable",
      generation: handle.generation,
      runId: "run-a",
    });
  }
});

test("removes the complete alias set", () => {
  let snapshot: Record<string, unknown> = {};
  const tokens = createSidebarSessionActivityTokenModel((next) => { snapshot = next; });
  const handle = tokens.begin({ workspaceId: "ws-a", sessionId: "ses-a", conversationId: "conv-a" });
  assert.ok(handle);
  assert.equal(tokens.remove(handle), true);
  assert.deepEqual(snapshot, {});
});

test("replaces a prior token that shares an alias instead of retaining it", () => {
  let snapshot: Record<string, unknown> = {};
  const tokens = createSidebarSessionActivityTokenModel((next) => { snapshot = next; });
  const first = tokens.begin({ workspaceId: "ws-a", sessionId: "ses-a", conversationId: "conv-a" });
  const second = tokens.begin({ workspaceId: "ws-a", sessionId: "ses-a", conversationId: "conv-a" });
  assert.ok(first);
  assert.ok(second);
  assert.equal(tokens.promote(first, "run-old"), false, "replaced token must no longer be reachable");
  assert.equal(tokens.promote(second, "run-new"), true);
  assert.deepEqual(snapshot[scopedSessionStatusKey("ws-a", "ses-a")], {
    kind: "durable",
    generation: second.generation,
    runId: "run-new",
  });
});
