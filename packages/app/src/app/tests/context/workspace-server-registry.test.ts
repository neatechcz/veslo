import assert from "node:assert/strict";
import test from "node:test";

import { createWorkspaceServerRegistry } from "../../context/workspace-server-registry";
import type { WorkspaceInfo } from "../../lib/tauri";
import { VesloServerError, type VesloServerClient, type VesloWorkspaceInfo } from "../../lib/veslo-server";

const localWorkspace = {
  id: "local-1",
  name: "Project",
  path: "/tmp/project",
  workspaceType: "local",
} as WorkspaceInfo;

function registryWithClient(client: Partial<VesloServerClient>, debug: unknown[] = []) {
  return createWorkspaceServerRegistry({
    getWorkspaces: () => [localWorkspace],
    vesloServerClient: () => client as VesloServerClient,
    wsDebug: (label, payload) => debug.push({ label, payload }),
  });
}

function registryWithClientGetter(input: {
  getClient: () => Partial<VesloServerClient>;
  ensureLocalVesloServerRunning?: () => Promise<boolean>;
  debug?: unknown[];
}) {
  const debug = input.debug ?? [];
  return createWorkspaceServerRegistry({
    getWorkspaces: () => [localWorkspace],
    vesloServerClient: () => input.getClient() as VesloServerClient,
    ensureLocalVesloServerRunning: input.ensureLocalVesloServerRunning,
    wsDebug: (label, payload) => debug.push({ label, payload }),
  });
}

test("activateVesloHostWorkspace fails fast when local registration fails", async () => {
  const debug: unknown[] = [];
  const registry = registryWithClient(
    {
      listWorkspaces: async () => ({ activeId: null, items: [] }),
      addLocalWorkspace: async () => {
        throw new VesloServerError(500, "registry_down", "Registry unavailable");
      },
    },
    debug,
  );

  await assert.rejects(
    () => registry.activateVesloHostWorkspace("/tmp/project"),
    /workspace_registry_unsynced:registration_failed/,
  );
  assert.match(JSON.stringify(debug), /activateVesloHostWorkspace:failed/);
});

test("activateVesloHostWorkspace fails fast when registration is not visible after refresh", async () => {
  const registry = registryWithClient({
    listWorkspaces: async () => ({ activeId: null, items: [] }),
    addLocalWorkspace: async () => ({
      activeId: "ws-project",
      workspace: {
        id: "ws-project",
        name: "Project",
        path: "/tmp/project",
        workspaceType: "local",
      },
      items: [],
      persisted: true,
    }),
  });

  await assert.rejects(
    () => registry.activateVesloHostWorkspace("/tmp/project"),
    /workspace_registry_unsynced:workspace_not_registered/,
  );
});

test("addLocalWorkspaceOnServer accepts workspace_exists only with id and path evidence", async () => {
  const registry = registryWithClient({
    addLocalWorkspace: async () => {
      throw new VesloServerError(409, "workspace_exists", "Workspace already exists", {
        id: "ws-project",
        path: "/tmp/project",
      });
    },
  });

  const result = await registry.addLocalWorkspaceOnServer("/tmp/project", "Project");

  assert.deepEqual(result, { ok: true, workspaceId: "ws-project", path: "/tmp/project" });
});

test("addLocalWorkspaceOnServer rejects workspace_exists without id and path evidence", async () => {
  const debug: unknown[] = [];
  const registry = registryWithClient(
    {
      addLocalWorkspace: async () => {
        throw new VesloServerError(409, "workspace_exists", "Workspace already exists", {
          id: "ws-project",
        });
      },
    },
    debug,
  );

  const result = await registry.addLocalWorkspaceOnServer("/tmp/project", "Project");

  assert.equal(result.ok, false);
  assert.match(JSON.stringify(debug), /addLocalWorkspaceOnServer:failed/);
});

