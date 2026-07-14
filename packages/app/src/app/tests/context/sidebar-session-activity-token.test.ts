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

test("reconciles durable tokens only when no final row retains an alias", () => {
  let snapshot: Record<string, unknown> = {};
  const pruned: Array<{ id: string; generation: number; runId: string; aliases: readonly string[] }> = [];
  const tokens = createSidebarSessionActivityTokenModel(
    (next) => { snapshot = next; },
    (token) => { pruned.push(token); },
  );
  const handle = tokens.begin({
    workspaceId: "ws-a",
    sessionId: "ses-a",
    opencodeSessionId: "oc-a",
    conversationId: "conv-a",
  });
  assert.ok(handle);
  assert.equal(tokens.promote(handle, "run-a"), true);

  assert.equal(tokens.reconcileFinalRows([{
    workspace: { id: "ws-a" },
    session: { id: "ses-rekeyed", opencodeSessionId: "oc-a" },
  }]), false, "an alias-preserving rekey must retain the durable token");
  assert.deepEqual(snapshot[scopedSessionStatusKey("ws-a", "ses-a")], {
    kind: "durable",
    generation: handle.generation,
    runId: "run-a",
  });

  assert.equal(tokens.reconcileFinalRows([]), true, "a removed final row must prune its durable token");
  assert.deepEqual(snapshot, {});
  assert.deepEqual(pruned, [{
    id: handle.id,
    generation: handle.generation,
    runId: "run-a",
    aliases: [
      scopedSessionStatusKey("ws-a", "ses-a"),
      scopedSessionStatusKey("ws-a", "oc-a"),
      scopedSessionStatusKey("ws-a", "conv-a"),
    ],
  }]);
  assert.equal(tokens.reconcileFinalRows([]), false, "an unchanged empty row set must not republish");
  assert.equal(pruned.length, 1, "an unchanged row set must not duplicate prune diagnostics");
});

test("keeps a local pending token through an intermediate empty final-row snapshot", () => {
  let snapshot: Record<string, unknown> = {};
  const tokens = createSidebarSessionActivityTokenModel((next) => { snapshot = next; });
  const handle = tokens.begin({ workspaceId: "ws-a", sessionId: "pending-a" });
  assert.ok(handle);

  assert.equal(tokens.reconcileFinalRows([]), false);
  assert.deepEqual(snapshot[scopedSessionStatusKey("ws-a", "pending-a")], {
    kind: "local",
    generation: handle.generation,
  });
});

test("migration atomically replaces a colliding alias token", () => {
  let snapshot: Record<string, unknown> = {};
  const tokens = createSidebarSessionActivityTokenModel((next) => { snapshot = next; });
  const older = tokens.begin({ workspaceId: "ws-a", sessionId: "ses-old", opencodeSessionId: "oc-shared" });
  const migrating = tokens.begin({ workspaceId: "ws-a", sessionId: "pending-new" });
  assert.ok(older);
  assert.ok(migrating);
  assert.equal(tokens.promote(older, "run-old"), true);

  assert.equal(tokens.migrate(migrating, {
    workspaceId: "ws-a",
    sessionId: "ses-new",
    opencodeSessionId: "oc-shared",
  }), true);
  assert.equal(snapshot[scopedSessionStatusKey("ws-a", "ses-old")], undefined);
  assert.equal(snapshot[scopedSessionStatusKey("ws-a", "pending-new")], undefined);
  assert.deepEqual(snapshot[scopedSessionStatusKey("ws-a", "oc-shared")], {
    kind: "local",
    generation: migrating.generation,
  });

  assert.equal(tokens.promote(migrating, "run-new"), true);
  assert.deepEqual(snapshot[scopedSessionStatusKey("ws-a", "ses-new")], {
    kind: "durable",
    generation: migrating.generation,
    runId: "run-new",
  });
});

test("an older migration cannot displace the newer generation at a colliding alias", () => {
  let snapshot: Record<string, unknown> = {};
  const tokens = createSidebarSessionActivityTokenModel((next) => { snapshot = next; });
  const older = tokens.begin({ workspaceId: "ws-a", sessionId: "pending-old" });
  const newer = tokens.begin({ workspaceId: "ws-a", sessionId: "pending-new" });
  assert.ok(older);
  assert.ok(newer);

  assert.equal(tokens.migrate(newer, {
    workspaceId: "ws-a",
    sessionId: "ses-new",
    opencodeSessionId: "oc-shared",
  }), true);
  assert.equal(tokens.migrate(older, {
    workspaceId: "ws-a",
    sessionId: "ses-old",
    opencodeSessionId: "oc-shared",
  }), false);
  assert.equal(snapshot[scopedSessionStatusKey("ws-a", "pending-old")], undefined);
  assert.deepEqual(snapshot[scopedSessionStatusKey("ws-a", "oc-shared")], {
    kind: "local",
    generation: newer.generation,
  });
});
