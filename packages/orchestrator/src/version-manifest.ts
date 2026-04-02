import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type VersionInfo = {
  version: string;
  sha256: string;
};

export type VersionManifest = {
  dir: string;
  entries: Record<string, VersionInfo>;
};

export function manifestFileCandidates(platform: NodeJS.Platform, target?: string | null): string[] {
  const candidates = ["versions.json"];
  const trimmedTarget = target?.trim();
  if (!trimmedTarget) {
    return candidates;
  }

  candidates.push(`versions.json-${trimmedTarget}`);
  if (platform === "win32") {
    candidates.push(`versions.json-${trimmedTarget}.exe`);
  }

  return candidates;
}

export async function readVersionManifestFromDirs(
  dirs: string[],
  options: { platform?: NodeJS.Platform; target?: string | null } = {},
): Promise<VersionManifest | null> {
  const platform = options.platform ?? process.platform;
  const candidates = manifestFileCandidates(platform, options.target);

  for (const dir of dirs) {
    for (const candidate of candidates) {
      const manifestPath = join(dir, candidate);
      try {
        const payload = await readFile(manifestPath, "utf8");
        const entries = JSON.parse(payload) as Record<string, VersionInfo>;
        return { dir, entries };
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          continue;
        }
        return { dir, entries: {} };
      }
    }
  }

  return null;
}
