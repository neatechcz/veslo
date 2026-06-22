import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { createConversationTranscriptStore } from "../conversation-transcript-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

const newStore = async (now = () => 1_000) => {
  const dataDir = await mkdtemp(join(tmpdir(), "veslo-transcript-store-"));
  tempDirs.push(dataDir);
  return createConversationTranscriptStore({ dataDir, now });
};

describe("conversation transcript store", () => {
  test("returns null when nothing is stored for the session", async () => {
    const store = await newStore();
    const result = await store.getTranscript({ workspaceId: "ws-a", engineSessionId: "ses-1" });
    expect(result).toBeNull();
  });

  test("persists messages + parts and reads them back in creation order", async () => {
    const store = await newStore();
    await store.appendTranscript({
      workspaceId: "ws-a",
      engineSessionId: "ses-1",
      messages: [
        {
          id: "msg-a",
          role: "assistant",
          createdAt: 20,
          payload: { id: "msg-a", role: "assistant", text: "second" },
          parts: [{ id: "prt-2", type: "text", payload: { id: "prt-2", text: "second" } }],
        },
        {
          id: "msg-z",
          role: "user",
          createdAt: 10,
          payload: { id: "msg-z", role: "user", text: "first" },
          parts: [
            { id: "prt-1a", type: "text", payload: { id: "prt-1a", text: "a" } },
            { id: "prt-1b", type: "text", payload: { id: "prt-1b", text: "b" } },
          ],
        },
      ],
    });

    const result = await store.getTranscript({ workspaceId: "ws-a", engineSessionId: "ses-1" });
    expect(result).not.toBeNull();
    expect(result!.messages.map((m) => (m as { id: string }).id)).toEqual(["msg-z", "msg-a"]);
    expect(result!.partsByMessageId["msg-z"].map((p) => (p as { id: string }).id)).toEqual([
      "prt-1a",
      "prt-1b",
    ]);
    expect(result!.partsByMessageId["msg-a"].map((p) => (p as { id: string }).id)).toEqual(["prt-2"]);
  });

  test("upserts on re-append (latest payload wins, no duplicates)", async () => {
    const store = await newStore();
    const base = {
      workspaceId: "ws-a",
      engineSessionId: "ses-1",
      messages: [
        {
          id: "msg-1",
          role: "assistant",
          createdAt: 10,
          payload: { id: "msg-1", text: "partial" },
          parts: [{ id: "prt-1", type: "text", payload: { id: "prt-1", text: "partial" } }],
        },
      ],
    };
    await store.appendTranscript(base);
    await store.appendTranscript({
      ...base,
      messages: [
        {
          ...base.messages[0],
          payload: { id: "msg-1", text: "final" },
          parts: [{ id: "prt-1", type: "text", payload: { id: "prt-1", text: "final" } }],
        },
      ],
    });

    const result = await store.getTranscript({ workspaceId: "ws-a", engineSessionId: "ses-1" });
    expect(result!.messages).toHaveLength(1);
    expect((result!.messages[0] as { text: string }).text).toBe("final");
    expect(result!.partsByMessageId["msg-1"]).toHaveLength(1);
    expect((result!.partsByMessageId["msg-1"][0] as { text: string }).text).toBe("final");
  });

  test("replaces a message part snapshot and deletes removed messages", async () => {
    const store = await newStore();
    await store.appendTranscript({
      workspaceId: "ws-a",
      engineSessionId: "ses-1",
      messages: [
        {
          id: "msg-1",
          role: "assistant",
          createdAt: 10,
          payload: { id: "msg-1", text: "one" },
          parts: [
            { id: "prt-keep", type: "text", payload: { id: "prt-keep", text: "keep" } },
            { id: "prt-remove", type: "tool", payload: { id: "prt-remove", text: "remove" } },
          ],
        },
        {
          id: "msg-2",
          role: "assistant",
          createdAt: 20,
          payload: { id: "msg-2", text: "two" },
          parts: [{ id: "prt-2", type: "text", payload: { id: "prt-2", text: "two" } }],
        },
      ],
    });

    await store.appendTranscript({
      workspaceId: "ws-a",
      engineSessionId: "ses-1",
      deletedMessageIds: ["msg-2"],
      deletedPartsByMessageId: { "msg-1": ["prt-remove"] },
      messages: [
        {
          id: "msg-1",
          role: "assistant",
          createdAt: 10,
          payload: { id: "msg-1", text: "one updated" },
          parts: [{ id: "prt-keep", type: "text", payload: { id: "prt-keep", text: "keep updated" } }],
        },
      ],
    });

    const result = await store.getTranscript({ workspaceId: "ws-a", engineSessionId: "ses-1" });
    expect(result!.messages.map((m) => (m as { id: string }).id)).toEqual(["msg-1"]);
    expect(result!.partsByMessageId["msg-1"].map((p) => (p as { id: string }).id)).toEqual(["prt-keep"]);
    expect((result!.partsByMessageId["msg-1"][0] as { text: string }).text).toBe("keep updated");
  });

  test("limit returns the first N messages by creation order", async () => {
    const store = await newStore();
    await store.appendTranscript({
      workspaceId: "ws-a",
      engineSessionId: "ses-1",
      messages: [
        ["msg-c", 30],
        ["msg-a", 10],
        ["msg-b", 20],
      ].map(([id, createdAt]) => ({
        id: String(id),
        role: "user",
        createdAt: Number(createdAt),
        payload: { id },
        parts: [],
      })),
    });

    const result = await store.getTranscript({ workspaceId: "ws-a", engineSessionId: "ses-1", limit: 2 });
    expect(result!.messages.map((m) => (m as { id: string }).id)).toEqual(["msg-a", "msg-b"]);
  });

  test("scopes by workspace and session", async () => {
    const store = await newStore();
    await store.appendTranscript({
      workspaceId: "ws-a",
      engineSessionId: "ses-1",
      messages: [{ id: "msg-a", payload: { id: "msg-a" }, parts: [] }],
    });
    await store.appendTranscript({
      workspaceId: "ws-b",
      engineSessionId: "ses-1",
      messages: [{ id: "msg-b", payload: { id: "msg-b" }, parts: [] }],
    });

    const a = await store.getTranscript({ workspaceId: "ws-a", engineSessionId: "ses-1" });
    expect(a!.messages.map((m) => (m as { id: string }).id)).toEqual(["msg-a"]);
    const other = await store.getTranscript({ workspaceId: "ws-a", engineSessionId: "ses-2" });
    expect(other).toBeNull();
  });
});
