import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { createConversationBindingStore } from "../conversation-binding-store.js";
import type { ConversationReadStore } from "../conversation-read-store.js";
import { createConversationTranscriptStore } from "../conversation-transcript-store.js";
import { createConversationService } from "../conversation-service.js";
import { ApiError } from "../errors.js";
import type { WorkspaceInfo } from "../types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

const workspaceFor = (path: string): WorkspaceInfo => ({
  id: "ws-a",
  name: "Workspace A",
  path,
  workspaceType: "local",
  baseUrl: "http://127.0.0.1:1234",
});

const fakeReadStore = (directory: string): ConversationReadStore => ({
  async listConversations(input) {
    return {
      workspaceId: input.workspaceId,
      source: "sqlite",
      items: [
        {
          id: "sess-parent",
          title: "Parent",
          slug: "Parent",
          directory,
          parentID: null,
          time: { created: 10, updated: 30 },
        },
        {
          id: "sess-child",
          title: "Child",
          slug: "Child",
          directory,
          parentID: "sess-parent",
          time: { created: 20, updated: 40 },
        },
      ],
    };
  },

  async getTranscript(input) {
    return {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      limit: input.limit,
      messages: [],
      partsByMessageId: {},
      fetchedAt: 100,
      source: "sqlite",
    };
  },
});

const unavailableReadStore: ConversationReadStore = {
  async listConversations(input) {
    return {
      workspaceId: input.workspaceId,
      source: "unavailable",
      items: [],
    };
  },

  async getTranscript(input) {
    return {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      limit: input.limit,
      messages: [],
      partsByMessageId: {},
      fetchedAt: 100,
      source: "unavailable",
    };
  },
};