test("addLocalWorkspaceOnServer rejects workspace_exists for a different path", async () => {
  const debug: unknown[] = [];
  const registry = registryWithClient(
    {
      addLocalWorkspace: async () => {
        throw new VesloServerError(409, "workspace_exists", "Workspace already exists", {
          id: "ws-other",
          path: "/tmp/other-project",
        });
      },
    },
    debug,
  );

  const result = await registry.addLocalWorkspaceOnServer("/tmp/project", "Project");

  assert.equal(result.ok, false);
  assert.match(JSON.stringify(debug), /addLocalWorkspaceOnServer:failed/);
});

test("activateVesloHostWorkspace rejects mismatched workspace_exists evidence instead of activating another path", async () => {
  let activateCalls = 0;
  const registry = registryWithClient({
    listWorkspaces: async () => ({ activeId: null, items: [] }),
    addLocalWorkspace: async () => {
      throw new VesloServerError(409, "workspace_exists", "Workspace already exists", {
        id: "ws-other",
        path: "/tmp/other-project",
      });
    },
    activateWorkspace: async () => {
      activateCalls += 1;
      const workspace: VesloWorkspaceInfo = {
        id: "ws-other",
        name: "Other Project",
        path: "/tmp/other-project",
        workspaceType: "local",
      };
      return { activeId: workspace.id, workspace };
    },
  });

  await assert.rejects(
    () => registry.activateVesloHostWorkspace("/tmp/project"),
    /workspace_registry_unsynced:registration_failed/,
  );
  assert.equal(activateCalls, 0);
});

test("activateVesloHostWorkspace refreshes stale local host token once", async () => {
  const calls: string[] = [];
  const debug: unknown[] = [];
  const staleClient = {
    listWorkspaces: async () => {
      calls.push("stale:list");
      return { activeId: null, items: [] };
    },
    addLocalWorkspace: async () => {
      calls.push("stale:add");
      throw new VesloServerError(401, "unauthorized", "Invalid host token");
    },
  };
  const freshWorkspace: VesloWorkspaceInfo = {
    id: "ws-project",
    name: "Project",
    path: "/tmp/project",
    workspaceType: "local",
  };
  const freshClient = {
    listWorkspaces: async () => {
      calls.push("fresh:list");
      return {
        activeId: null,
        items: [freshWorkspace],
      };
    },
    activateWorkspace: async (workspaceId: string) => {
      calls.push(`fresh:activate:${workspaceId}`);
      const workspace: VesloWorkspaceInfo = {
        id: workspaceId,
        name: "Project",
        path: "/tmp/project",
        workspaceType: "local",
      };
      return { activeId: workspaceId, workspace };
    },
  };
  let currentClient: Partial<VesloServerClient> = staleClient;
  const registry = registryWithClientGetter({
    debug,
    getClient: () => currentClient,
    ensureLocalVesloServerRunning: async () => {
      calls.push("ensure-local");
      currentClient = freshClient;
      return true;
    },
  });

  await registry.activateVesloHostWorkspace("/tmp/project");

  assert.deepEqual(calls, [
    "stale:list",
    "stale:add",
    "ensure-local",
    "fresh:list",
    "fresh:activate:ws-project",
  ]);
  assert.match(JSON.stringify(debug), /host-token-refresh:start/);
  assert.doesNotMatch(JSON.stringify(debug), /activateVesloHostWorkspace:failed/);
});

test("reconcileVesloServerWorkspaces is read-only for missing local workspaces", async () => {
  const debug: unknown[] = [];
  let addCalls = 0;
  const registry = registryWithClient(
    {
      listWorkspaces: async () => ({ activeId: null, items: [] }),
      addLocalWorkspace: async () => {
        addCalls += 1;
        throw new Error("reconcile should not write");
      },
    },
    debug,
  );

  await registry.reconcileVesloServerWorkspaces();

  assert.equal(addCalls, 0);
  assert.match(JSON.stringify(debug), /reconcileVesloServerWorkspaces:workspace_registry_unsynced/);
  assert.match(JSON.stringify(debug), /reconcileManagedAiApiKeys:skip/);
});
