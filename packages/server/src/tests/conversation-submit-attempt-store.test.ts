import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  createConversationSubmitAttemptStore,
  resolveConversationSubmitAttemptDbPath,
} from "../conversation-submit-attempt-store.js";

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

const createTempDbPath = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return join(dir, "submit-attempts.sqlite");
};

describe("conversation submit attempt store", () => {
  test("claims a submit attempt idempotently by workspace and client message", async () => {
    const store = createConversationSubmitAttemptStore({ dbPath: await createTempDbPath("veslo-submit-attempt-claim-"), now: () => 1_000 });

    const first = store.claim({
      workspaceId: "ws_1",
      clientMessageId: "msg_1",
      requestHash: "hash-a",
    });
    const second = store.claim({
      workspaceId: "ws_1",
      clientMessageId: "msg_1",
      requestHash: "hash-a",
    });

    expect(first.inserted).toBe(true);
    expect(first.conflict).toBe(false);
    expect(first.attempt.status).toBe("started");
    expect(second.inserted).toBe(false);
    expect(second.conflict).toBe(false);
    expect(second.attempt.requestHash).toBe("hash-a");
  });

  test("detects idempotency conflicts for reused client message ids", async () => {
    const store = createConversationSubmitAttemptStore({ dbPath: await createTempDbPath("veslo-submit-attempt-conflict-"), now: () => 1_000 });

    store.claim({
      workspaceId: "ws_1",
      clientMessageId: "msg_1",
      requestHash: "hash-a",
    });
    const conflict = store.claim({
      workspaceId: "ws_1",
      clientMessageId: "msg_1",
      requestHash: "hash-b",
    });

    expect(conflict.inserted).toBe(false);
    expect(conflict.conflict).toBe(true);
    expect(conflict.attempt.requestHash).toBe("hash-a");
  });

  test("stores result pointers without becoming a run lifecycle store", async () => {
    const store = createConversationSubmitAttemptStore({ dbPath: await createTempDbPath("veslo-submit-attempt-result-"), now: () => 1_000 });
    store.claim({
      workspaceId: "ws_1",
      clientMessageId: "msg_1",
      requestHash: "hash-a",
    });

    const updated = store.update({
      workspaceId: "ws_1",
      clientMessageId: "msg_1",
      status: "completed",
      conversationId: "conv_1",
      opencodeSessionId: "sess_1",
      runId: "run_1",
      queueItemId: "queue_1",
      resultJson: JSON.stringify({ status: "submitted", runId: "run_1" }),
    });

    expect(updated.status).toBe("completed");
    expect(updated.conversationId).toBe("conv_1");
    expect(updated.opencodeSessionId).toBe("sess_1");
    expect(updated.runId).toBe("run_1");
    expect(updated.queueItemId).toBe("queue_1");
    expect(JSON.parse(updated.resultJson ?? "{}")).toEqual({ status: "submitted", runId: "run_1" });
  });

  test("resolves the default DB path under the configured server data dir", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-conversation-submit-attempts-"));
    tempDirs.push(dataDir);

    expect(resolveConversationSubmitAttemptDbPath({ dataDir })).toBe(
      join(resolve(dataDir), "conversations", "submit-attempts.sqlite"),
    );

    const explicitDb = join(dataDir, "custom", "submit-attempts.sqlite");
    setEnv("VESLO_CONVERSATION_SUBMIT_ATTEMPTS_DB_PATH", explicitDb);
    expect(resolveConversationSubmitAttemptDbPath({ dataDir })).toBe(resolve(explicitDb));
  });
});
