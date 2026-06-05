import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  createConversationBindingStore,
  deterministicConversationId,
  resolveConversationBindingDbPath,
} from "./conversation-binding-store.js";

const tempDirs: string[] = [];
const envRestores: Array<() => void> = [];

afterEach(async () => {
  while (envRestores.length > 0) {
    envRestores.pop()?.();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

const setEnv = (key: string, value: string) => {
  const previous = process.env[key];
  process.env[key] = value;
  envRestores.push(() => {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  });
};

describe("conversation binding store", () => {
  test("persists OpenCode session bindings in the Veslo data dir", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-bindings-"));
    tempDirs.push(dataDir);
    setEnv("VESLO_DATA_DIR", dataDir);

    const directory = join(dataDir, "workspace-a");
    const store = createConversationBindingStore({ now: () => 1_000 });
    const binding = await store.bindOpenCodeSession({
      workspaceId: "ws-a",
      directory,
      engineSessionId: "sess-a",
      title: "Session A",
      parentEngineSessionId: "parent-a",
      createdAt: 10,
      updatedAt: 20,
    });

    expect(binding.conversationId).toBe(deterministicConversationId({
      workspaceId: "ws-a",
      directory,
      engineSessionId: "sess-a",
    }));
    expect(binding.parentConversationId).toBe(deterministicConversationId({
      workspaceId: "ws-a",
      directory,
      engineSessionId: "parent-a",
    }));

    const restartedStore = createConversationBindingStore({ now: () => 2_000 });
    const resolvedByConversation = await restartedStore.resolveOpenCodeSession({
      workspaceId: "ws-a",
      directory,
      sessionOrConversationId: binding.conversationId,
    });
    expect(resolvedByConversation?.engineSessionId).toBe("sess-a");

    const resolvedByEngine = await restartedStore.resolveOpenCodeSession({
      workspaceId: "ws-a",
      directory,
      sessionOrConversationId: "sess-a",
    });
    expect(resolvedByEngine?.conversationId).toBe(binding.conversationId);

    const updated = await restartedStore.bindOpenCodeSession({
      workspaceId: "ws-a",
      directory,
      engineSessionId: "sess-a",
      title: "Session A updated",
      createdAt: 10,
      updatedAt: 40,
    });
    expect(updated.conversationId).toBe(binding.conversationId);
    expect(updated.title).toBe("Session A updated");
    expect(updated.createdAt).toBe(10);
    expect(updated.updatedAt).toBe(40);
    expect(updated.firstSeenAt).toBe(1_000);
    expect(updated.lastSeenAt).toBe(2_000);
  });

  test("scopes identical engine session ids by workspace and directory", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-bindings-scope-"));
    tempDirs.push(dataDir);
    const workspaceOne = join(dataDir, "workspace-one");
    const workspaceTwo = join(dataDir, "workspace-two");
    const store = createConversationBindingStore({ dataDir, now: () => 1_000 });

    const one = await store.bindOpenCodeSession({
      workspaceId: "ws-one",
      directory: workspaceOne,
      engineSessionId: "sess-same",
    });
    const two = await store.bindOpenCodeSession({
      workspaceId: "ws-two",
      directory: workspaceTwo,
      engineSessionId: "sess-same",
    });

    expect(one.conversationId).not.toBe(two.conversationId);
    expect(await store.resolveOpenCodeSession({
      workspaceId: "ws-one",
      directory: workspaceOne,
      sessionOrConversationId: two.conversationId,
    })).toBeNull();
    expect((await store.resolveOpenCodeSession({
      workspaceId: "ws-two",
      directory: workspaceTwo,
      sessionOrConversationId: two.conversationId,
    }))?.engineSessionId).toBe("sess-same");
  });

  test("resolves the default DB path under the configured server data dir", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-bindings-path-"));
    tempDirs.push(dataDir);

    expect(resolveConversationBindingDbPath({ dataDir })).toBe(
      join(resolve(dataDir), "conversations", "bindings.sqlite"),
    );

    const explicitDb = join(dataDir, "custom", "bindings.sqlite");
    setEnv("VESLO_CONVERSATION_BINDINGS_DB_PATH", explicitDb);
    expect(resolveConversationBindingDbPath({ dataDir })).toBe(resolve(explicitDb));
  });
});
