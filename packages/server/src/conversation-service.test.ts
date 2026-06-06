import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { createConversationBindingStore } from "./conversation-binding-store.js";
import type { ConversationReadStore } from "./conversation-read-store.js";
import { createConversationService } from "./conversation-service.js";
import type { WorkspaceInfo } from "./types.js";

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
