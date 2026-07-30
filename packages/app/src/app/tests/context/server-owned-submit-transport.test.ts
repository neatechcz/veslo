import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyAdmissionTransportError,
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

test("server-owned submit transport waits for cold admission before restarting the server", async () => {
  const order: string[] = [];
  let releaseAdmission!: () => void;
  const admission = new Promise<void>((resolve) => {
    releaseAdmission = resolve;
  });
  const result = ensureServerOwnedSubmitTransport({
    isTauriRuntime: true,
    targetWorkspace: { workspaceId: "ws-local" },
    workspaces: [localWorkspace],
    ensureAdmissionTransport: async () => {
      order.push("admission-start");
      await admission;
      order.push("admission-ready");
    },
    ensureLocalVesloServerRunning: async () => {
      order.push("server-restart");
      return true;
    },
  });

  await Promise.resolve();
  assert.deepEqual(order, ["admission-start"]);
  releaseAdmission();
  assert.equal(await result, true);
  assert.deepEqual(order, [
    "admission-start",
    "admission-ready",
    "server-restart",
  ]);
});

test("admission transport errors expose a stable diagnostic code without raw details", () => {
  assert.equal(
    classifyAdmissionTransportError(
      "Admission transport daemon did not become ready.",
    ),
    "daemon-not-ready",
  );
  assert.equal(
    classifyAdmissionTransportError(
      "Admission transport started without a workspace proxy descriptor.",
    ),
    "proxy-descriptor-missing",
  );
  assert.equal(classifyAdmissionTransportError({ secret: "hidden" }), "unknown");
});

test("server-owned submit transport does not ensure the server when admission daemon startup fails", async () => {
  let serverEnsures = 0;
  const traces: Array<{
    event: string;
    payload: Record<string, unknown>;
  }> = [];
  const ready = await ensureServerOwnedSubmitTransport({
    isTauriRuntime: true,
    targetWorkspace: { workspaceId: "ws-local" },
    workspaces: [localWorkspace],
    ensureAdmissionTransport: async () => {
      throw new Error("Admission transport daemon did not become ready.");
    },
    ensureLocalVesloServerRunning: async () => {
      serverEnsures += 1;
      return true;
    },
    recordTrace: (event, payload) => traces.push({ event, payload }),
  });

  assert.equal(ready, false);
  assert.equal(serverEnsures, 0);
  assert.deepEqual(
    traces.map(({ event }) => event),
    [
      "runtime-readiness:admission-transport:start",
      "runtime-readiness:admission-transport:error",
    ],
  );
  assert.deepEqual(traces[1]?.payload, {
    traceId: null,
    workspaceId: "ws-local",
    errorType: "Error",
    errorCode: "daemon-not-ready",
  });
});
