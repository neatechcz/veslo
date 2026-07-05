import assert from "node:assert/strict";
import test from "node:test";

import { createRoot, createSignal } from "solid-js";

import {
  createSoulDataStore,
  type SoulDataStoreWorkspace,
} from "../../pages/soul-data-store.js";
import type {
  VesloServerStatus,
  VesloSoulAuthContext,
  VesloSoulOverviewResponse,
} from "../../lib/veslo-server.js";

type SoulClientCall =
  | { kind: "list-workspaces" }
  | { kind: "overview"; auth: VesloSoulAuthContext };

function overview(): VesloSoulOverviewResponse {
  const summary = {
    scope: "user" as const,
    ownerId: "user-1",
    owner: { kind: "user" as const, id: "user-1", label: "User" },
    title: "User Soul",
    currentVersionId: "v1",
    updatedAt: "2026-07-01T12:00:00.000Z",
    updatedBy: "user-1",
    status: "active",
    heartbeatEnabled: false,
    pendingSuggestionCount: 0,
    canEdit: true,
  };
  return {
    organization: {
      ...summary,
      scope: "organization",
      ownerId: "org-1",
      owner: { kind: "organization", id: "org-1", label: "Org" },
      title: "Org Soul",
    },
    user: summary,
    workspaces: [
      {
        ...summary,
        scope: "workspace",
        ownerId: "veslo-remote",
        owner: { kind: "workspace", id: "veslo-remote", label: "Remote" },
        title: "Remote Soul",
      },
    ],
  };
}

function createClient(options: {
  calls: SoulClientCall[];
  failListWorkspaces?: boolean;
  failOverview?: boolean;
}) {
  return {
    baseUrl: "http://127.0.0.1:8787",
    token: "server-token",
    listWorkspaces: async () => {
      options.calls.push({ kind: "list-workspaces" });
      if (options.failListWorkspaces) {
        throw new Error("workspace list failed");
      }
      return {
        items: [
          { id: "veslo-local", path: "/repo/local" },
          { id: "veslo-directory", directory: "/remote/directory" },
        ],
      };
    },
    getSoulOverview: async (auth: VesloSoulAuthContext) => {
      options.calls.push({ kind: "overview", auth });
      if (options.failOverview) {
        throw new Error("overview failed");
      }
      return overview();
    },
  };
}

const authContext: VesloSoulAuthContext = {
  denApiBase: "https://den.test",
  denToken: "den-token",
  denOrgId: "org-1",
  denUserId: "user-1",
};

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolveTick) => setTimeout(resolveTick, 0));
}

test("Soul data store maps app workspaces to current Soul source owners", async () => {
  await createRoot(async (dispose) => {
    try {
      const calls: SoulClientCall[] = [];
      const workspaces: SoulDataStoreWorkspace[] = [
        { id: "local-app", workspaceType: "local", path: "/repo/local" },
        {
          id: "remote-app",
          workspaceType: "remote",
          remoteType: "veslo",
          vesloWorkspaceId: "veslo-remote",
          path: "/ignored",
        },
      ];
      const client = createClient({ calls });
      const store = createSoulDataStore({
        vesloServerClient: () => client as any,
        vesloServerStatus: () => "connected",
        workspaces: () => workspaces,
        activeWorkspaceId: () => "remote-app",
        soulAuthContext: () => authContext,
        effect: () => undefined,
      });

      await store.refreshSoulData({ force: true });
      await flushAsyncWork();

      assert.deepEqual(store.soulWorkspaceMap(), {
        "local-app": "veslo-local",
        "remote-app": "veslo-remote",
      });
      assert.equal(store.soulOverview()?.user.ownerId, "user-1");
      assert.equal(store.soulError(), null);
      assert.deepEqual(calls, [
        { kind: "overview", auth: authContext },
        { kind: "list-workspaces" },
      ]);
    } finally {
      dispose();
    }
  });
});

test("Soul data store falls back to remote directory matching without legacy status calls", async () => {
  await createRoot(async (dispose) => {
    try {
      const calls: SoulClientCall[] = [];
      const workspaces: SoulDataStoreWorkspace[] = [
        { id: "directory-app", workspaceType: "remote", remoteType: "veslo", directory: "/remote/directory" },
      ];
      const client = createClient({ calls });
      const store = createSoulDataStore({
        vesloServerClient: () => client as any,
        vesloServerStatus: () => "connected",
        workspaces: () => workspaces,
        activeWorkspaceId: () => "directory-app",
        soulAuthContext: () => authContext,
        effect: () => undefined,
      });

      await store.refreshSoulData({ force: true });
      await flushAsyncWork();

      assert.deepEqual(store.soulWorkspaceMap(), {
        "directory-app": "veslo-directory",
      });
      assert.deepEqual(calls.map((call) => call.kind), ["overview", "list-workspaces"]);
      assert.equal(store.soulError(), null);
    } finally {
      dispose();
    }
  });
});

test("Soul workspace mapping failures do not block overview refresh", async () => {
  await createRoot(async (dispose) => {
    try {
      const calls: SoulClientCall[] = [];
      const client = createClient({ calls, failListWorkspaces: true });
      const store = createSoulDataStore({
        vesloServerClient: () => client as any,
        vesloServerStatus: () => "connected",
        workspaces: () => [{ id: "local-app", workspaceType: "local", path: "/repo/local" }],
        activeWorkspaceId: () => "local-app",
        soulAuthContext: () => authContext,
        effect: () => undefined,
      });

      await store.refreshSoulData({ force: true });
      await flushAsyncWork();

      assert.equal(store.soulOverview()?.organization.ownerId, "org-1");
      assert.deepEqual(store.soulWorkspaceMap(), {});
      assert.equal(store.soulError(), "workspace list failed");
      assert.deepEqual(calls.map((call) => call.kind), ["overview", "list-workspaces"]);
    } finally {
      dispose();
    }
  });
});

test("Soul data store clears source state while disconnected", async () => {
  await createRoot(async (dispose) => {
    try {
      const calls: SoulClientCall[] = [];
      const client = createClient({ calls });
      const [status, setStatus] = createSignal<VesloServerStatus>("connected");
      const store = createSoulDataStore({
        vesloServerClient: () => client as any,
        vesloServerStatus: status,
        workspaces: () => [{ id: "local-app", workspaceType: "local", path: "/repo/local" }],
        activeWorkspaceId: () => "local-app",
        soulAuthContext: () => authContext,
        effect: () => undefined,
      });

      await store.refreshSoulData({ force: true });
      await flushAsyncWork();
      assert.equal(store.soulOverview()?.user.ownerId, "user-1");

      setStatus("disconnected");
      await store.refreshSoulData({ force: true });

      assert.equal(store.soulOverview(), null);
      assert.equal(store.soulOverviewError(), null);
      assert.equal(store.soulOverviewBusy(), false);
      assert.deepEqual(store.soulWorkspaceMap(), {});
      assert.equal(store.soulError(), null);
    } finally {
      dispose();
    }
  });
});
