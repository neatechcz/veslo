import assert from "node:assert/strict";
import test from "node:test";

import { createRoot, createSignal } from "solid-js";

import {
  createScheduledAutomationStore,
  type ScheduledAutomationStoreDeps,
} from "../../pages/scheduled-automation-store.js";
import type {
  AutomationWorkspaceSummary,
  VesloAutomation,
  VesloAutomationRun,
} from "../../types.js";
import type { VesloServerClient, VesloServerStatus } from "../../lib/veslo-server.js";
import type { WorkspaceInfo, VesloServerInfo } from "../../lib/tauri.js";

function workspace(input: Partial<WorkspaceInfo> & Pick<WorkspaceInfo, "id">): WorkspaceInfo {
  return {
    id: input.id,
    name: input.name ?? input.id,
    displayName: input.displayName ?? input.name ?? input.id,
    path: input.path ?? `C:/work/${input.id}`,
    directory: input.directory ?? input.path ?? `C:/work/${input.id}`,
    preset: input.preset ?? "default",
    workspaceType: input.workspaceType ?? "local",
    vesloWorkspaceId: input.vesloWorkspaceId,
    vesloWorkspaceName: input.vesloWorkspaceName,
    baseUrl: input.baseUrl,
  };
}

function automation(input: Partial<VesloAutomation> & Pick<VesloAutomation, "id" | "workspaceId">): VesloAutomation {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    name: input.name ?? input.id,
    enabled: input.enabled ?? true,
    status: input.status ?? "active",
    schedule: input.schedule ?? { kind: "daily", hour: 8, minute: 30 },
    prompt: input.prompt ?? "Plan the day",
    target: input.target,
    createdAt: input.createdAt ?? "2026-07-01T08:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-07-01T08:00:00.000Z",
    nextRunAt: input.nextRunAt ?? null,
    completedAt: input.completedAt ?? null,
    lastRunAt: input.lastRunAt ?? null,
    lastRunId: input.lastRunId ?? null,
  };
}

function automationRun(input: Partial<VesloAutomationRun> & Pick<VesloAutomationRun, "id" | "automationId">): VesloAutomationRun {
  return {
    id: input.id,
    automationId: input.automationId,
    scheduledFor: input.scheduledFor ?? "2026-07-01T09:00:00.000Z",
    startedAt: input.startedAt ?? "2026-07-01T09:00:00.000Z",
    finishedAt: input.finishedAt ?? "2026-07-01T09:01:00.000Z",
    status: input.status ?? "success",
    sessionId: input.sessionId ?? null,
    createdSession: input.createdSession ?? true,
    error: input.error ?? null,
  };
}

function liveServerInfo(): VesloServerInfo {
  return {
    running: true,
    host: "127.0.0.1",
    port: 8787,
    instanceId: "instance-test",
    baseUrl: "http://127.0.0.1:8787",
    connectUrl: null,
    mdnsUrl: null,
    lanUrl: null,
    engineUrl: null,
    clientToken: "client-token",
    hostToken: "host-token",
    pid: 123,
    lastStdout: null,
    lastStderr: null,
  };
}

function createClient(overrides: Partial<VesloServerClient> = {}): VesloServerClient {
  return {
    baseUrl: "http://127.0.0.1:8787",
    token: "client-token",
    listWorkspaces: async () => ({ items: [] }),
    automations: {
      list: async () => ({ items: [], updatedAt: "2026-07-01T08:00:00.000Z" }),
      listRuns: async () => ({ items: [] }),
      create: async (workspaceId: string) => ({
        automation: automation({ id: "created", workspaceId }),
      }),
      update: async (workspaceId: string, automationId: string) => ({
        automation: automation({ id: automationId, workspaceId, name: "Updated" }),
      }),
      delete: async (workspaceId: string, automationId: string) => ({
        automation: automation({ id: automationId, workspaceId, enabled: false, status: "cancelled" }),
      }),
      run: async (_workspaceId: string, automationId: string) => ({
        run: automationRun({ id: "run-1", automationId }),
      }),
    },
    ...overrides,
  } as unknown as VesloServerClient;
}

