import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import type { SkillPackageFile } from "../skill-package-model.js";
import { buildSkillPackageManifest } from "../skill-package-model.js";
import type { SkillPackageArchive } from "../skill-packages.js";
import {
  cacheSkillPackageArchive,
  getOrCacheSkillPackageArchive,
  pruneSkillPackageCache,
  readCachedSkillPackageArchive,
  skillPackageCacheDir,
  skillPackageCachePath,
} from "../skill-package-cache.js";
import { exists } from "../utils.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

const tempDataDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "veslo-skill-package-cache-"));
  tempDirs.push(dir);
  return dir;
};

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

const archiveFile = (
  path: string,
  bytes: Buffer | string,
): SkillPackageFile & { contentBase64: string } => {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8");
  return {
    path,
    sha256: sha256(buffer),
    sizeBytes: buffer.byteLength,
    mediaType: "text/markdown",
    text: buffer.toString("utf8"),
    contentBase64: buffer.toString("base64"),
  };
};

const archive = async (name: string, body: string): Promise<SkillPackageArchive> => {
  const files = [archiveFile("SKILL.md", `---\nname: ${name}\n---\n\n${body}\n`)];
  return {
    ...(await buildSkillPackageManifest({ metadata: { name }, files })),
    files,
  };
};

describe("skill package cache", () => {
  test("stores package archives by package hash under the Veslo data dir", async () => {
    const dataDir = await tempDataDir();
    const pkg = await archive("research", "# Research");

    const cachedPath = await cacheSkillPackageArchive({ dataDir, archive: pkg });

    expect(skillPackageCacheDir(dataDir)).toBe(join(dataDir, "skill-package-cache"));
    expect(cachedPath).toBe(skillPackageCachePath(dataDir, pkg.packageSha256));
    expect(await exists(cachedPath)).toBe(true);
    await expect(readCachedSkillPackageArchive({ dataDir, packageSha256: pkg.packageSha256 })).resolves.toEqual(pkg);
  });

  test("verifies cached package hashes before returning an archive", async () => {
    const dataDir = await tempDataDir();
    const pkg = await archive("research", "# Research");
    await cacheSkillPackageArchive({ dataDir, archive: pkg });
    await writeFile(skillPackageCachePath(dataDir, pkg.packageSha256), JSON.stringify({
      ...pkg,
      packageSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }));

    await expect(readCachedSkillPackageArchive({ dataDir, packageSha256: pkg.packageSha256 })).resolves.toBeNull();
  });

  test("redownloads and caches when an existing blob is corrupted", async () => {
    const dataDir = await tempDataDir();
    const pkg = await archive("research", "# Research");
    await cacheSkillPackageArchive({ dataDir, archive: pkg });
    await writeFile(skillPackageCachePath(dataDir, pkg.packageSha256), "{ invalid json", "utf8");

    let fetches = 0;
    const result = await getOrCacheSkillPackageArchive({
      dataDir,
      packageSha256: pkg.packageSha256,
      fetchPackage: async () => {
        fetches += 1;
        return pkg;
      },
    });

    expect(result).toEqual(pkg);
    expect(fetches).toBe(1);
    await expect(readCachedSkillPackageArchive({ dataDir, packageSha256: pkg.packageSha256 })).resolves.toEqual(pkg);
  });

  test("prune preserves referenced package hashes and removes stale blobs", async () => {
    const dataDir = await tempDataDir();
    const kept = await archive("kept", "# Kept");
    const removed = await archive("removed", "# Removed");
    await cacheSkillPackageArchive({ dataDir, archive: kept });
    await cacheSkillPackageArchive({ dataDir, archive: removed });

    const result = await pruneSkillPackageCache({
      dataDir,
      referencedPackageSha256s: [kept.packageSha256],
    });

    expect(result.removedPackageSha256s).toEqual([removed.packageSha256]);
    expect(await exists(skillPackageCachePath(dataDir, kept.packageSha256))).toBe(true);
    expect(await exists(skillPackageCachePath(dataDir, removed.packageSha256))).toBe(false);
  });
});
