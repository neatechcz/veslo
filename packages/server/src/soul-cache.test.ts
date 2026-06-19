import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import type { SoulDocument } from "./soul-memory.js";
import {
  cacheSoulDocument,
  listPendingSoulEdits,
  readCachedSoulDocument,
  soulCachePath,
  writePendingSoulEdit,
} from "./soul-cache.js";
import { exists } from "./utils.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

const tempDataDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "veslo-soul-cache-"));
  tempDirs.push(dir);
  return dir;
};

const document = (scope: SoulDocument["scope"], ownerId: string): SoulDocument => ({
  id: `soul_${scope}_${ownerId}`,
  scope,
  ownerId,
  currentVersionId: "version_1",
  heartbeatEnabled: scope !== "organization",
  versions: [{
    id: "version_1",
    content: `${scope} memory`,
    changeSummary: "Initial memory",
    createdAt: "2026-06-05T10:00:00.000Z",
    createdBy: "user_123",
    source: "manual",
    baseVersionId: null,
    restoreSourceVersionId: null,
  }],
});

describe("soul cache", () => {
  test("caches Den success responses by scope and owner id", async () => {
    const dataDir = await tempDataDir();
    const userSoul = document("user", "user_123");

    const path = await cacheSoulDocument({ dataDir, document: userSoul });

    expect(path).toBe(soulCachePath({ dataDir, scope: "user", ownerId: "user_123" }));
    expect(path).toBe(join(dataDir, "soul-cache", "user", "dXNlcl8xMjM.json"));
    expect(await exists(path)).toBe(true);
    await expect(readCachedSoulDocument({ dataDir, scope: "user", ownerId: "user_123" })).resolves.toEqual(userSoul);
  });

  test("supports organization and workspace cached documents", async () => {
    const dataDir = await tempDataDir();
    const orgSoul = document("organization", "org_123");
    const workspaceSoul = document("workspace", "workspace_123");

    await cacheSoulDocument({ dataDir, document: orgSoul });
    await cacheSoulDocument({ dataDir, document: workspaceSoul });

    await expect(readCachedSoulDocument({ dataDir, scope: "organization", ownerId: "org_123" })).resolves.toEqual(orgSoul);
    await expect(readCachedSoulDocument({ dataDir, scope: "workspace", ownerId: "workspace_123" })).resolves.toEqual(workspaceSoul);
  });

  test("serves no cached document when the cache file is missing or invalid", async () => {
    const dataDir = await tempDataDir();

    await expect(readCachedSoulDocument({ dataDir, scope: "user", ownerId: "missing" })).resolves.toBeNull();
    await mkdir(join(dataDir, "soul-cache", "user"), { recursive: true });
    await writeFile(soulCachePath({ dataDir, scope: "user", ownerId: "user_123" }), "{ invalid json", "utf8");

    await expect(readCachedSoulDocument({ dataDir, scope: "user", ownerId: "user_123" })).resolves.toBeNull();
  });

  test("serves no cached document when embedded versions are malformed", async () => {
    const dataDir = await tempDataDir();
    const userSoul = {
      ...document("user", "user_123"),
      versions: [{
        ...document("user", "user_123").versions[0],
        source: "imported",
      }],
    };
    await mkdir(join(dataDir, "soul-cache", "user"), { recursive: true });
    await writeFile(soulCachePath({ dataDir, scope: "user", ownerId: "user_123" }), JSON.stringify(userSoul), "utf8");

    await expect(readCachedSoulDocument({ dataDir, scope: "user", ownerId: "user_123" })).resolves.toBeNull();
  });

  test("serves no cached document when currentVersionId points to a missing version", async () => {
    const dataDir = await tempDataDir();
    const userSoul = {
      ...document("user", "user_123"),
      currentVersionId: "missing_version",
    };
    await mkdir(join(dataDir, "soul-cache", "user"), { recursive: true });
    await writeFile(soulCachePath({ dataDir, scope: "user", ownerId: "user_123" }), JSON.stringify(userSoul), "utf8");

    await expect(readCachedSoulDocument({ dataDir, scope: "user", ownerId: "user_123" })).resolves.toBeNull();
  });

  test("marks pending edits when Den is unavailable without claiming Den sync", async () => {
    const dataDir = await tempDataDir();

    const edit = await writePendingSoulEdit({
      dataDir,
      edit: {
        scope: "user",
        ownerId: "user_123",
        content: "Offline user memory",
        changeSummary: "Offline edit",
        baseVersionId: "version_1",
        createdAt: "2026-06-05T11:00:00.000Z",
        createdBy: "user_123",
      },
    });

    expect(edit.denSynced).toBe(false);
    expect(edit.id).toStartWith("pending_");
    const pending = await listPendingSoulEdits({ dataDir });
    expect(pending).toEqual([edit]);
    expect(await exists(join(dataDir, "soul-cache", "pending", `${edit.id}.json`))).toBe(true);
  });
});
