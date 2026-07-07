import assert from "node:assert/strict";
import test from "node:test";

import { createRoot, createSignal } from "solid-js";

import {
  createSkillRegistryEventsKey,
  createSkillRegistryOrchestrator,
  type SkillRegistryOrchestratorListenerFactory,
} from "../../context/skill-registry-orchestrator.js";
import type { WorkspaceBusyMap } from "../../context/workspace-debug.js";
import type {
  SkillRegistryEvent,
  SkillRegistryEventsListenerOptions,
} from "../../lib/skill-registry-events.js";
import { SkillRegistryEventsAuthError } from "../../lib/skill-registry-events.js";
import type { VesloServerClient } from "../../lib/veslo-server.js";

type MaterializationCall =
  | { kind: "workspace"; workspaceId: string; options: unknown }
  | { kind: "global"; options: unknown };

function registryEvent(input: Partial<SkillRegistryEvent> = {}): SkillRegistryEvent {
  return {
    id: input.id ?? "evt-1",
    action: input.action ?? "updated",
    orgId: input.orgId ?? "org-1",
    workspaceId: input.workspaceId,
    skillId: input.skillId ?? "planning",
    versionId: input.versionId ?? null,
    installationId: input.installationId ?? null,
    actorUserId: input.actorUserId ?? null,
    payload: input.payload,
    createdAt: input.createdAt ?? "2026-07-01T12:00:00.000Z",
  };
}

async function flushEffects() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolveTick) => setTimeout(resolveTick, 0));
}

async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let index = 0; index < 20; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flushEffects();
    }
  }
  throw lastError;
}

function createListenerCapture() {
  let listenerOptions: SkillRegistryEventsListenerOptions | null = null;
  let started = 0;
  let stopped = 0;
  const createListener: SkillRegistryOrchestratorListenerFactory = (options) => {
    listenerOptions = options;
    return {
      start() {
        started += 1;
      },
      stop() {
        stopped += 1;
      },
      pollNow: async () => {},
      getState: () => ({
        running: started > stopped,
        cursor: null,
        revision: null,
        inFlight: false,
      }),
    };
  };

  return {
    createListener,
    get options() {
      assert.ok(listenerOptions, "expected listener options to be captured");
      return listenerOptions;
    },
    get started() {
      return started;
    },
    get stopped() {
      return stopped;
    },
  };
}

function createClient(calls: MaterializationCall[], token = "server-token"): VesloServerClient {
  return {
    baseUrl: "http://127.0.0.1:8787",
    token,
    syncWorkspaceSkillMaterialization: async (workspaceId: string, options?: unknown) => {
      calls.push({ kind: "workspace", workspaceId, options });
      return { synced: true, reloadRequired: false };
    },
    syncGlobalSkillMaterialization: async (options?: unknown) => {
      calls.push({ kind: "global", options });
      return { synced: true, reloadRequired: false };
    },
  } as unknown as VesloServerClient;
}

function denAuth() {
  return {
    denApiBase: " https://den.test ",
    token: " den-token ",
    orgId: " org-1 ",
    user: { id: " user-1 " },
    org: { id: " org-1 " },
  };
}

test("workspace update during active run queues replay and marks reload", async () => {
  await createRoot(async (dispose) => {
    try {
      const calls: MaterializationCall[] = [];
      const reloads: unknown[] = [];
      let refreshes = 0;
      let invalidations = 0;
      const listener = createListenerCapture();
      const client = createClient(calls);
      const [busy, setBusy] = createSignal<WorkspaceBusyMap>({
        "workspace-1": { "session-1": { startedAt: 1 } },
      });

      const orchestrator = createSkillRegistryOrchestrator({
        vesloServerClient: () => client,
        vesloServerStatus: () => "connected",
        activeWorkspaceId: () => "workspace-1",
        workspaceBusy: busy,
        denAuthRevision: () => 1,
        readDenAuth: denAuth,
        refreshSkills: async () => {
          refreshes += 1;
        },
        invalidateSkillRegistryInventory: async () => {
          invalidations += 1;
        },
        markReloadRequired: (...args) => {
          reloads.push(args);
        },
        reportError: (error) => {
          throw error;
        },
        createListener: listener.createListener,
      });

      await flushEffects();
      await listener.options.onWorkspaceUpdatePending?.({
        workspaceId: "workspace-1",
        status: "pending",
        reloadRequired: true,
        event: registryEvent({ id: "evt-active", workspaceId: "workspace-1", skillId: "planning" }),
      });

      assert.deepEqual(calls, [
        {
          kind: "workspace",
          workspaceId: "workspace-1",
          options: {
            denApiBase: "https://den.test",
            denToken: "den-token",
            denOrgId: "org-1",
            denUserId: "user-1",
            activeRun: true,
          },
        },
      ]);
      assert.deepEqual(reloads, [
        ["skills", { type: "skill", action: "updated", name: "planning" }],
      ]);
      assert.deepEqual(orchestrator.pendingSkillRegistryWorkspaceReplays(), {
        "workspace-1": { eventId: "evt-active" },
      });

      setBusy({});
      orchestrator.syncPendingSkillRegistryReplays();
      await waitFor(() => {
        assert.equal(calls.length, 2);
        assert.deepEqual(orchestrator.pendingSkillRegistryWorkspaceReplays(), {});
      });

      assert.deepEqual(calls[1], {
        kind: "workspace",
        workspaceId: "workspace-1",
        options: {
          denApiBase: "https://den.test",
          denToken: "den-token",
          denOrgId: "org-1",
          denUserId: "user-1",
        },
      });
      assert.equal(refreshes, 1);
      assert.equal(invalidations, 1);
    } finally {
      dispose();
    }
  });
});

