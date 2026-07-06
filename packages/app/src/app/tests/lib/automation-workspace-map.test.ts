import assert from "node:assert/strict";
import test from "node:test";

import { buildAutomationWorkspaceSummaries } from "../../lib/automation-workspace-map.js";
import type { WorkspaceInfo } from "../../lib/tauri.js";
import type { VesloWorkspaceInfo } from "../../lib/veslo-server.js";

const localWorkspace = (overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({
  id: "app-local",
  name: "Local workspace",
  path: "/Users/example/project",
  preset: "starter",
  workspaceType: "local",
  remoteType: null,
  ...overrides,
});

const remoteVesloWorkspace = (overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({
  id: "app-remote",
  name: "workspace",
  path: "/tmp/workspace",
  preset: "starter",
  workspaceType: "remote",
  remoteType: "veslo",
  baseUrl: "https://remote.example/w/ws_remote/opencode",
  vesloHostUrl: "https://remote.example",
  vesloWorkspaceId: "ws_remote",
  ...overrides,
});

const serverWorkspace = (overrides: Partial<VesloWorkspaceInfo> = {}): VesloWorkspaceInfo => ({
  id: "server-local",
  name: "Local workspace",
  path: "/Users/example/project",
  workspaceType: "local",
  opencode: { directory: "/Users/example/project" },
  ...overrides,
});

test("buildAutomationWorkspaceSummaries skips remote Veslo workspaces from another connected server", () => {
  const summaries = buildAutomationWorkspaceSummaries({
    appWorkspaces: [
      localWorkspace(),
      remoteVesloWorkspace({
        baseUrl: "https://den-worker-dev.example/w/ws_be215dcee352/opencode",
        vesloHostUrl: "https://den-worker-dev.example",
        vesloWorkspaceId: "ws_be215dcee352",
      }),
    ],
    serverWorkspaces: [serverWorkspace()],
    connectedServerBaseUrl: "http://127.0.0.1:8787",
  });

  assert.deepEqual(summaries.map((summary) => summary.appWorkspaceId), ["app-local"]);
  assert.equal(summaries[0]?.serverWorkspaceId, null);
  assert.equal(summaries[0]?.status, "unavailable");
  assert.equal(summaries.some((summary) => summary.name === "workspace"), false);
});

test("buildAutomationWorkspaceSummaries reports local workspaces missing from the connected server", () => {
  const summaries = buildAutomationWorkspaceSummaries({
    appWorkspaces: [localWorkspace()],
    serverWorkspaces: [],
    connectedServerBaseUrl: "http://127.0.0.1:8787",
  });

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.appWorkspaceId, "app-local");
  assert.equal(summaries[0]?.status, "unavailable");
  assert.equal(summaries[0]?.error, "Workspace is not mapped on the connected Veslo server.");
});

test("buildAutomationWorkspaceSummaries uses mapped local Veslo workspace ids and ignores path matching", () => {
  const summaries = buildAutomationWorkspaceSummaries({
    appWorkspaces: [
      localWorkspace({
        vesloWorkspaceId: "server-mapped",
        path: "/Users/example/project-with-drift",
      }),
    ],
    serverWorkspaces: [
      serverWorkspace({
        id: "server-mapped",
        path: "/private/var/example/project",
        opencode: { directory: "/private/var/example/project" },
      }),
      serverWorkspace({
        id: "server-path-match",
        path: "/Users/example/project-with-drift",
        opencode: { directory: "/Users/example/project-with-drift" },
      }),
    ],
    connectedServerBaseUrl: "http://127.0.0.1:8787",
  });

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.appWorkspaceId, "app-local");
  assert.equal(summaries[0]?.serverWorkspaceId, "server-mapped");
  assert.equal(summaries[0]?.status, "ready");
});

test("buildAutomationWorkspaceSummaries keeps remote Veslo workspaces that belong to the connected server", () => {
  const summaries = buildAutomationWorkspaceSummaries({
    appWorkspaces: [remoteVesloWorkspace()],
    serverWorkspaces: [
      serverWorkspace({
        id: "ws_remote",
        name: "workspace",
        path: "/tmp/workspace",
        directory: "/tmp/workspace",
        workspaceType: "remote",
      }),
    ],
    connectedServerBaseUrl: "https://remote.example",
  });

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.appWorkspaceId, "app-remote");
  assert.equal(summaries[0]?.serverWorkspaceId, "ws_remote");
  assert.equal(summaries[0]?.status, "ready");
});
