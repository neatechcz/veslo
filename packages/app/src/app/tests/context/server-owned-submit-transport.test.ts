import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureServerOwnedSubmitTransport,
  resolveServerOwnedSubmitTransportTarget,
} from "../../context/server-owned-submit-transport.js";

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

test("server-owned submit transport rebinds the local server after daemon admission", async () => {
  const admissions: Array<Record<string, string>> = [];
  const serverEnsures: Array<Record<string, unknown>> = [];
  const ready = await ensureServerOwnedSubmitTransport({
    isTauriRuntime: true,
    targetWorkspace: { workspaceId: "ws-local" },
    workspaces: [localWorkspace],
    ensureAdmissionTransport: async (input) => {
      admissions.push(input);
    },
    ensureLocalVesloServerRunning: async (input) => {
      serverEnsures.push(input);
      return true;
    },
  });

  assert.equal(ready, true);
  assert.deepEqual(admissions, [
    { workspaceId: "ws-local", workspacePath: "C:/work/local" },
  ]);
  assert.deepEqual(serverEnsures, [
    { requireRuntimeChainReady: false, forceRestart: true },
  ]);
});

test("server-owned submit transport does not ensure the server when admission daemon startup fails", async () => {
  let serverEnsures = 0;
  const ready = await ensureServerOwnedSubmitTransport({
    isTauriRuntime: true,
    targetWorkspace: { workspaceId: "ws-local" },
    workspaces: [localWorkspace],
    ensureAdmissionTransport: async () => {
      throw new Error("daemon unavailable");
    },
    ensureLocalVesloServerRunning: async () => {
      serverEnsures += 1;
      return true;
    },
  });

  assert.equal(ready, false);
  assert.equal(serverEnsures, 0);
});