test("idle workspace update syncs immediately and refreshes inventory", async () => {
  await createRoot(async (dispose) => {
    try {
      const calls: MaterializationCall[] = [];
      const reloads: unknown[] = [];
      let refreshes = 0;
      let invalidations = 0;
      const listener = createListenerCapture();
      const client = createClient(calls);

      createSkillRegistryOrchestrator({
        vesloServerClient: () => client,
        vesloServerStatus: () => "connected",
        activeWorkspaceId: () => "workspace-1",
        workspaceBusy: () => ({}),
        denAuthRevision: () => 1,
        readDenAuth: denAuth,
        refreshSkills: async () => {
          refreshes += 1;
        },
        invalidateSkillRegistryInventory: async () => {
          invalidations += 1;
        },
        markReloadRequired: (...args) => {
          reloads.push(args);
        },
        reportError: (error) => {
          throw error;
        },
        createListener: listener.createListener,
      });

      await flushEffects();
      await listener.options.onIdleWorkspaceUpdate?.({
        workspaceId: "workspace-2",
        event: registryEvent({ id: "evt-idle", workspaceId: "workspace-2" }),
      });

      assert.deepEqual(calls, [
        {
          kind: "workspace",
          workspaceId: "workspace-2",
          options: {
            denApiBase: "https://den.test",
            denToken: "den-token",
            denOrgId: "org-1",
            denUserId: "user-1",
          },
        },
      ]);
      assert.deepEqual(reloads, []);
      assert.equal(refreshes, 1);
      assert.equal(invalidations, 1);
    } finally {
      dispose();
    }
  });
});

test("global update during active run queues global replay", async () => {
  await createRoot(async (dispose) => {
    try {
      const calls: MaterializationCall[] = [];
      const reloads: unknown[] = [];
      let refreshes = 0;
      let invalidations = 0;
      const listener = createListenerCapture();
      const client = createClient(calls);
      const [busy, setBusy] = createSignal<WorkspaceBusyMap>({
        "workspace-1": { "session-1": { startedAt: 1 } },
      });

      const orchestrator = createSkillRegistryOrchestrator({
        vesloServerClient: () => client,
        vesloServerStatus: () => "connected",
        activeWorkspaceId: () => "workspace-1",
        workspaceBusy: busy,
        denAuthRevision: () => 1,
        readDenAuth: denAuth,
        refreshSkills: async () => {
          refreshes += 1;
        },
        invalidateSkillRegistryInventory: async () => {
          invalidations += 1;
        },
        markReloadRequired: (...args) => {
          reloads.push(args);
        },
        reportError: (error) => {
          throw error;
        },
        createListener: listener.createListener,
      });

      await flushEffects();
      await listener.options.onGlobalUpdate?.({
        event: registryEvent({ id: "evt-global", workspaceId: null, installationId: "install-1" }),
      });

      assert.deepEqual(calls, [
        {
          kind: "global",
          options: {
            denApiBase: "https://den.test",
            denToken: "den-token",
            denOrgId: "org-1",
            denUserId: "user-1",
            activeRun: true,
          },
        },
      ]);
      assert.deepEqual(reloads, [
        ["skills", { type: "skill", action: "updated", name: "planning" }],
      ]);
      assert.deepEqual(orchestrator.pendingGlobalSkillRegistryReplay(), { eventId: "evt-global" });

      setBusy({});
      orchestrator.syncPendingSkillRegistryReplays();
      await waitFor(() => {
        assert.equal(calls.length, 2);
        assert.equal(orchestrator.pendingGlobalSkillRegistryReplay(), null);
      });

      assert.deepEqual(calls[1], {
        kind: "global",
        options: {
          denApiBase: "https://den.test",
          denToken: "den-token",
          denOrgId: "org-1",
          denUserId: "user-1",
        },
      });
      assert.equal(refreshes, 1);
      assert.equal(invalidations, 1);
    } finally {
      dispose();
    }
  });
});