function createDeps(overrides: Partial<ScheduledAutomationStoreDeps> = {}) {
  const [status, setStatus] = createSignal<VesloServerStatus>("connected");
  const [client, setClient] = createSignal<VesloServerClient | null>(createClient());
  const [workspaces, setWorkspaces] = createSignal<WorkspaceInfo[]>([
    workspace({ id: "app-1", directory: "C:/work/app-1" }),
  ]);
  const [activeWorkspaceId, setActiveWorkspaceId] = createSignal("app-1");
  const [activeWorkspaceType, setActiveWorkspaceType] = createSignal<"local" | "remote">("local");
  const calls = {
    ensured: 0,
    hostInfo: 0,
    statusSet: [] as VesloServerStatus[],
    hostSnapshots: [] as Array<VesloServerInfo | null>,
  };

  const deps: ScheduledAutomationStoreDeps = {
    workspaces,
    activeWorkspaceId,
    activeWorkspaceType,
    vesloServerClient: client,
    vesloServerStatus: status,
    startupPreference: () => "local",
    isTauriRuntime: () => true,
    ensureLocalVesloServerRunning: async () => {
      calls.ensured += 1;
      return true;
    },
    vesloServerInfo: async () => {
      calls.hostInfo += 1;
      return liveServerInfo();
    },
    setVesloServerHostInfoStable: (info) => {
      calls.hostSnapshots.push(info);
    },
    checkVesloServer: async () => ({ status: "connected", capabilities: null }),
    setVesloServerStatus: (nextStatus) => {
      calls.statusSet.push(nextStatus);
      setStatus(nextStatus);
    },
    setVesloServerCapabilitiesStable: () => {},
    setVesloServerCheckedAt: () => {},
    createVesloServerClient: ({ baseUrl, token }) => createClient({ baseUrl, token }),
    now: () => 1000,
    reportError: (error) => {
      throw error;
    },
    ...overrides,
  };

  return {
    deps,
    calls,
    setStatus,
    setClient,
    setWorkspaces,
    setActiveWorkspaceId,
    setActiveWorkspaceType,
  };
}

test("local scheduled automation source bootstraps the local Veslo server when disconnected", async () => {
  await createRoot(async (dispose) => {
    try {
      const { deps, calls, setStatus, setClient } = createDeps();
      setStatus("disconnected");
      setClient(null);

      const store = createScheduledAutomationStore(deps);

      assert.equal(store.scheduledJobsSource(), "local");
      assert.equal(store.scheduledJobsSourceReady(), false);
      assert.equal(await store.ensureScheduledJobsSourceReady(), true);
      assert.equal(calls.ensured, 1);

      const recoveredClient = await store.ensureScheduledJobsClient();
      assert.ok(recoveredClient);
      assert.equal(calls.hostInfo, 1);
      assert.deepEqual(calls.statusSet, ["connected"]);
    } finally {
      dispose();
    }
  });
});

