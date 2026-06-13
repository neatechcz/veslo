import assert from "node:assert/strict";
import test from "node:test";

import {
  createInitialWorkspaceLifecycleState,
  reduceWorkspaceLifecycleState,
} from "../../context/workspace-lifecycle-state";

test("local browse activation keeps another workspace connected", () => {
  let state = createInitialWorkspaceLifecycleState();

  state = reduceWorkspaceLifecycleState(state, {
    type: "connected",
    workspaceId: "ws-a",
    runtime: "veslo-orchestrator",
    reason: "existing-run",
  });

  state = reduceWorkspaceLifecycleState(state, {
    type: "activation-started",
    workspaceId: "ws-b",
    version: 2,
    origin: "sidebar-click",
    workspaceType: "local",
  });

  state = reduceWorkspaceLifecycleState(state, {
    type: "browse-ready",
    workspaceId: "ws-b",
    version: 2,
    root: "C:/work/b",
  });

  assert.equal(state.activeWorkspaceId, "ws-b");
  assert.equal(state.byWorkspace["ws-a"]?.phase, "connected");
  assert.equal(state.byWorkspace["ws-b"]?.phase, "browsing");
  assert.equal(state.byWorkspace["ws-b"]?.root, "C:/work/b");
});

test("superseded activation events do not overwrite newer workspace state", () => {
  let state = createInitialWorkspaceLifecycleState();

  state = reduceWorkspaceLifecycleState(state, {
    type: "activation-started",
    workspaceId: "ws-a",
    version: 1,
    origin: "first-click",
    workspaceType: "local",
  });

  state = reduceWorkspaceLifecycleState(state, {
    type: "activation-started",
    workspaceId: "ws-b",
    version: 2,
    origin: "second-click",
    workspaceType: "local",
  });

  state = reduceWorkspaceLifecycleState(state, {
    type: "connected",
    workspaceId: "ws-a",
    version: 1,
    runtime: "veslo-orchestrator",
    reason: "late-connect",
  });

  assert.equal(state.activeWorkspaceId, "ws-b");
  assert.equal(state.byWorkspace["ws-a"]?.phase, "activating");
  assert.equal(state.byWorkspace["ws-b"]?.phase, "activating");
});

test("runtime-starting and failed events are scoped per workspace", () => {
  let state = createInitialWorkspaceLifecycleState();

  state = reduceWorkspaceLifecycleState(state, {
    type: "runtime-starting",
    workspaceId: "ws-a",
    runtime: "veslo-orchestrator",
    reason: "browse-attach",
  });

  state = reduceWorkspaceLifecycleState(state, {
    type: "failed",
    workspaceId: "ws-a",
    message: "engine_info timed out",
  });

  state = reduceWorkspaceLifecycleState(state, {
    type: "connected",
    workspaceId: "ws-b",
    runtime: "veslo-orchestrator",
    reason: "background-run",
  });

  assert.equal(state.byWorkspace["ws-a"]?.phase, "error");
  assert.equal(state.byWorkspace["ws-a"]?.message, "engine_info timed out");
  assert.equal(state.byWorkspace["ws-b"]?.phase, "connected");
});
