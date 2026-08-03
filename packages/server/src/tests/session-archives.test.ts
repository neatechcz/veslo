import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSessionArchiveStore } from "../session-archives.js";
import { resolveArchiveOwnerKey } from "../server.js";

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

test("session archive store scopes duplicate workspace session ids by directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "veslo-session-archives-"));
  const store = createSessionArchiveStore({ dir });

  await store.put("usr_123", {
    sessionId: "shared",
    workspaceIdAtArchive: "workspace-a",
    resolvedDirectoryAtArchive: "/work/a",
    archivedAt: 10,
    titleSnapshot: "Project A",
  });
  await store.put("usr_123", {
    sessionId: "shared",
    workspaceIdAtArchive: "workspace-a",
    resolvedDirectoryAtArchive: "/work/b",
    archivedAt: 20,
    titleSnapshot: "Project B",
  });

  assert.deepEqual(
    (await store.list("usr_123")).map((entry) => [entry.titleSnapshot, entry.resolvedDirectoryAtArchive]),
    [
      ["Project B", "/work/b"],
      ["Project A", "/work/a"],
    ],
  );

  const afterDirectoryDelete = await store.delete("usr_123", "shared", {
    workspaceId: "workspace-a",
    directory: "/work/a",
  });
  assert.deepEqual(
    afterDirectoryDelete.map((entry) => [entry.titleSnapshot, entry.resolvedDirectoryAtArchive]),
    [["Project B", "/work/b"]],
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

test("session archive scoped delete preserves identity-only records outside the exact scope", async () => {
  const dir = await mkdtemp(join(tmpdir(), "veslo-session-archives-"));
  const store = createSessionArchiveStore({ dir });

  await store.put("usr_123", {
    sessionId: "shared",
    archivedAt: 10,
    titleSnapshot: "Workspace A",
    workspaceIdentity: "local:/workspace/a",
  });
  await store.put("usr_123", {
    sessionId: "shared",
    archivedAt: 20,
    titleSnapshot: "Workspace B",
    workspaceIdentity: "local:/workspace/b",
  });

  const afterWorkspaceIdDelete = await store.delete("usr_123", "shared", {
    workspaceId: "workspace-a",
  });
  assert.deepEqual(
    afterWorkspaceIdDelete.map((entry) => entry.workspaceIdentity).sort(),
    ["local:/workspace/a", "local:/workspace/b"],
  );

  const afterIdentityDelete = await store.delete("usr_123", "shared", {
    workspaceIdentity: "local:/workspace/a",
  });
  assert.deepEqual(
    afterIdentityDelete.map((entry) => entry.workspaceIdentity),
    ["local:/workspace/b"],
  );
});

test("session archive store serializes concurrent owner mutations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "veslo-session-archives-"));
  const store = createSessionArchiveStore({ dir });

  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) => store.put("usr_123", {
      sessionId: `session-${index}`,
      archivedAt: index,
      titleSnapshot: `Session ${index}`,
    })),
  );

  assert.equal(results.length, 8);
  assert.deepEqual(
    (await store.list("usr_123")).map((entry) => entry.sessionId).sort(),
    Array.from({ length: 8 }, (_, index) => `session-${index}`),
  );
});

test("session archive store surfaces corrupt state instead of overwriting it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "veslo-session-archives-"));
  const ownerKey = "usr_123";
  const path = join(dir, `${createHash("sha256").update(ownerKey).digest("hex")}.json`);
  const corruptContent = '[{"sessionId":"valuable-record"}';
  await writeFile(path, corruptContent, "utf8");
  const store = createSessionArchiveStore({ dir });

  await assert.rejects(() => store.list(ownerKey), SyntaxError);
  await assert.rejects(() => store.put(ownerKey, {
    sessionId: "new-record",
    archivedAt: 2,
    titleSnapshot: "New",
  }), SyntaxError);
  assert.equal(await readFile(path, "utf8"), corruptContent);
});
