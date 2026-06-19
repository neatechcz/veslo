import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { createConversationBindingStore } from "../conversation-binding-store.js";
import type { ConversationReadStore } from "../conversation-read-store.js";
import { createConversationTranscriptStore } from "../conversation-transcript-store.js";
import { createConversationService } from "../conversation-service.js";
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

  test("creates an OpenCode session and persists the binding before returning", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-service-create-"));
    tempDirs.push(dataDir);
    const directory = join(dataDir, "workspace-a");
    const bindingStore = createConversationBindingStore({ dataDir, now: () => 2_000 });
    const createInputs: Array<{ directory: string | null; title?: string | null }> = [];
    const service = createConversationService({
      readStore: fakeReadStore(directory),
      bindingStore,
      createOpenCodeSession: async (input) => {
        createInputs.push({ directory: input.directory, title: input.title });
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
    });

    expect(createInputs[0]?.directory).toBe(directory);
    expect(createInputs[0]?.title).toBe("Created");
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
});
