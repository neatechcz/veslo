import assert from "node:assert/strict";
import test from "node:test";

import type { Session } from "@opencode-ai/sdk/v2/client";
import { createRoot } from "solid-js";

import {
  createSidebarWorkspaceSessions,
} from "../../context/sidebar-workspace-sessions.js";
import type { WorkspaceRouting } from "../../context/workspace-routing.js";
import type { WorkspaceStore } from "../../context/workspace.js";
import type { SidebarSessionItem } from "../../types.js";
import type { WorkspaceInfo } from "../../lib/tauri.js";

const localWorkspace = (): WorkspaceInfo => ({
  id: "ws-local",
  name: "Local",
  path: "C:/work/project",
  preset: "starter",
  workspaceType: "local",
});

const createWorkspaceStore = (workspace: WorkspaceInfo) => ({
  workspaces: () => [workspace],
  activeWorkspaceId: () => workspace.id,
  connectingWorkspaceId: () => null,
  engine: () => null,
  isPrivateWorkspacePath: () => false,
}) as unknown as WorkspaceStore;

const createWorkspaceRouting = (): WorkspaceRouting => ({
  client: () => null,
  active: () => null,
  activeWorkspaceId: () => "ws-local",
  entry: () => null,
  ensure: async () => null,
  lastEnsureError: () => null,
  release: () => undefined,
  forEach: () => undefined,
  entryIds: () => [],
});

test("local sidebar live-list denial follows the soft-skip runtime branch", async () => {
  await createRoot(async (dispose) => {
    const workspace = localWorkspace();
    const debugEvents: Array<{ label: string; payload?: unknown }> = [];
    const controller = createSidebarWorkspaceSessions({
      workspaceStore: createWorkspaceStore(workspace),
      workspaceRouting: createWorkspaceRouting(),
      activeWorkspaceRuntimeReady: () => true,
      developerMode: () => false,
      sessions: () => [],
      sessionDirectoryOverrideById: () => ({}),
      resolveSessionDirectory: (session) => session.directory ?? "",
      applySessionDirectoryOverride: <T extends Session | SidebarSessionItem>(session: T) => session,
      applyPendingInitialSessionTitle: <T extends Session | SidebarSessionItem>(session: T) => session,
      listConversationsFromVesloReadApi: async () => ({
        items: [],
        source: "unavailable" as const,
      }),
      shouldSyncConversationRead: () => false,
      allowLiveWorkspaceSessionList: () => false,
      reportError: (error) => {
        throw error;
      },
      wsDebug: (label, payload) => {
        debugEvents.push({ label, payload });
      },
    });
    const existingRow: SidebarSessionItem = {
      id: "existing-session",
      title: "Existing session",
      directory: workspace.path,
    };

    try {
      controller.replaceWorkspaceSidebarSessions(workspace.id, [existingRow]);
      await controller.refreshSidebarWorkspaceSessions(workspace.id);

      assert.deepEqual(controller.sidebarSessionsByWorkspaceId()[workspace.id], [existingRow]);
      assert.equal(
        debugEvents.some(
          (event) =>
            event.label === "sidebar:conversation-read:unavailable" &&
            JSON.stringify(event.payload).includes("live-session-list-not-allowed"),
        ),
        false,
      );
      assert.equal(
        debugEvents.some(
          (event) =>
            event.label === "sidebar:live-session-list:skipped" &&
            JSON.stringify(event.payload).includes("live-session-list-not-allowed"),
        ),
        true,
      );
    } finally {
      dispose();
    }
  });
});