test("refreshScheduledJobs keeps successful workspaces when another workspace fails", async () => {
  await createRoot(async (dispose) => {
    try {
      const goodAutomation = automation({ id: "auto-1", workspaceId: "server-good", name: "Daily brief" });
      const { deps, setWorkspaces } = createDeps();
      setWorkspaces([
        workspace({ id: "app-good", path: "C:/work/good", directory: "C:/work/good", vesloWorkspaceId: "server-good" }),
        workspace({ id: "app-bad", path: "C:/work/bad", directory: "C:/work/bad", vesloWorkspaceId: "server-bad" }),
      ]);
      const client = createClient({
        listWorkspaces: async () => ({
          items: [
            { id: "server-good", name: "Good", path: "C:/work/good", workspaceType: "local" },
            { id: "server-bad", name: "Bad", path: "C:/work/bad", workspaceType: "local" },
          ],
        }),
        automations: {
          ...createClient().automations,
          list: async (workspaceId: string) => {
            if (workspaceId === "server-bad") throw new Error("workspace unavailable");
            return { items: [goodAutomation], updatedAt: "2026-07-01T08:00:00.000Z" };
          },
          listRuns: async () => ({ items: [automationRun({ id: "run-good", automationId: "auto-1" })] }),
        },
      });
      const store = createScheduledAutomationStore({
        ...deps,
        vesloServerClient: () => client,
      });

      await store.refreshScheduledJobs({ force: true });

      assert.equal(store.scheduledJobsBusy(), false);
      assert.equal(store.scheduledJobsStatus(), "Some workspaces could not load automations.");
      assert.deepEqual(
        store.automationItems().map((item) => ({
          key: item.key,
          workspaceId: item.workspace.serverWorkspaceId,
          runCount: item.runs.length,
        })),
        [{ key: "server-good:auto-1", workspaceId: "server-good", runCount: 1 }],
      );
      assert.deepEqual(
        store.automationWorkspaces().map((item: AutomationWorkspaceSummary) => ({
          appWorkspaceId: item.appWorkspaceId,
          serverWorkspaceId: item.serverWorkspaceId,
          status: item.status,
          error: item.error ?? null,
        })),
        [
          { appWorkspaceId: "app-good", serverWorkspaceId: "server-good", status: "ready", error: null },
          { appWorkspaceId: "app-bad", serverWorkspaceId: "server-bad", status: "error", error: "workspace unavailable" },
        ],
      );
      assert.equal(store.scheduledJobsUpdatedAt(), 1000);
    } finally {
      dispose();
    }
  });
});

test("automation mutations upsert items and run history in store state", async () => {
  await createRoot(async (dispose) => {
    try {
      const initial = automation({ id: "auto-1", workspaceId: "server-1", name: "Initial" });
      const created = automation({ id: "auto-2", workspaceId: "server-1", name: "Created" });
      const updated = automation({ id: "auto-1", workspaceId: "server-1", name: "Updated" });
      const deleted = automation({ id: "auto-2", workspaceId: "server-1", enabled: false, status: "cancelled" });
      const run = automationRun({ id: "run-2", automationId: "auto-1", finishedAt: "2026-07-01T10:00:00.000Z" });
      const client = createClient({
        listWorkspaces: async () => ({
          items: [
            { id: "server-1", name: "Server 1", path: "C:/work/app-1", workspaceType: "local" },
          ],
        }),
        automations: {
          ...createClient().automations,
          list: async () => ({ items: [initial], updatedAt: "2026-07-01T08:00:00.000Z" }),
          listRuns: async () => ({ items: [] }),
          create: async () => ({ automation: created }),
          update: async () => ({ automation: updated }),
          delete: async () => ({ automation: deleted }),
          run: async () => ({ run }),
        },
      });
      const { deps } = createDeps({
        vesloServerClient: () => client,
      });
      const store = createScheduledAutomationStore(deps);
      await store.refreshScheduledJobs({ force: true });

      await store.createAutomation("server-1", {
        name: "Created",
        prompt: "Create",
        schedule: { kind: "daily", hour: 9, minute: 0 },
      });
      await store.updateAutomation("server-1", "auto-1", { name: "Updated" });
      await store.deleteAutomation("server-1", "auto-2");
      await store.runAutomation("server-1", "auto-1");

      assert.deepEqual(
        store.automationItems().map((item) => ({
          key: item.key,
          name: item.automation.name,
          status: item.automation.status,
          lastRunId: item.automation.lastRunId,
          runs: item.runs.map((entry) => entry.id),
        })),
        [
          { key: "server-1:auto-2", name: "auto-2", status: "cancelled", lastRunId: null, runs: [] },
          { key: "server-1:auto-1", name: "Updated", status: "active", lastRunId: "run-2", runs: ["run-2"] },
        ],
      );
      assert.equal(store.scheduledJobsUpdatedAt(), 1000);
    } finally {
      dispose();
    }
  });
});
