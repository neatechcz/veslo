import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSessionArchiveStore } from "./session-archives.js";
import { resolveArchiveOwnerKey } from "./server.js";

test("resolveArchiveOwnerKey requires an explicit account id header", () => {
  assert.throws(() => resolveArchiveOwnerKey(new Request("https://veslo.example/session-archives")), /account id/i);
  assert.equal(
    resolveArchiveOwnerKey(
      new Request("https://veslo.example/session-archives", {
        headers: { "x-veslo-account-id": " usr_123 " },
      }),
    ),
    "usr_123",
  );
});

test("session archive store persists records per owner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "veslo-session-archives-"));
  const store = createSessionArchiveStore({ dir });

  await store.put("usr_a", {
    sessionId: "session-a",
    archivedAt: 10,
    titleSnapshot: "Session A",
  });

  await store.put("usr_b", {
    sessionId: "session-b",
    archivedAt: 20,
    titleSnapshot: "Session B",
  });

  assert.deepEqual(
    (await store.list("usr_a")).map((entry) => entry.sessionId),
    ["session-a"],
  );
  assert.deepEqual(
    (await store.list("usr_b")).map((entry) => entry.sessionId),
    ["session-b"],
  );
});

test("session archive store upserts existing sessions and sorts newest first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "veslo-session-archives-"));
  const store = createSessionArchiveStore({ dir });

  await store.put("usr_123", {
    sessionId: "older",
    archivedAt: 10,
    titleSnapshot: "Older",
  });
  await store.put("usr_123", {
    sessionId: "newer",
    archivedAt: 20,
    titleSnapshot: "Newer",
  });
  const upserted = await store.put("usr_123", {
    sessionId: "older",
    archivedAt: 30,
    titleSnapshot: "Older updated",
  });

  assert.deepEqual(
    upserted.map((entry) => [entry.sessionId, entry.archivedAt]),
    [
      ["older", 30],
      ["newer", 20],
    ],
  );
});

test("session archive store deletes records idempotently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "veslo-session-archives-"));
  const store = createSessionArchiveStore({ dir });

  await store.put("usr_123", {
    sessionId: "session-a",
    archivedAt: 10,
    titleSnapshot: "Session A",
  });

  assert.deepEqual((await store.delete("usr_123", "session-a")).length, 0);
  assert.deepEqual((await store.delete("usr_123", "session-a")).length, 0);
});
