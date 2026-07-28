import assert from "node:assert/strict";
import test from "node:test";
import { resolveServerOwnedSubmitTransportTarget } from "../../context/server-owned-submit-transport.js";

const localWorkspace = {
  id: "ws-local",
  workspaceType: "local",
  path: "C:/work/local",
  directory: "C:/work/local",
};

test("server-owned submit transport uses the registered local root, not a conversation directory", () => {
  assert.deepEqual(
    resolveServerOwnedSubmitTransportTarget({
      isTauriRuntime: true,
      targetWorkspace: {
        workspaceId: "ws-local",
        workspaceRoot: "C:/work/local",
        directory: "C:/work/local/subdir",
      },
      workspaces: [localWorkspace],
    }),
    { kind: "local", workspaceId: "ws-local", workspacePath: "C:/work/local" },
  );
});

test("server-owned submit transport remains passive for remote and browser submit", () => {
  assert.deepEqual(
    resolveServerOwnedSubmitTransportTarget({
      isTauriRuntime: true,
      targetWorkspace: { workspaceId: "ws-remote" },
      workspaces: [{ id: "ws-remote", workspaceType: "remote", path: "https://remote.example" }],
    }),
    { kind: "skip", reason: "non-local-workspace" },
  );
  assert.deepEqual(
    resolveServerOwnedSubmitTransportTarget({
      isTauriRuntime: false,
      targetWorkspace: { workspaceId: "ws-local" },
      workspaces: [localWorkspace],
    }),
    { kind: "skip", reason: "non-tauri" },
  );
});

test("server-owned submit transport fails closed for an unknown local target", () => {
  assert.deepEqual(
    resolveServerOwnedSubmitTransportTarget({
      isTauriRuntime: true,
      targetWorkspace: { workspaceId: "ws-missing" },
      workspaces: [localWorkspace],
    }),
    { kind: "unavailable", reason: "workspace-not-found" },
  );
});
