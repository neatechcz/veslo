import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { createConversationBindingStore } from "../conversation-binding-store.js";
import type { ConversationReadStore } from "../conversation-read-store.js";
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

  test("lists persisted bindings when OpenCode sqlite is unavailable", async () => {
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

    expect(result.source).toBe("unavailable");
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

  test("unions sandbox sessions with owned bindings the sandbox did not return", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-service-union-"));
    tempDirs.push(dataDir);
    const directory = join(dataDir, "workspace-a");
    const bindingStore = createConversationBindingStore({ dataDir, now: () => 5_000 });
    // An owned conversation that the current sandbox read does NOT return
    // (e.g. directory-form mismatch or a stale sandbox DB). It must still list.
    await bindingStore.bindOpenCodeSession({
      workspaceId: "ws-a",
      directory,
      engineSessionId: "sess-owned-only",
      title: "Owned only",
      createdAt: 1,
      updatedAt: 2,
    });
    const service = createConversationService({
      readStore: {
        ...unavailableReadStore,
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
            ],
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
    const ids = result.items.map((item) => item.id);

    expect(result.source).toBe("sqlite");
    expect(result.items).toHaveLength(2);
    expect(ids).toContain("sess-parent");
    expect(ids).toContain("sess-owned-only");
    // Sandbox item stays first (primary order preserved); owned-only appended.
    expect(ids[0]).toBe("sess-parent");
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
