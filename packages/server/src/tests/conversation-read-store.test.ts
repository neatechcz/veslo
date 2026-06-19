import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { createConversationReadStore } from "../conversation-read-store.js";

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

const seedDb = (dbPath: string, directory: string) => {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        title TEXT,
        directory TEXT,
        parent_id TEXT,
        time_created INTEGER,
        time_updated INTEGER
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        data TEXT NOT NULL
      );
    `);
    db.query(
      "INSERT INTO session (id, title, directory, parent_id, time_created, time_updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    ).run("sess-a", "Session A", directory, null, 10, 20);
    db.query("INSERT INTO message (id, session_id, data) VALUES (?1, ?2, ?3)")
      .run("msg-1", "sess-a", JSON.stringify({ id: "msg-1", sessionID: "sess-a", role: "assistant" }));
    db.query("INSERT INTO part (id, session_id, message_id, data) VALUES (?1, ?2, ?3, ?4)")
      .run("part-1", "sess-a", "msg-1", JSON.stringify({ id: "part-1", messageID: "msg-1", type: "text", text: "Ahoj" }));
  } finally {
    db.close();
  }
};

describe("conversation read store DB path resolution", () => {
  test("uses workspace opencodeDbPath before global defaults", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversation-read-workspace-db-"));
    tempDirs.push(workspaceRoot);
    const dbPath = join(workspaceRoot, "workspace-opencode.db");
    seedDb(dbPath, workspaceRoot);

    const store = createConversationReadStore();
    const list = await store.listConversations({
      workspaceId: "ws-a",
      directory: workspaceRoot,
      workspace: {
        id: "ws-a",
        path: workspaceRoot,
        opencodeDbPath: dbPath,
      },
    });

    expect(list.source).toBe("sqlite");
    expect(list.items.map((item) => item.id)).toEqual(["sess-a"]);

    const transcript = await store.getTranscript({
      workspaceId: "ws-a",
      sessionId: "sess-a",
      limit: 10,
      directory: workspaceRoot,
      workspace: {
        id: "ws-a",
        path: workspaceRoot,
        opencodeDbPath: dbPath,
      },
    });
    expect(transcript.source).toBe("sqlite");
    expect(transcript.messages.length).toBe(1);
    expect(transcript.partsByMessageId["msg-1"]?.length).toBe(1);
  });

  test("reports unavailable (not empty) when the session is not found under the directory", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversation-read-not-found-"));
    tempDirs.push(workspaceRoot);
    const dbPath = join(workspaceRoot, "workspace-opencode.db");
    seedDb(dbPath, workspaceRoot);

    const store = createConversationReadStore();
    const transcript = await store.getTranscript({
      workspaceId: "ws-a",
      sessionId: "sess-does-not-exist",
      limit: 10,
      directory: workspaceRoot,
      workspace: {
        id: "ws-a",
        path: workspaceRoot,
        opencodeDbPath: dbPath,
      },
    });

    // Not found under directory must be reported as unavailable so the UI does
    // not render a misleading empty transcript as a completed read.
    expect(transcript.source).toBe("unavailable");
    expect(transcript.messages.length).toBe(0);
  });

  test("matches Windows directory variants when reading OpenCode sqlite", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversation-read-windows-path-"));
    tempDirs.push(workspaceRoot);
    const dbPath = join(workspaceRoot, "workspace-opencode.db");
    const storedDirectory = "c:\\users\\alice\\appdata\\local\\veslo\\test-repo\\test-repo2";
    seedDb(dbPath, storedDirectory);

    const store = createConversationReadStore();
    const list = await store.listConversations({
      workspaceId: "ws-a",
      directory: "\\\\?\\C:\\Users\\alice\\AppData\\Local\\Veslo\\test-repo\\test-repo2",
      workspace: {
        id: "ws-a",
        path: workspaceRoot,
        opencodeDbPath: dbPath,
      },
    });

    expect(list.source).toBe("sqlite");
    expect(list.items.map((item) => item.id)).toEqual(["sess-a"]);

    const transcript = await store.getTranscript({
      workspaceId: "ws-a",
      sessionId: "sess-a",
      limit: 10,
      directory: "//?/C:/Users/alice/AppData/Local/Veslo/test-repo/test-repo2",
      workspace: {
        id: "ws-a",
        path: workspaceRoot,
        opencodeDbPath: dbPath,
      },
    });
    expect(transcript.source).toBe("sqlite");
    expect(transcript.messages.length).toBe(1);
    expect(transcript.partsByMessageId["msg-1"]?.length).toBe(1);
  });

  test("matches WSL mount directory variants when reading OpenCode sqlite", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversation-read-wsl-path-"));
    tempDirs.push(workspaceRoot);
    const dbPath = join(workspaceRoot, "workspace-opencode.db");
    seedDb(dbPath, "/mnt/c/Users/alice/AppData/Local/Veslo/test-repo/test-repo2");

    const store = createConversationReadStore();
    const list = await store.listConversations({
      workspaceId: "ws-a",
      directory: "C:\\Users\\alice\\AppData\\Local\\Veslo\\test-repo\\test-repo2",
      workspace: {
        id: "ws-a",
        path: workspaceRoot,
        opencodeDbPath: dbPath,
      },
    });

    expect(list.source).toBe("sqlite");
    expect(list.items.map((item) => item.id)).toEqual(["sess-a"]);

    const transcript = await store.getTranscript({
      workspaceId: "ws-a",
      sessionId: "sess-a",
      limit: 10,
      directory: "C:/Users/alice/AppData/Local/Veslo/test-repo/test-repo2",
      workspace: {
        id: "ws-a",
        path: workspaceRoot,
        opencodeDbPath: dbPath,
      },
    });
    expect(transcript.source).toBe("sqlite");
    expect(transcript.messages.length).toBe(1);
  });

  test("uses workspace-scoped env override for DB path", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversation-read-env-db-"));
    tempDirs.push(workspaceRoot);
    const dbPath = join(workspaceRoot, "env-opencode.db");
    seedDb(dbPath, workspaceRoot);
    setEnv("VESLO_OPENCODE_DB_PATH_WS_A", dbPath);

    const store = createConversationReadStore();
    const list = await store.listConversations({
      workspaceId: "ws-a",
      directory: workspaceRoot,
      workspace: {
        id: "ws-a",
        path: workspaceRoot,
      },
    });

    expect(list.source).toBe("sqlite");
    expect(list.items[0]?.id).toBe("sess-a");
  });

  test("uses workspace opencodeDataDir", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversation-read-data-dir-"));
    tempDirs.push(workspaceRoot);
    const dataDir = join(workspaceRoot, "data", "opencode");
    await rm(dataDir, { recursive: true, force: true });
    const dbPath = join(dataDir, "opencode.db");
    await mkdir(dataDir, { recursive: true });
    seedDb(dbPath, workspaceRoot);

    const store = createConversationReadStore();
    const list = await store.listConversations({
      workspaceId: "ws-a",
      directory: workspaceRoot,
      workspace: {
        id: "ws-a",
        path: workspaceRoot,
        opencodeDataDir: dataDir,
      },
    });

    expect(list.source).toBe("sqlite");
    expect(list.items[0]?.id).toBe("sess-a");
  });

  test("uses workspace opencodeDataHome", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversation-read-data-home-"));
    tempDirs.push(workspaceRoot);
    const dataHome = join(workspaceRoot, "xdg-data");
    const dbDir = join(dataHome, "opencode");
    await mkdir(dbDir, { recursive: true });
    const dbPath = join(dbDir, "opencode.db");
    seedDb(dbPath, workspaceRoot);

    const store = createConversationReadStore();
    const list = await store.listConversations({
      workspaceId: "ws-a",
      directory: workspaceRoot,
      workspace: {
        id: "ws-a",
        path: workspaceRoot,
        opencodeDataHome: dataHome,
      },
    });

    expect(list.source).toBe("sqlite");
    expect(list.items[0]?.id).toBe("sess-a");
  });

  test("uses nested workspace opencode dbPath and dataHome", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversation-read-nested-"));
    tempDirs.push(workspaceRoot);
    const dbPath = join(workspaceRoot, "nested-opencode.db");
    seedDb(dbPath, workspaceRoot);

    const store = createConversationReadStore();
    const list = await store.listConversations({
      workspaceId: "ws-a",
      directory: workspaceRoot,
      workspace: {
        id: "ws-a",
        path: workspaceRoot,
        opencode: {
          dbPath,
        },
      },
    });

    expect(list.source).toBe("sqlite");
    expect(list.items[0]?.id).toBe("sess-a");

    const workspaceTwoRoot = await mkdtemp(join(tmpdir(), "veslo-conversation-read-nested-home-"));
    tempDirs.push(workspaceTwoRoot);
    const dataHome = join(workspaceTwoRoot, "xdg-data");
    const dbDir = join(dataHome, "opencode");
    await mkdir(dbDir, { recursive: true });
    seedDb(join(dbDir, "opencode.db"), workspaceTwoRoot);

    const nestedHome = await store.listConversations({
      workspaceId: "ws-b",
      directory: workspaceTwoRoot,
      workspace: {
        id: "ws-b",
        path: workspaceTwoRoot,
        opencode: {
          dataHome,
        },
      },
    });
    expect(nestedHome.source).toBe("sqlite");
    expect(nestedHome.items[0]?.id).toBe("sess-a");
  });
});
