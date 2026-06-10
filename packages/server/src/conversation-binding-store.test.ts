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

  test("lists OpenCode sessions for a single workspace directory by recent activity", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-bindings-list-"));
    tempDirs.push(dataDir);
    const directory = join(dataDir, "workspace-a");
    const otherDirectory = join(dataDir, "workspace-b");
    const store = createConversationBindingStore({ dataDir, now: () => 1_000 });

    await store.bindOpenCodeSession({
      workspaceId: "ws-a",
      directory,
      engineSessionId: "sess-old",
      title: "Old",
      updatedAt: 10,
    });
    await store.bindOpenCodeSession({
      workspaceId: "ws-a",
      directory,
      engineSessionId: "sess-new",
      title: "New",
      updatedAt: 30,
    });
    await store.bindOpenCodeSession({
      workspaceId: "ws-a",
      directory: otherDirectory,
      engineSessionId: "sess-other-dir",
      updatedAt: 40,
    });
    await store.bindOpenCodeSession({
      workspaceId: "ws-b",
      directory,
      engineSessionId: "sess-other-ws",
      updatedAt: 50,
    });

    const sessions = await store.listOpenCodeSessions({
      workspaceId: "ws-a",
      directory,
    });

    expect(sessions.map((session) => session.engineSessionId)).toEqual(["sess-new", "sess-old"]);
  });

  test("orders same-timestamp sessions deterministically for parallel conversation starts", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-bindings-stable-order-"));
    tempDirs.push(dataDir);
    const directory = join(dataDir, "workspace-a");
    const store = createConversationBindingStore({ dataDir, now: () => 1_000 });

    await store.bindOpenCodeSession({
      workspaceId: "ws-a",
      directory,
      engineSessionId: "sess-b",
      updatedAt: 50,
    });
    await store.bindOpenCodeSession({
      workspaceId: "ws-a",
      directory,
      engineSessionId: "sess-a",
      updatedAt: 50,
    });
    await store.bindOpenCodeSession({
      workspaceId: "ws-a",
      directory,
      engineSessionId: "sess-c",
      updatedAt: 50,
    });

    const sessions = await store.listOpenCodeSessions({
      workspaceId: "ws-a",
      directory,
    });

    expect(sessions.map((session) => session.engineSessionId)).toEqual(["sess-a", "sess-b", "sess-c"]);
  });

  test("matches Windows directory variants when listing and resolving", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-bindings-windows-path-"));
    tempDirs.push(dataDir);
    const store = createConversationBindingStore({ dataDir, now: () => 1_000 });
    await store.bindOpenCodeSession({
      workspaceId: "ws-a",
      directory: "c:\\users\\jajse\\desktop\\test-repo\\test-repo2",
      engineSessionId: "sess-a",
      title: "Session A",
      updatedAt: 20,
    });

    const sessions = await store.listOpenCodeSessions({
      workspaceId: "ws-a",
      directory: "\\\\?\\C:\\Users\\jajse\\Desktop\\test-repo\\test-repo2",
    });

    expect(sessions.map((session) => session.engineSessionId)).toEqual(["sess-a"]);

    const resolved = await store.resolveOpenCodeSession({
      workspaceId: "ws-a",
      directory: "//?/C:/Users/jajse/Desktop/test-repo/test-repo2",
      sessionOrConversationId: sessions[0]?.conversationId ?? "",
    });
    expect(resolved?.engineSessionId).toBe("sess-a");
  });

  test("keeps POSIX directories with different casing isolated", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-bindings-posix-case-"));
    tempDirs.push(dataDir);
    const store = createConversationBindingStore({ dataDir, now: () => 1_000 });
    const upperDirectory = "/tmp/VesloCaseSensitive";
    const lowerDirectory = "/tmp/veslocasesensitive";

    const upper = await store.bindOpenCodeSession({
      workspaceId: "ws-a",
      directory: upperDirectory,
      engineSessionId: "sess-same",
      title: "Upper",
      updatedAt: 20,
    });
    const lower = await store.bindOpenCodeSession({
      workspaceId: "ws-a",
      directory: lowerDirectory,
      engineSessionId: "sess-same",
      title: "Lower",
      updatedAt: 40,
    });

    expect(lower.conversationId).not.toBe(upper.conversationId);

    const upperSessions = await store.listOpenCodeSessions({
      workspaceId: "ws-a",
      directory: upperDirectory,
    });
    const lowerSessions = await store.listOpenCodeSessions({
      workspaceId: "ws-a",
      directory: lowerDirectory,
    });

    expect(upperSessions.map((session) => session.title)).toEqual(["Upper"]);
    expect(lowerSessions.map((session) => session.title)).toEqual(["Lower"]);
  });

  test("updates one binding when the same Windows directory is rebound with a different path spelling", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-bindings-windows-rebind-"));
    tempDirs.push(dataDir);
    const store = createConversationBindingStore({ dataDir, now: () => 1_000 });

    const first = await store.bindOpenCodeSession({
      workspaceId: "ws-a",
      directory: "C:\\Users\\Jajse\\Desktop\\test-repo\\test-repo2",
      engineSessionId: "sess-a",
      title: "First",
      updatedAt: 20,
    });
    const second = await store.bindOpenCodeSession({
      workspaceId: "ws-a",
      directory: "//?/c:/users/jajse/desktop/test-repo/test-repo2",
      engineSessionId: "sess-a",
      title: "Second",
      updatedAt: 40,
    });

    expect(second.conversationId).toBe(first.conversationId);
    expect(second.directory).toBe(first.directory);
    expect(second.title).toBe("Second");

    const sessions = await store.listOpenCodeSessions({
      workspaceId: "ws-a",
      directory: "c:\\users\\jajse\\desktop\\test-repo\\test-repo2",
    });

    expect(sessions.map((session) => session.engineSessionId)).toEqual(["sess-a"]);
    expect(sessions[0]?.conversationId).toBe(first.conversationId);
  });

  test("links Windows child sessions to an existing parent across path spellings", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-bindings-windows-parent-"));
    tempDirs.push(dataDir);
    const store = createConversationBindingStore({ dataDir, now: () => 1_000 });

    const parent = await store.bindOpenCodeSession({
      workspaceId: "ws-a",
      directory: "C:\\Users\\Jajse\\Desktop\\test-repo\\test-repo2",
      engineSessionId: "sess-parent",
      title: "Parent",
      updatedAt: 20,
    });
    const child = await store.bindOpenCodeSession({
      workspaceId: "ws-a",
      directory: "//?/c:/users/jajse/desktop/test-repo/test-repo2",
      engineSessionId: "sess-child",
      parentEngineSessionId: "sess-parent",
      title: "Child",
      updatedAt: 40,
    });

    expect(child.parentConversationId).toBe(parent.conversationId);
  });

  test("repairs Windows child parent links when the parent is bound later", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-bindings-windows-late-parent-"));
    tempDirs.push(dataDir);
    const store = createConversationBindingStore({ dataDir, now: () => 1_000 });

    const child = await store.bindOpenCodeSession({
      workspaceId: "ws-a",
      directory: "//?/c:/users/jajse/desktop/test-repo/test-repo2",
      engineSessionId: "sess-child",
      parentEngineSessionId: "sess-parent",
      title: "Child",
      updatedAt: 40,
    });
    const parent = await store.bindOpenCodeSession({
      workspaceId: "ws-a",
      directory: "C:\\Users\\Jajse\\Desktop\\test-repo\\test-repo2",
      engineSessionId: "sess-parent",
      title: "Parent",
      updatedAt: 20,
    });

    expect(child.parentConversationId).not.toBe(parent.conversationId);

    const resolvedChild = await store.resolveOpenCodeSession({
      workspaceId: "ws-a",
      directory: "\\\\?\\C:\\Users\\jajse\\Desktop\\test-repo\\test-repo2",
      sessionOrConversationId: "sess-child",
    });

    expect(resolvedChild?.parentConversationId).toBe(parent.conversationId);
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