test("event listener key changes when the Veslo client token rotates", () => {
  const base = {
    baseUrl: "http://127.0.0.1:8787",
    orgId: "org-1",
    workspaceId: "workspace-1",
    status: "connected" as const,
  };

  assert.notEqual(
    createSkillRegistryEventsKey({ ...base, token: "server-token-1" }),
    createSkillRegistryEventsKey({ ...base, token: "server-token-2" }),
  );
});

test("event listener key does not expose the raw Veslo client token", () => {
  const key = createSkillRegistryEventsKey({
    baseUrl: "http://127.0.0.1:8787",
    orgId: "org-1",
    token: "server-token-super-secret",
    workspaceId: "workspace-1",
    status: "connected",
  });

  assert.equal(key.includes("server-token-super-secret"), false);
});

test("event listener auth failure stays stopped when reacquire leaves the same server client", async () => {
  await createRoot(async (dispose) => {
    try {
      const calls: MaterializationCall[] = [];
      const errors: Array<{ scope: string; status: number | null }> = [];
      const ensures: unknown[] = [];
      const listener = createListenerCapture();
      const client = createClient(calls);

      createSkillRegistryOrchestrator({
        vesloServerClient: () => client,
        vesloServerStatus: () => "connected",
        activeWorkspaceId: () => "workspace-1",
        workspaceBusy: () => ({}),
        denAuthRevision: () => 1,
        readDenAuth: denAuth,
        refreshSkills: async () => undefined,
        invalidateSkillRegistryInventory: async () => undefined,
        markReloadRequired: () => undefined,
        reportError: (error, scope) => {
          errors.push({
            scope,
            status: error instanceof SkillRegistryEventsAuthError ? error.status : null,
          });
        },
        ensureLocalVesloServerRunning: async (options) => {
          ensures.push(options);
          return true;
        },
        createListener: listener.createListener,
      });

      await flushEffects();
      assert.equal(listener.started, 1);

      await listener.options.onUnauthorized?.(new SkillRegistryEventsAuthError(401));

      assert.equal(listener.stopped, 1);
      assert.deepEqual(errors, [{ scope: "skills.registry.events.auth", status: 401 }]);
      assert.deepEqual(ensures, [{ requireRuntimeChainReady: false }]);
      assert.equal(listener.started, 1);
    } finally {
      dispose();
    }
  });
});

test("event listener auth failure restarts when reacquire rotates the server client token", async () => {
  await createRoot(async (dispose) => {
    try {
      const calls: MaterializationCall[] = [];
      const errors: Array<{ scope: string; status: number | null }> = [];
      const ensures: unknown[] = [];
      const listener = createListenerCapture();
      const [client, setClient] = createSignal(createClient(calls, "server-token-1"));

      createSkillRegistryOrchestrator({
        vesloServerClient: client,
        vesloServerStatus: () => "connected",
        activeWorkspaceId: () => "workspace-1",
        workspaceBusy: () => ({}),
        denAuthRevision: () => 1,
        readDenAuth: denAuth,
        refreshSkills: async () => undefined,
        invalidateSkillRegistryInventory: async () => undefined,
        markReloadRequired: () => undefined,
        reportError: (error, scope) => {
          errors.push({
            scope,
            status: error instanceof SkillRegistryEventsAuthError ? error.status : null,
          });
        },
        ensureLocalVesloServerRunning: async (options) => {
          ensures.push(options);
          setClient(createClient(calls, "server-token-2"));
          return true;
        },
        createListener: listener.createListener,
      });

      await flushEffects();
      assert.equal(listener.started, 1);

      await listener.options.onUnauthorized?.(new SkillRegistryEventsAuthError(401));
      await flushEffects();

      assert.equal(listener.stopped, 1);
      assert.deepEqual(errors, [{ scope: "skills.registry.events.auth", status: 401 }]);
      assert.deepEqual(ensures, [{ requireRuntimeChainReady: false }]);
      assert.equal(listener.started, 2);
    } finally {
      dispose();
    }
  });
});