describe("conversation service", () => {
  test("attaches Veslo conversation bindings to passive OpenCode sessions", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-service-"));
    tempDirs.push(dataDir);
    const directory = join(dataDir, "workspace-a");
    const bindingStore = createConversationBindingStore({ dataDir, now: () => 1_000 });
    const service = createConversationService({
      readStore: fakeReadStore(directory),
      bindingStore,
      createOpenCodeSession: async () => ({ id: "unused" }),
    });

    const result = await service.listConversations({
      workspace: workspaceFor(directory),
      directory,
    });

    expect(result.source).toBe("sqlite");
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.conversationId).toMatch(/^conv-/);
    expect(result.items[0]?.opencodeSessionId).toBe("sess-parent");
    expect(result.items[1]?.parentConversationId).toBe(result.items[0]?.conversationId);

    const resolved = await bindingStore.resolveOpenCodeSession({
      workspaceId: "ws-a",
      directory,
      sessionOrConversationId: result.items[1]?.conversationId ?? "",
    });
    expect(resolved?.engineSessionId).toBe("sess-child");
  });

  test("serves owned bindings host-only when the sandbox read is unavailable", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-service-bindings-"));
    tempDirs.push(dataDir);
    const directory = join(dataDir, "workspace-a");
    const bindingStore = createConversationBindingStore({ dataDir, now: () => 3_000 });
    await bindingStore.bindOpenCodeSession({
      workspaceId: "ws-a",
      directory,
      engineSessionId: "sess-created",
      title: "Created",
      createdAt: 111,
      updatedAt: 222,
    });
    const service = createConversationService({
      readStore: unavailableReadStore,
      bindingStore,
      createOpenCodeSession: async () => ({ id: "unused" }),
    });

    const result = await service.listConversations({
      workspace: workspaceFor(directory),
      directory,
    });

    // Host has rows -> served host-only (source reflects the successful host
    // read, never the sandbox), without consulting the sandbox at all.
    expect(result.source).toBe("sqlite");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe("sess-created");
    expect(result.items[0]?.opencodeSessionId).toBe("sess-created");
    expect(result.items[0]?.conversationId).toMatch(/^conv-/);
    expect(result.items[0]?.title).toBe("Created");
  });

  test("reports unavailable when host store is empty and source read is unavailable", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-service-source-unavailable-"));
    tempDirs.push(dataDir);
    const directory = join(dataDir, "workspace-a");
    const bindingStore = createConversationBindingStore({ dataDir, now: () => 3_000 });
    const service = createConversationService({
      readStore: unavailableReadStore,
      bindingStore,
      createOpenCodeSession: async () => ({ id: "unused" }),
    });

    const result = await service.listConversations({
      workspace: workspaceFor(directory),
      directory,
    });
    const transcript = await service.loadTranscript({
      workspace: workspaceFor(directory),
      sessionId: "sess-missing",
      limit: 10,
      directory,
    });

    expect(result).toEqual({
      workspaceId: "ws-a",
      items: [],
      source: "unavailable",
    });
    expect(transcript.source).toBe("unavailable");
    expect(transcript.messages).toEqual([]);
  });

  test("falls back to persisted bindings when OpenCode sqlite has no matching sessions", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-service-empty-sqlite-"));
    tempDirs.push(dataDir);
    const directory = join(dataDir, "workspace-a");
    const bindingStore = createConversationBindingStore({ dataDir, now: () => 3_000 });
    await bindingStore.bindOpenCodeSession({
      workspaceId: "ws-a",
      directory,
      engineSessionId: "sess-created",
      title: "Created",
      createdAt: 111,
      updatedAt: 222,
    });
    const service = createConversationService({
      readStore: {
        ...unavailableReadStore,
        async listConversations(input) {
          return {
            workspaceId: input.workspaceId,
            source: "sqlite",
            items: [],
          };
        },
      },
      bindingStore,
      createOpenCodeSession: async () => ({ id: "unused" }),
    });

    const result = await service.listConversations({
      workspace: workspaceFor(directory),
      directory,
    });

    expect(result.source).toBe("sqlite");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe("sess-created");
    expect(result.items[0]?.conversationId).toMatch(/^conv-/);
  });

  test("serves owned bindings host-only without reaching into the sandbox", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-service-host-first-"));
    tempDirs.push(dataDir);
    const directory = join(dataDir, "workspace-a");
    const bindingStore = createConversationBindingStore({ dataDir, now: () => 5_000 });
    await bindingStore.bindOpenCodeSession({
      workspaceId: "ws-a",
      directory,
      engineSessionId: "sess-owned",
      title: "Owned",
      createdAt: 1,
      updatedAt: 2,
    });
    // Host already has rows -> the sandbox reader must NOT be touched. We fail
    // loudly if it is, to guard against passive listing reaching into WSL.
    let sandboxReadCount = 0;
    const service = createConversationService({
      readStore: {
        ...unavailableReadStore,
        async listConversations(input) {
          sandboxReadCount += 1;
          throw new Error("sandbox read must not be called when host store has rows");
        },
      },
      bindingStore,
      createOpenCodeSession: async () => ({ id: "unused" }),
    });

    const result = await service.listConversations({
      workspace: workspaceFor(directory),
      directory,
    });

    expect(sandboxReadCount).toBe(0);
    expect(result.source).toBe("sqlite");
    expect(result.items.map((item) => item.id)).toEqual(["sess-owned"]);
  });

  test("explicit sync unions active-source sessions with owned host bindings", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-service-sync-gaps-"));
    tempDirs.push(dataDir);
    const directory = join(dataDir, "workspace-a");
    const bindingStore = createConversationBindingStore({ dataDir, now: () => 5_000 });
    await bindingStore.bindOpenCodeSession({
      workspaceId: "ws-a",
      directory,
      engineSessionId: "sess-owned",
      title: "Owned",
      createdAt: 1,
      updatedAt: 2,
    });
    let sandboxReadCount = 0;
    const service = createConversationService({
      readStore: {
        ...unavailableReadStore,
        async listConversations(input) {
          sandboxReadCount += 1;
          return {
            workspaceId: input.workspaceId,
            source: "sqlite",
            items: [
              {
                id: "sess-new",
                title: "New from engine",
                slug: "New from engine",
                directory,
                parentID: null,
                time: { created: 10, updated: 40 },
              },
            ],
          };
        },
      },
      bindingStore,
      createOpenCodeSession: async () => ({ id: "unused" }),
    });

    const synced = await service.listConversations({
      workspace: workspaceFor(directory),
      directory,
      sync: true,
    });

    expect(sandboxReadCount).toBe(1);
    expect(synced.source).toBe("sqlite");
    expect(synced.items.map((item) => item.id)).toEqual(["sess-new", "sess-owned"]);
    expect(synced.items[0]?.conversationId).toMatch(/^conv-/);

    const hostOnly = await service.listConversations({
      workspace: workspaceFor(directory),
      directory,
    });
    expect(hostOnly.items.map((item) => item.id)).toEqual(["sess-new", "sess-owned"]);
  });

  test("seeds the host store from the sandbox only when the host is empty", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-service-seed-"));
    tempDirs.push(dataDir);
    const directory = join(dataDir, "workspace-a");
    const bindingStore = createConversationBindingStore({ dataDir, now: () => 6_000 });
    let sandboxReadCount = 0;
    const service = createConversationService({
      readStore: {
        ...unavailableReadStore,
        async listConversations(input) {
          sandboxReadCount += 1;
          return {
            workspaceId: input.workspaceId,
            source: "sqlite",
            items: [
              {
                id: "sess-parent",
                title: "Parent",
                slug: "Parent",
                directory,
                parentID: null,
                time: { created: 10, updated: 30 },
              },
            ],
          };
        },
      },
      bindingStore,
      createOpenCodeSession: async () => ({ id: "unused" }),
    });

    // First list: host empty -> sandbox read seeds the host store.
    const first = await service.listConversations({
      workspace: workspaceFor(directory),
      directory,
    });
    expect(sandboxReadCount).toBe(1);
    expect(first.items.map((item) => item.id)).toEqual(["sess-parent"]);
    expect(first.items[0]?.conversationId).toMatch(/^conv-/);

    // Second list: host now populated -> served host-only, sandbox untouched.
    const second = await service.listConversations({
      workspace: workspaceFor(directory),
      directory,
    });
    expect(sandboxReadCount).toBe(1);
    expect(second.items.map((item) => item.id)).toEqual(["sess-parent"]);
  });

  test("imports live OpenCode sessions into persisted conversation bindings", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-service-import-"));
    tempDirs.push(dataDir);
    const directory = join(dataDir, "workspace-a");
    const bindingStore = createConversationBindingStore({ dataDir, now: () => 3_000 });
    const service = createConversationService({
      readStore: unavailableReadStore,
      bindingStore,
      createOpenCodeSession: async () => ({ id: "unused" }),
    });

    const imported = await service.importOpenCodeSessions({
      workspace: workspaceFor(directory),
      directory,
      sessions: [
        {
          id: "sess-parent",
          title: "Parent",
          parentID: null,
          time: { created: 100, updated: 200 },
        },
        {
          id: "sess-child",
          title: "Child",
          parentID: "sess-parent",
          time: { created: 150, updated: 250 },
        },
      ],
    });

    expect(imported.items).toHaveLength(2);
    expect(imported.items[0]?.conversationId).toMatch(/^conv-/);
    expect(imported.items[1]?.parentConversationId).toBe(imported.items[0]?.conversationId);

    const listed = await service.listConversations({
      workspace: workspaceFor(directory),
      directory,
    });
    expect(listed.items.map((item) => item.id)).toEqual(["sess-child", "sess-parent"]);
  });

  test("resolveOpenCodeSessionForRead imports an exact legacy OpenCode session from source rows", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-service-resolve-import-"));
    tempDirs.push(dataDir);
    const directory = join(dataDir, "workspace-a");
    const bindingStore = createConversationBindingStore({ dataDir, now: () => 4_000 });
    let sourceListReads = 0;
    const service = createConversationService({
      readStore: {
        ...unavailableReadStore,
        async listConversations(input) {
          sourceListReads += 1;
          return {
            workspaceId: input.workspaceId,
            source: "sqlite",
            items: [{
              id: "sess-legacy",
              title: "Legacy",
              slug: "Legacy",
              directory,
              parentID: null,
              time: { created: 100, updated: 200 },
            }],
          };
        },
      },
      bindingStore,
      createOpenCodeSession: async () => ({ id: "unused" }),
    });

    const binding = await service.resolveOpenCodeSessionForRead({
      workspaceId: "ws-a",
      workspace: workspaceFor(directory),
      directory,
      sessionOrConversationId: "sess-legacy",
    });

    expect(sourceListReads).toBe(1);
    expect(binding?.engineSessionId).toBe("sess-legacy");
    expect(binding?.conversationId).toMatch(/^conv-/);

    const persisted = await bindingStore.resolveOpenCodeSession({
      workspaceId: "ws-a",
      directory,
      sessionOrConversationId: binding?.conversationId ?? "",
    });
    expect(persisted?.engineSessionId).toBe("sess-legacy");
  });

  test("loadTranscript returns Veslo identity after importing a legacy raw session", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-service-transcript-import-"));
    tempDirs.push(dataDir);
    const directory = join(dataDir, "workspace-a");
    const bindingStore = createConversationBindingStore({ dataDir, now: () => 4_000 });
    const transcriptStore = createConversationTranscriptStore({ dataDir, now: () => 5_000 });
    const readStore: ConversationReadStore = {
      async listConversations(input) {
        return {
          workspaceId: input.workspaceId,
          source: "sqlite",
          items: [{
            id: "sess-legacy-read",
            title: "Legacy Read",
            slug: "Legacy Read",
            directory,
            parentID: null,
            time: { created: 100, updated: 200 },
          }],
        };
      },
      async getTranscript(input) {
        return {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          limit: input.limit,
          messages: [{ id: "msg-legacy", role: "assistant", time: { created: 10 } }],
          partsByMessageId: {
            "msg-legacy": [{ id: "prt-legacy", type: "text", text: "legacy" }],
          },
          fetchedAt: 100,
          source: "sqlite",
          complete: input.readMode === "complete",
        };
      },
    };
    const service = createConversationService({
      readStore,
      bindingStore,
      transcriptStore,
      createOpenCodeSession: async () => ({ id: "unused" }),
    });

    const snapshot = await service.loadTranscript({
      workspace: workspaceFor(directory),
      sessionId: "sess-legacy-read",
      limit: 10,
      directory,
    });

    expect(snapshot.sessionId).toBe("sess-legacy-read");
    expect(snapshot.opencodeSessionId).toBe("sess-legacy-read");
    expect(snapshot.conversationId).toMatch(/^conv-/);
    expect(snapshot.messages.map((m) => (m as { id: string }).id)).toEqual(["msg-legacy"]);

    const resolved = await bindingStore.resolveOpenCodeSession({
      workspaceId: "ws-a",
      directory,
      sessionOrConversationId: snapshot.conversationId ?? "",
    });
    expect(resolved?.engineSessionId).toBe("sess-legacy-read");
  });

  test("loadTranscript fails closed when binding resolution throws", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-service-binding-failure-"));
    tempDirs.push(dataDir);
    const directory = join(dataDir, "workspace-a");
    const bindingStore = createConversationBindingStore({ dataDir, now: () => 4_000 });
    let sandboxTranscriptReads = 0;
    const service = createConversationService({
      readStore: {
        ...fakeReadStore(directory),
        async getTranscript(input) {
          sandboxTranscriptReads += 1;
          return {
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            limit: input.limit,
            messages: [],
            partsByMessageId: {},
            fetchedAt: 100,
            source: "sqlite",
          };
        },
      },
      bindingStore: {
        ...bindingStore,
        async resolveOpenCodeSession() {
          throw new Error("binding db unavailable");
        },
      },
      transcriptStore: createConversationTranscriptStore({ dataDir, now: () => 5_000 }),
      createOpenCodeSession: async () => ({ id: "unused" }),
    });

    let error: unknown;
    try {
      await service.loadTranscript({
        workspace: workspaceFor(directory),
        sessionId: "sess-raw",
        limit: 10,
        directory,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(503);
    expect((error as ApiError).code).toBe("conversation_binding_unavailable");
    expect(sandboxTranscriptReads).toBe(0);
  });

  test("loadTranscript rejects missing Veslo conversation bindings without raw fallback", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-service-missing-conv-"));
    tempDirs.push(dataDir);
    const directory = join(dataDir, "workspace-a");
    const bindingStore = createConversationBindingStore({ dataDir, now: () => 4_000 });
    let sourceListReads = 0;
    let sandboxTranscriptReads = 0;
    const service = createConversationService({
      readStore: {
        ...fakeReadStore(directory),
        async listConversations(input) {
          sourceListReads += 1;
          return fakeReadStore(directory).listConversations(input);
        },
        async getTranscript(input) {
          sandboxTranscriptReads += 1;
          return {
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            limit: input.limit,
            messages: [],
            partsByMessageId: {},
            fetchedAt: 100,
            source: "sqlite",
          };
        },
      },
      bindingStore,
      transcriptStore: createConversationTranscriptStore({ dataDir, now: () => 5_000 }),
      createOpenCodeSession: async () => ({ id: "unused" }),
    });

    let error: unknown;
    try {
      await service.loadTranscript({
        workspace: workspaceFor(directory),
        sessionId: "conv-0123456789abcdef0123",
        limit: 10,
        directory,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).code).toBe("conversation_not_found");
    expect(sourceListReads).toBe(0);
    expect(sandboxTranscriptReads).toBe(0);
  });

  test("appendTranscript imports a legacy raw session before persisting the host snapshot", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-service-append-import-"));
    tempDirs.push(dataDir);
    const directory = join(dataDir, "workspace-a");
    const bindingStore = createConversationBindingStore({ dataDir, now: () => 4_000 });
    const transcriptStore = createConversationTranscriptStore({ dataDir, now: () => 5_000 });
    const service = createConversationService({
      readStore: {
        ...unavailableReadStore,
        async listConversations(input) {
          return {
            workspaceId: input.workspaceId,
            source: "sqlite",
            items: [{
              id: "sess-legacy-live",
              title: "Legacy Live",
              slug: "Legacy Live",
              directory,
              parentID: null,
              time: { created: 100, updated: 200 },
            }],
          };
        },
      },
      bindingStore,
      transcriptStore,
      createOpenCodeSession: async () => ({ id: "unused" }),
      now: () => 6_000,
    });

    const appended = await service.appendTranscript({
      workspace: workspaceFor(directory),
      sessionId: "sess-legacy-live",
      directory,
      limit: 10,
      messages: [{ id: "msg-live", sessionID: "sess-legacy-live", role: "assistant" }],
      partsByMessageId: {
        "msg-live": [{ id: "prt-live", type: "text", text: "live" }],
      },
    });

    expect(appended.sessionId).toBe("sess-legacy-live");
    expect(appended.conversationId).toMatch(/^conv-/);
    expect(appended.opencodeSessionId).toBe("sess-legacy-live");

    const loaded = await service.loadTranscript({
      workspace: workspaceFor(directory),
      sessionId: appended.conversationId ?? "",
      limit: 10,
      directory,
    });
    expect(loaded.messages.map((m) => (m as { id: string }).id)).toEqual(["msg-live"]);
  });

  test("loadTranscript is host-first: seeds host from sandbox once, then serves host-only", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-service-transcript-"));
    tempDirs.push(dataDir);
    const directory = join(dataDir, "workspace-a");
    const bindingStore = createConversationBindingStore({ dataDir, now: () => 1_000 });
    const transcriptStore = createConversationTranscriptStore({ dataDir, now: () => 1_000 });

    let sandboxTranscriptReads = 0;
    const readStore: ConversationReadStore = {
      async listConversations(input) {
        return { workspaceId: input.workspaceId, source: "unavailable", items: [] };
      },
      async getTranscript(input) {
        sandboxTranscriptReads += 1;
        return {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          limit: input.limit,
          messages: [
            { id: "msg-1", role: "user", time: { created: 10 } },
            { id: "msg-2", role: "assistant", time: { created: 20 } },
          ],
          partsByMessageId: {
            "msg-1": [{ id: "prt-1", type: "text" }],
            "msg-2": [{ id: "prt-2", type: "text" }],
          },
          fetchedAt: 100,
          source: "sqlite",
          complete: input.readMode === "complete",
        };
      },
    };

    const service = createConversationService({
      readStore,
      bindingStore,
      transcriptStore,
      createOpenCodeSession: async () => ({ id: "unused" }),
    });

    const first = await service.loadTranscript({
      workspace: workspaceFor(directory),
      sessionId: "ses-1",
      limit: 140,
      directory,
    });
    expect(sandboxTranscriptReads).toBe(1);
    expect(first.source).toBe("sqlite");
    expect(first.messages.map((m) => (m as { id: string }).id)).toEqual(["msg-1", "msg-2"]);

    // Second read is served from the host store — the sandbox is not touched.
    const second = await service.loadTranscript({
      workspace: workspaceFor(directory),
      sessionId: "ses-1",
      limit: 140,
      directory,
    });
    expect(sandboxTranscriptReads).toBe(1);
    expect(second.source).toBe("sqlite");
    expect(second.messages.map((m) => (m as { id: string }).id)).toEqual(["msg-1", "msg-2"]);
    expect((second.partsByMessageId["msg-1"]?.[0] as { id: string }).id).toBe("prt-1");

    const canonical = await service.readCanonicalTranscript({
      workspace: workspaceFor(directory),
      sessionId: "ses-1",
      directory,
    });
    expect(sandboxTranscriptReads).toBe(2);
    expect(canonical.complete).toBe(true);
    expect(canonical.messages.map((m) => (m as { id: string }).id)).toEqual(["msg-1", "msg-2"]);

    await service.persistCanonicalTranscript({
      workspace: workspaceFor(directory),
      directory,
      opencodeSessionId: "ses-1",
      messages: [{ id: "msg-1", role: "assistant", time: { created: 10, updated: 30 } }],
      partsByMessageId: { "msg-1": [{ id: "prt-1", type: "text", text: "final" }] },
    });
    const reconciled = await transcriptStore.getTranscript({
      workspaceId: "ws-a",
      directory,
      engineSessionId: "ses-1",
    });
    expect(reconciled?.messages.map((message) => (message as { id: string }).id)).toEqual(["msg-1"]);
    expect((reconciled?.partsByMessageId["msg-1"]?.[0] as { text: string }).text).toBe("final");
  });

  test("appendTranscript persists live SSE snapshots into the host transcript store", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-service-live-transcript-"));
    tempDirs.push(dataDir);
    const directory = join(dataDir, "workspace-a");
    const bindingStore = createConversationBindingStore({ dataDir, now: () => 1_000 });
    const transcriptStore = createConversationTranscriptStore({ dataDir, now: () => 2_000 });
    const binding = await bindingStore.bindOpenCodeSession({
      workspaceId: "ws-a",
      directory,
      engineSessionId: "ses-live",
      title: "Live",
      createdAt: 10,
      updatedAt: 20,
    });

    let sandboxTranscriptReads = 0;
    const service = createConversationService({
      readStore: {
        ...unavailableReadStore,
        async getTranscript(input) {
          sandboxTranscriptReads += 1;
          return {
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            limit: input.limit,
            messages: [],
            partsByMessageId: {},
            fetchedAt: 100,
            source: "unavailable",
          };
        },
      },
      bindingStore,
      transcriptStore,
      createOpenCodeSession: async () => ({ id: "unused" }),
      now: () => 3_000,
    });

    const appended = await service.appendTranscript({
      workspace: workspaceFor(directory),
      sessionId: binding.conversationId,
      directory,
      limit: 10,
      messages: [
        { id: "msg-1", sessionID: "ses-live", role: "user", time: { created: 11 } },
        { id: "msg-2", sessionID: "ses-live", role: "assistant", time: { created: 12 } },
      ],
      partsByMessageId: {
        "msg-2": [{ id: "prt-2", type: "text", text: "hello" }],
      },
    });

    expect(appended.sessionId).toBe("ses-live");
    expect(appended.conversationId).toBe(binding.conversationId);
    expect(appended.messages.map((m) => (m as { id: string }).id)).toEqual(["msg-1", "msg-2"]);

    const loaded = await service.loadTranscript({
      workspace: workspaceFor(directory),
      sessionId: binding.conversationId,
      limit: 10,
      directory,
    });

    expect(sandboxTranscriptReads).toBe(0);
    expect(loaded.sessionId).toBe("ses-live");
    expect(loaded.messages.map((m) => (m as { id: string }).id)).toEqual(["msg-1", "msg-2"]);
    expect((loaded.partsByMessageId["msg-2"]?.[0] as { text: string }).text).toBe("hello");
  });

  test("host transcript snapshots stay scoped when engine session ids repeat across directories", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-service-transcript-scope-"));
    tempDirs.push(dataDir);
    const directoryA = join(dataDir, "workspace-a");
    const directoryB = join(dataDir, "workspace-b");
    const bindingStore = createConversationBindingStore({ dataDir, now: () => 1_000 });
    const transcriptStore = createConversationTranscriptStore({ dataDir, now: () => 2_000 });
    const bindingA = await bindingStore.bindOpenCodeSession({
      workspaceId: "ws-a",
      directory: directoryA,
      engineSessionId: "ses-repeat",
      title: "A",
      createdAt: 10,
      updatedAt: 20,
    });
    const bindingB = await bindingStore.bindOpenCodeSession({
      workspaceId: "ws-a",
      directory: directoryB,
      engineSessionId: "ses-repeat",
      title: "B",
      createdAt: 30,
      updatedAt: 40,
    });
    const service = createConversationService({
      readStore: unavailableReadStore,
      bindingStore,
      transcriptStore,
      createOpenCodeSession: async () => ({ id: "unused" }),
      now: () => 3_000,
    });

    await service.appendTranscript({
      workspace: workspaceFor(directoryA),
      sessionId: bindingA.conversationId,
      directory: directoryA,
      messages: [{ id: "msg-a", sessionID: "ses-repeat", role: "assistant" }],
      partsByMessageId: {},
    });
    await service.appendTranscript({
      workspace: workspaceFor(directoryB),
      sessionId: bindingB.conversationId,
      directory: directoryB,
      messages: [{ id: "msg-b", sessionID: "ses-repeat", role: "assistant" }],
      partsByMessageId: {},
    });

    const loadedA = await service.loadTranscript({
      workspace: workspaceFor(directoryA),
      sessionId: bindingA.conversationId,
      limit: 10,
      directory: directoryA,
    });
    const loadedB = await service.loadTranscript({
      workspace: workspaceFor(directoryB),
      sessionId: bindingB.conversationId,
      limit: 10,
      directory: directoryB,
    });

    expect(loadedA.conversationId).toBe(bindingA.conversationId);
    expect(loadedB.conversationId).toBe(bindingB.conversationId);
    expect(loadedA.messages.map((m) => (m as { id: string }).id)).toEqual(["msg-a"]);
    expect(loadedB.messages.map((m) => (m as { id: string }).id)).toEqual(["msg-b"]);
  });

  test("appendTranscript rejects unproven raw OpenCode session ids", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-service-legacy-append-reject-"));
    tempDirs.push(dataDir);
    const directory = join(dataDir, "workspace-a");
    const bindingStore = createConversationBindingStore({ dataDir, now: () => 7_000 });
    const transcriptStore = createConversationTranscriptStore({ dataDir, now: () => 8_000 });
    const service = createConversationService({
      readStore: unavailableReadStore,
      bindingStore,
      transcriptStore,
      createOpenCodeSession: async () => ({ id: "unused" }),
    });

    let error: unknown;
    try {
      await service.appendTranscript({
        workspace: workspaceFor(directory),
        sessionId: "ses-unknown",
        directory,
        messages: [{ id: "msg-unknown", sessionID: "ses-unknown", role: "assistant" }],
        partsByMessageId: {},
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).code).toBe("conversation_not_found");
  });

  test("appendTranscript persists an empty host transcript marker", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-service-empty-transcript-"));
    tempDirs.push(dataDir);
    const directory = join(dataDir, "workspace-a");
    const bindingStore = createConversationBindingStore({ dataDir, now: () => 1_000 });
    const transcriptStore = createConversationTranscriptStore({ dataDir, now: () => 2_000 });
    const binding = await bindingStore.bindOpenCodeSession({
      workspaceId: "ws-a",
      directory,
      engineSessionId: "ses-empty",
      title: "Empty",
      createdAt: 10,
      updatedAt: 20,
    });

    let sandboxTranscriptReads = 0;
    const service = createConversationService({
      readStore: {
        ...unavailableReadStore,
        async getTranscript(input) {
          sandboxTranscriptReads += 1;
          return {
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            limit: input.limit,
            messages: [],
            partsByMessageId: {},
            fetchedAt: 100,
            source: "unavailable",
          };
        },
      },
      bindingStore,
      transcriptStore,
      createOpenCodeSession: async () => ({ id: "unused" }),
      now: () => 3_000,
    });

    const appended = await service.appendTranscript({
      workspace: workspaceFor(directory),
      sessionId: binding.conversationId,
      directory,
      limit: 10,
      messages: [],
      partsByMessageId: {},
    });

    expect(appended.sessionId).toBe("ses-empty");
    expect(appended.conversationId).toBe(binding.conversationId);
    expect(appended.source).toBe("sqlite");
    expect(appended.messages).toEqual([]);

    const loaded = await service.loadTranscript({
      workspace: workspaceFor(directory),
      sessionId: binding.conversationId,
      limit: 10,
      directory,
    });

    expect(sandboxTranscriptReads).toBe(0);
    expect(loaded.source).toBe("sqlite");
    expect(loaded.sessionId).toBe("ses-empty");
    expect(loaded.messages).toEqual([]);
    expect(loaded.partsByMessageId).toEqual({});
  });

  test("loadTranscript falls back to the sandbox when no transcript store is configured", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-service-no-transcript-"));
    tempDirs.push(dataDir);
    const directory = join(dataDir, "workspace-a");
    const bindingStore = createConversationBindingStore({ dataDir, now: () => 1_000 });
    const service = createConversationService({
      readStore: fakeReadStore(directory),
      bindingStore,
      createOpenCodeSession: async () => ({ id: "unused" }),
    });

    const result = await service.loadTranscript({
      workspace: workspaceFor(directory),
      sessionId: "ses-1",
      limit: 140,
      directory,
    });
    expect(result.source).toBe("sqlite");
    expect(result.messages).toEqual([]);
  });

  test("loads an existing conversation id through its persisted engine session binding", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-service-bound-resume-"));
    tempDirs.push(dataDir);
    const directory = join(dataDir, "workspace-a");
    const bindingStore = createConversationBindingStore({ dataDir, now: () => 2_000 });
    const binding = await bindingStore.bindOpenCodeSession({
      workspaceId: "ws-a",
      directory,
      engineSessionId: "sess-old-engine",
      title: "Old conversation",
      createdAt: 1_000,
      updatedAt: 1_500,
    });
    const transcriptReads: string[] = [];
    const service = createConversationService({
      readStore: {
        ...fakeReadStore(directory),
        async getTranscript(input) {
          transcriptReads.push(input.sessionId);
          return {
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            limit: input.limit,
            messages: [{ id: "msg-old", role: "assistant" }],
            partsByMessageId: {},
            fetchedAt: 1_700,
            source: "sqlite",
          };
        },
      },
      bindingStore,
      createOpenCodeSession: async () => {
        throw new Error("createOpenCodeSession should not be called for existing conversation ids");
      },
    });

    const result = await service.loadTranscript({
      workspace: workspaceFor(directory),
      sessionId: binding.conversationId,
      limit: 140,
      directory,
    });

    expect(transcriptReads).toEqual(["sess-old-engine"]);
    expect(result.sessionId).toBe("sess-old-engine");
    expect(result.opencodeSessionId).toBe("sess-old-engine");
    expect(result.conversationId).toBe(binding.conversationId);
    expect((result.messages as Array<{ id: string }>).map((message) => message.id)).toEqual(["msg-old"]);
  });

  test("creates an OpenCode session and persists the binding before returning", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-service-create-"));
    tempDirs.push(dataDir);
    const directory = join(dataDir, "workspace-a");
    const bindingStore = createConversationBindingStore({ dataDir, now: () => 2_000 });
    const createInputs: Array<{
      directory: string | null;
      title?: string | null;
      requestedOpenCodeSessionId?: string | null;
    }> = [];
    const service = createConversationService({
      readStore: fakeReadStore(directory),
      bindingStore,
      createOpenCodeSession: async (input) => {
        createInputs.push({
          directory: input.directory,
          title: input.title,
          requestedOpenCodeSessionId: input.requestedOpenCodeSessionId,
        });
        return {
          id: "sess-created",
          title: input.title,
          directory: input.directory,
          time: { created: 111, updated: 222 },
        };
      },
    });

    const result = await service.createConversation({
      workspace: workspaceFor(directory),
      directory,
      title: "Created",
      requestedOpenCodeSessionId: "ses_veslo_v1_requested",
    });

    expect(createInputs[0]?.directory).toBe(directory);
    expect(createInputs[0]?.title).toBe("Created");
    expect(createInputs[0]?.requestedOpenCodeSessionId).toBe("ses_veslo_v1_requested");
    expect(result.id).toBe("sess-created");
    expect(result.opencodeSessionId).toBe("sess-created");
    expect(result.conversationId).toMatch(/^conv-/);

    const resolved = await bindingStore.resolveOpenCodeSession({
      workspaceId: "ws-a",
      directory,
      sessionOrConversationId: result.conversationId,
    });
    expect(resolved?.engineSessionId).toBe("sess-created");
  });

  test("rejects a created OpenCode session without a string id", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-service-create-invalid-id-"));
    tempDirs.push(dataDir);
    const directory = join(dataDir, "workspace-a");
    const bindingStore = createConversationBindingStore({ dataDir, now: () => 2_000 });
    const service = createConversationService({
      readStore: fakeReadStore(directory),
      bindingStore,
      createOpenCodeSession: async () => ({ id: 123 }),
    });

    let error: unknown;
    try {
      await service.createConversation({
        workspace: workspaceFor(directory),
        directory,
        title: "Invalid",
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
    expect((error as ApiError).code).toBe("opencode_failed");

    const bindings = await bindingStore.listOpenCodeSessions({
      workspaceId: "ws-a",
      directory,
    });
    expect(bindings).toEqual([]);
  });
});
