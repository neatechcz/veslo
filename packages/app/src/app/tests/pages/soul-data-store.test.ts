import assert from "node:assert/strict";
import test from "node:test";

import { createRoot, createSignal } from "solid-js";

import {
  createSoulDataStore,
  type SoulDataStoreWorkspace,
} from "../../pages/soul-data-store.js";
import type {
  VesloSoulAuthContext,
  VesloSoulHeartbeatEntry,
  VesloSoulOverviewResponse,
  VesloSoulStatus,
} from "../../lib/veslo-server.js";

type SoulClientCall =
  | { kind: "list-workspaces" }
  | { kind: "overview"; auth: VesloSoulAuthContext }
  | { kind: "status"; workspaceId: string }
  | { kind: "heartbeats"; workspaceId: string; limit: number };

function soulStatus(input: Partial<VesloSoulStatus> = {}): VesloSoulStatus {
  return {
    enabled: input.enabled ?? true,
    state: input.state ?? "healthy",
    memoryEnabled: input.memoryEnabled ?? true,
    instructionsEnabled: input.instructionsEnabled ?? true,
    heartbeatLogExists: input.heartbeatLogExists ?? true,
    heartbeatCommandExists: input.heartbeatCommandExists ?? true,
    heartbeatJob: input.heartbeatJob ?? null,
    heartbeatCount: input.heartbeatCount ?? 1,
    lastHeartbeatAt: input.lastHeartbeatAt ?? "2026-07-01T12:00:00.000Z",
    lastHeartbeatSummary: input.lastHeartbeatSummary ?? "Ready",
    staleAfterMs: input.staleAfterMs ?? 86_400_000,
    overdue: input.overdue ?? false,
    summary: input.summary ?? "Soul is healthy",
    memoryPath: input.memoryPath ?? ".opencode/soul.md",
    heartbeatPath: input.heartbeatPath ?? ".opencode/soul/heartbeat.jsonl",
  };
}

