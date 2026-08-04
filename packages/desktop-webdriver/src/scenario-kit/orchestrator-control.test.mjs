import assert from "node:assert/strict";
import test from "node:test";

import {
  assertLoopbackOrchestratorUrl,
  resolveOrchestratorWorkspace,
} from "./orchestrator-control.mjs";

test("orchestrator control accepts only an explicit loopback HTTP origin", () => {
  assert.equal(assertLoopbackOrchestratorUrl("http://127.0.0.1:53123"), "http://127.0.0.1:53123");
  assert.throws(() => assertLoopbackOrchestratorUrl("http://localhost:53123"), /loopback/);
  assert.throws(() => assertLoopbackOrchestratorUrl("https://127.0.0.1:53123"), /loopback/);
});

test("orchestrator workspace resolution accepts the visible label and rejects ambiguity", () => {
  const workspaces = [{ id: "ws-server", name: "Disposable workspace", appWorkspaceId: "ws-app" }];
  assert.equal(resolveOrchestratorWorkspace(workspaces, "Disposable workspace").id, "ws-server");
  assert.equal(resolveOrchestratorWorkspace(workspaces, "ws-app").id, "ws-server");
  assert.throws(
    () => resolveOrchestratorWorkspace([...workspaces, { id: "ws-b", name: "Disposable workspace" }], "Disposable workspace"),
    /found 2/,
  );
});
