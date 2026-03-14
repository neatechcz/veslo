import assert from "node:assert/strict";
import test from "node:test";

import { createWorkspaceActivateGuard } from "./workspace-activate-guard.js";

// ---------------------------------------------------------------------------
// Basic behaviour
// ---------------------------------------------------------------------------

test("enter returns incrementing versions", () => {
  const guard = createWorkspaceActivateGuard();
  const v1 = guard.enter("ws-A");
  const v2 = guard.enter("ws-B");
  assert.ok(v2 > v1);
});

test("isSuperseded returns false for latest version", () => {
  const guard = createWorkspaceActivateGuard();
  const v = guard.enter("ws-A");
  assert.equal(guard.isSuperseded(v), false);
});

test("isSuperseded returns true when a newer activation started", () => {
  const guard = createWorkspaceActivateGuard();
  const v1 = guard.enter("ws-A");
  const v2 = guard.enter("ws-B");
  assert.equal(guard.isSuperseded(v1), true);
  assert.equal(guard.isSuperseded(v2), false);
});

// ---------------------------------------------------------------------------
// Exit / cleanup — the core fix for the stuck overlay
// ---------------------------------------------------------------------------

test("exit clears connecting state when no newer activation started", () => {
  const guard = createWorkspaceActivateGuard();
  const v = guard.enter("ws-A");
  let connectingId: string | null = "ws-A";
  guard.exit(v, (updater) => {
    connectingId = updater(connectingId);
    return connectingId;
  });
  assert.equal(connectingId, null, "should clear to null");
});

test("exit does NOT clear when a newer activation has started", () => {
  const guard = createWorkspaceActivateGuard();
  const v1 = guard.enter("ws-A");
  const v2 = guard.enter("ws-B");
  let connectingId: string | null = "ws-B";

  // Older activation finishes — should NOT touch connectingId
  guard.exit(v1, (updater) => {
    connectingId = updater(connectingId);
    return connectingId;
  });
  assert.equal(connectingId, "ws-B", "must NOT clear — ws-B activation owns it");

  // Newer activation finishes — should clear
  guard.exit(v2, (updater) => {
    connectingId = updater(connectingId);
    return connectingId;
  });
  assert.equal(connectingId, null, "ws-B activation should clear");
});

// ---------------------------------------------------------------------------
// The exact stuck-overlay scenario: rapid A→B→A where B's cleanup fails
// ---------------------------------------------------------------------------

test("rapid A→B→A: overlay clears even when middle activation finishes last", () => {
  const guard = createWorkspaceActivateGuard();
  let connectingId: string | null = null;
  const clear = (updater: (c: string | null) => string | null) => {
    connectingId = updater(connectingId);
    return connectingId;
  };

  // Click 1: activate workspace A
  const v1 = guard.enter("ws-A");
  connectingId = "ws-A";

  // Click 2: activate workspace B (while A is still running)
  const v2 = guard.enter("ws-B");
  connectingId = "ws-B";

  // Click 3: activate workspace A again (while both A and B are still running)
  const v3 = guard.enter("ws-A");
  connectingId = "ws-A";

  // A (v1) finishes first — stale, should not touch connectingId
  guard.exit(v1, clear);
  assert.equal(connectingId, "ws-A", "v1 exit must not interfere");

  // B (v2) finishes — stale, should not touch connectingId
  guard.exit(v2, clear);
  assert.equal(connectingId, "ws-A", "v2 exit must not interfere");

  // A (v3) finishes — latest, should clear
  guard.exit(v3, clear);
  assert.equal(connectingId, null, "v3 exit must clear overlay");
});

test("rapid A→B→A: overlay clears even when final activation finishes first", () => {
  const guard = createWorkspaceActivateGuard();
  let connectingId: string | null = null;
  const clear = (updater: (c: string | null) => string | null) => {
    connectingId = updater(connectingId);
    return connectingId;
  };

  const v1 = guard.enter("ws-A");
  connectingId = "ws-A";
  const v2 = guard.enter("ws-B");
  connectingId = "ws-B";
  const v3 = guard.enter("ws-A");
  connectingId = "ws-A";

  // v3 (latest) finishes first — should clear
  guard.exit(v3, clear);
  assert.equal(connectingId, null, "latest activation should clear immediately");

  // v1 and v2 finish later — must not re-set or interfere
  guard.exit(v1, clear);
  assert.equal(connectingId, null, "stale exit must not change null");
  guard.exit(v2, clear);
  assert.equal(connectingId, null, "stale exit must not change null");
});

// ---------------------------------------------------------------------------
// The EXACT user-reported scenario
// ---------------------------------------------------------------------------

test("user clicks back and forth, then clicks Mojda session — overlay must clear", () => {
  const guard = createWorkspaceActivateGuard();
  let connectingId: string | null = null;
  const clear = (updater: (c: string | null) => string | null) => {
    connectingId = updater(connectingId);
    return connectingId;
  };

  // User clicks around between workspaces
  const v1 = guard.enter("ws-work");
  connectingId = "ws-work";
  const v2 = guard.enter("ws-personal");
  connectingId = "ws-personal";
  const v3 = guard.enter("ws-work");
  connectingId = "ws-work";

  // Now user clicks on a session in "Mojda" workspace
  const v4 = guard.enter("ws-mojda");
  connectingId = "ws-mojda";

  // Old activations finish in any order
  guard.exit(v1, clear);
  assert.equal(connectingId, "ws-mojda", "old exit must not interfere");
  guard.exit(v3, clear);
  assert.equal(connectingId, "ws-mojda", "old exit must not interfere");
  guard.exit(v2, clear);
  assert.equal(connectingId, "ws-mojda", "old exit must not interfere");

  // Mojda activation finishes — overlay MUST clear
  guard.exit(v4, clear);
  assert.equal(connectingId, null, "Mojda exit MUST clear the overlay");
});

test("user clicks back and forth, Mojda activation FAILS — overlay must still clear", () => {
  const guard = createWorkspaceActivateGuard();
  let connectingId: string | null = null;
  const clear = (updater: (c: string | null) => string | null) => {
    connectingId = updater(connectingId);
    return connectingId;
  };

  const v1 = guard.enter("ws-work");
  connectingId = "ws-work";
  const v2 = guard.enter("ws-mojda");
  connectingId = "ws-mojda";

  // v1 finishes
  guard.exit(v1, clear);
  assert.equal(connectingId, "ws-mojda");

  // Mojda activation FAILS (throws, timeout, etc.) — exit still called in finally
  guard.exit(v2, clear);
  assert.equal(connectingId, null, "even on failure, overlay MUST clear");
});