function heartbeat(id: string): VesloSoulHeartbeatEntry {
  return {
    id,
    ts: "2026-07-01T12:00:00.000Z",
    workspace: "veslo-remote",
    summary: `Heartbeat ${id}`,
    looseEnds: [],
    nextAction: null,
  };
}

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
  statuses: Record<string, VesloSoulStatus>;
  heartbeats?: Record<string, VesloSoulHeartbeatEntry[]>;
  failStatusIds?: Set<string>;
}) {
  return {
    baseUrl: "http://127.0.0.1:8787",
    token: "server-token",
    listWorkspaces: async () => {
      options.calls.push({ kind: "list-workspaces" });
      return {
        items: [
          { id: "veslo-local", path: "/repo/local" },
          { id: "veslo-directory", directory: "/remote/directory" },
        ],
      };
    },
    getSoulOverview: async (auth: VesloSoulAuthContext) => {
      options.calls.push({ kind: "overview", auth });
      return overview();
    },
    getSoulStatus: async (workspaceId: string) => {
      options.calls.push({ kind: "status", workspaceId });
      if (options.failStatusIds?.has(workspaceId)) {
        throw new Error(`status failed for ${workspaceId}`);
      }
      return options.statuses[workspaceId] ?? soulStatus({ summary: workspaceId });
    },
    listSoulHeartbeats: async (workspaceId: string, limit: number) => {
      options.calls.push({ kind: "heartbeats", workspaceId, limit });
      return { items: options.heartbeats?.[workspaceId] ?? [] };
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

test("Soul data store maps local and explicit remote workspaces before refreshing status and heartbeats", async () => {
  await createRoot(async (dispose) => {
    try {
      const calls: SoulClientCall[] = [];
      const remoteStatus = soulStatus({ summary: "Remote healthy" });
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
      const client = createClient({
        calls,
        statuses: {
          "veslo-local": soulStatus({ summary: "Local healthy" }),
          "veslo-remote": remoteStatus,
        },
        heartbeats: { "veslo-remote": [heartbeat("hb-1")] },
      });
      const store = createSoulDataStore({
        vesloServerClient: () => client as any,
        vesloServerStatus: () => "connected",
        workspaces: () => workspaces,
        activeWorkspaceId: () => "remote-app",
        soulAuthContext: () => authContext,
        createSessionAndOpen: async () => null,
        sendPrompt: async () => {},
        setPrompt: () => {},
        createClientMessageId: () => "client-message",
        effect: () => undefined,
      });

      await store.refreshSoulData({ force: true });
      await flushAsyncWork();

      assert.deepEqual(
        calls.filter((call) => call.kind === "status"),
        [
          { kind: "status", workspaceId: "veslo-local" },
          { kind: "status", workspaceId: "veslo-remote" },
        ],
      );
      assert.deepEqual(
        calls.find((call) => call.kind === "heartbeats"),
        { kind: "heartbeats", workspaceId: "veslo-remote", limit: 30 },
      );
      assert.deepEqual(
        calls.find((call) => call.kind === "overview"),
        { kind: "overview", auth: authContext },
      );
      assert.equal(store.soulStatusByWorkspaceId()["remote-app"], remoteStatus);
      assert.equal(store.activeSoulStatus(), remoteStatus);
      assert.deepEqual(store.activeSoulHeartbeats(), [heartbeat("hb-1")]);
      assert.equal(store.soulError(), null);
      assert.equal(store.soulOverview()?.user.ownerId, "user-1");
    } finally {
      dispose();
    }
  });
});

test("Soul data store falls back to remote directory matching and reports partial status failures", async () => {
  await createRoot(async (dispose) => {
    try {
      const calls: SoulClientCall[] = [];
      const workspaces: SoulDataStoreWorkspace[] = [
        { id: "directory-app", workspaceType: "remote", remoteType: "veslo", directory: "/remote/directory" },
        { id: "missing-app", workspaceType: "remote", remoteType: "veslo", vesloWorkspaceId: "veslo-missing" },
      ];
      const client = createClient({
        calls,
        statuses: { "veslo-directory": soulStatus({ summary: "Directory healthy" }) },
        heartbeats: { "veslo-directory": [heartbeat("hb-directory")] },
        failStatusIds: new Set(["veslo-missing"]),
      });
      const store = createSoulDataStore({
        vesloServerClient: () => client as any,
        vesloServerStatus: () => "connected",
        workspaces: () => workspaces,
        activeWorkspaceId: () => "directory-app",
        soulAuthContext: () => authContext,
        createSessionAndOpen: async () => null,
        sendPrompt: async () => {},
        setPrompt: () => {},
        createClientMessageId: () => "client-message",
        effect: () => undefined,
      });

      await store.refreshSoulData({ force: true });
      await flushAsyncWork();

      assert.deepEqual(store.soulStatusByWorkspaceId()["missing-app"], null);
      assert.equal(store.soulStatusByWorkspaceId()["directory-app"]?.summary, "Directory healthy");
      assert.deepEqual(store.activeSoulHeartbeats(), [heartbeat("hb-directory")]);
      assert.equal(store.soulError(), "Soul status is partially unavailable.");
      assert.deepEqual(
        calls.filter((call) => call.kind === "status"),
        [
          { kind: "status", workspaceId: "veslo-directory" },
          { kind: "status", workspaceId: "veslo-missing" },
        ],
      );
    } finally {
      dispose();
    }
  });
});

test("Soul prompt runner dispatches through a created session and stores fallback text when creation fails", async () => {
  await createRoot(async (dispose) => {
    try {
      const sent: unknown[] = [];
      const fallbackPrompts: string[] = [];
      const [nextSessionId, setNextSessionId] = createSignal<string | null>("session-1");
      const store = createSoulDataStore({
        vesloServerClient: () => null,
        vesloServerStatus: () => "disconnected",
        workspaces: () => [],
        activeWorkspaceId: () => "",
        soulAuthContext: () => authContext,
        createSessionAndOpen: async () => nextSessionId(),
        sendPrompt: async (payload, options) => {
          sent.push({ payload, options });
        },
        setPrompt: (value) => {
          fallbackPrompts.push(value);
        },
        createClientMessageId: () => "client-message-1",
        effect: () => undefined,
      });

      store.runSoulPrompt("  remember the deployment checklist  ");
      await flushAsyncWork();

      assert.deepEqual(sent, [
        {
          payload: {
            mode: "prompt",
            text: "remember the deployment checklist",
            resolvedText: "remember the deployment checklist",
            parts: [{ type: "text", text: "remember the deployment checklist" }],
            attachments: [],
          },
          options: {
            targetSessionId: "session-1",
            clientMessageId: "client-message-1",
            origin: "app:soul-prompt",
          },
        },
      ]);

      setNextSessionId(null);
      store.runSoulPrompt(" fallback text ");
      store.runSoulPrompt("   ");
      await flushAsyncWork();

      assert.deepEqual(fallbackPrompts, ["fallback text"]);
      assert.equal(sent.length, 1);
    } finally {
      dispose();
    }
  });
});
