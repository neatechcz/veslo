import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveVesloDataDir } from "./audit.js";
import { validateSkillPackageManifest } from "./skill-package-model.js";
import type { SkillPackageArchive } from "./skill-packages.js";
import { exists } from "./utils.js";

export type SkillPackageCacheInput = {
  dataDir?: string;
};

export type CacheSkillPackageArchiveInput = SkillPackageCacheInput & {
  archive: SkillPackageArchive;
};

export type ReadCachedSkillPackageArchiveInput = SkillPackageCacheInput & {
  packageSha256: string;
};

export type GetOrCacheSkillPackageArchiveInput = ReadCachedSkillPackageArchiveInput & {
  fetchPackage: () => Promise<SkillPackageArchive>;
};

export type PruneSkillPackageCacheInput = SkillPackageCacheInput & {
  referencedPackageSha256s: string[];
};

export type PruneSkillPackageCacheResult = {
  removedPackageSha256s: string[];
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

const normalizeSha256 = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new Error("Skill package cache key must be a sha256 digest");
  }
  return normalized;
};

const resolveDataDir = (dataDir?: string) => dataDir?.trim() || resolveVesloDataDir();

export function skillPackageCacheDir(dataDir?: string): string {
  return join(resolveDataDir(dataDir), "skill-package-cache");
}

export function skillPackageCachePath(dataDir: string | undefined, packageSha256: string): string {
  return join(skillPackageCacheDir(dataDir), `${normalizeSha256(packageSha256)}.json`);
}

const validateArchiveForCache = (archive: SkillPackageArchive, expectedPackageSha256?: string): SkillPackageArchive => {
  const validated = validateSkillPackageManifest(archive);
  const normalizedArchiveSha = normalizeSha256(validated.packageSha256);
  if (expectedPackageSha256 && normalizedArchiveSha !== normalizeSha256(expectedPackageSha256)) {
    throw new Error("Cached skill package hash does not match requested package hash");
  }
  return {
    ...archive,
    packageSha256: normalizedArchiveSha,
    files: archive.files,
  };
};

export async function cacheSkillPackageArchive(input: CacheSkillPackageArchiveInput): Promise<string> {
  const archive = validateArchiveForCache(input.archive);
  const path = skillPackageCachePath(input.dataDir, archive.packageSha256);
  await mkdir(skillPackageCacheDir(input.dataDir), { recursive: true });
  // Content-addressed archives are immutable once validated. Never replace a
  // healthy entry merely because another sync requested the same digest.
  const existing = await readCachedSkillPackageArchive({
    ...(input.dataDir !== undefined ? { dataDir: input.dataDir } : {}),
    packageSha256: archive.packageSha256,
  });
  if (existing) return path;

  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(archive)}\n`, "utf8");
    // A corrupt cache entry is not a trusted immutable source. Remove it
    // before atomic promotion; competing writers converge on the same bytes.
    await rm(path, { force: true });
    await rename(temporaryPath, path);
  } catch (error) {
    // Another concurrent sync may have promoted the identical digest between
    // our existence check and rename. Trust only a freshly revalidated entry.
    const concurrent = await readCachedSkillPackageArchive({
      ...(input.dataDir !== undefined ? { dataDir: input.dataDir } : {}),
      packageSha256: archive.packageSha256,
    });
    if (!concurrent) throw error;
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  return path;
}

export async function readCachedSkillPackageArchive(
  input: ReadCachedSkillPackageArchiveInput,
): Promise<SkillPackageArchive | null> {
  const packageSha256 = normalizeSha256(input.packageSha256);
  const path = skillPackageCachePath(input.dataDir, packageSha256);
  if (!(await exists(path))) return null;

  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as SkillPackageArchive;
    return validateArchiveForCache(parsed, packageSha256);
  } catch {
    return null;
  }
}

export async function getOrCacheSkillPackageArchive(
  input: GetOrCacheSkillPackageArchiveInput,
): Promise<SkillPackageArchive> {
  const cached = await readCachedSkillPackageArchive(input);
  if (cached) return cached;

  const fetched = validateArchiveForCache(await input.fetchPackage(), input.packageSha256);
  await cacheSkillPackageArchive({
    archive: fetched,
    ...(input.dataDir !== undefined ? { dataDir: input.dataDir } : {}),
  });
  return fetched;
}

export async function pruneSkillPackageCache(
  input: PruneSkillPackageCacheInput,
): Promise<PruneSkillPackageCacheResult> {
  const cacheDir = skillPackageCacheDir(input.dataDir);
  if (!(await exists(cacheDir))) return { removedPackageSha256s: [] };

  const referenced = new Set(input.referencedPackageSha256s.map(normalizeSha256));
  const removedPackageSha256s: string[] = [];
  const entries = (await readdir(cacheDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  for (const entry of entries) {
    const packageSha256 = entry.slice(0, -".json".length).toLowerCase();
    if (!SHA256_PATTERN.test(packageSha256) || referenced.has(packageSha256)) continue;
    await rm(join(cacheDir, entry), { force: true });
    removedPackageSha256s.push(packageSha256);
  }

  return { removedPackageSha256s };
}
