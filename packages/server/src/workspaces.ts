import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { ServerConfig, WorkspaceConfig, WorkspaceInfo } from "./types.js";
import { shortId } from "./utils.js";

// Current server derivation hashes the resolved path string it receives.
// VSA10A golden vectors document where this agrees with or drifts from the
// desktop and orchestrator derivations; VSA10B/C move authority to server IDs.
export function workspaceIdForPath(path: string): string {
  const hash = createHash("sha1").update(path).digest("hex");
  return `ws-${hash.slice(0, 12)}`;
}

function normalizeConfiguredWorkspaceId(id: string | undefined): string | undefined {
  const trimmed = id?.trim();
  return trimmed || undefined;
}

export function buildWorkspaceInfos(
  workspaces: WorkspaceConfig[],
  cwd: string,
): WorkspaceInfo[] {
  return workspaces.map((workspace) => {
    const resolvedPath = resolve(cwd, workspace.path);
    return {
      id: normalizeConfiguredWorkspaceId(workspace.id) ?? workspaceIdForPath(resolvedPath),
      name: workspace.name ?? basename(resolvedPath),
      path: resolvedPath,
      workspaceType: workspace.workspaceType ?? "local",
      baseUrl: workspace.baseUrl,
      directory: workspace.directory,
      opencodeDbPath: workspace.opencodeDbPath,
      opencodeDataDir: workspace.opencodeDataDir,
      opencodeDataHome: workspace.opencodeDataHome,
      opencodeUsername: workspace.opencodeUsername,
      opencodePassword: workspace.opencodePassword,
      opencode: workspace.opencode,
    };
  });
}

/**
 * Convert in-memory WorkspaceInfo back to the persisted WorkspaceConfig shape
 * (drop derived fields like `id`, keep only what the file format defines).
 */
function serializeWorkspaceConfigEntry(workspace: WorkspaceInfo): WorkspaceConfig {
  return {
    path: workspace.path,
    ...(workspace.name ? { name: workspace.name } : {}),
    ...(workspace.workspaceType ? { workspaceType: workspace.workspaceType } : {}),
    ...(workspace.baseUrl ? { baseUrl: workspace.baseUrl } : {}),
    ...(workspace.directory ? { directory: workspace.directory } : {}),
    ...(workspace.opencodeDbPath ? { opencodeDbPath: workspace.opencodeDbPath } : {}),
    ...(workspace.opencodeDataDir ? { opencodeDataDir: workspace.opencodeDataDir } : {}),
    ...(workspace.opencodeDataHome ? { opencodeDataHome: workspace.opencodeDataHome } : {}),
    ...(workspace.opencodeUsername ? { opencodeUsername: workspace.opencodeUsername } : {}),
    ...(workspace.opencodePassword ? { opencodePassword: workspace.opencodePassword } : {}),
    ...(workspace.opencode ? { opencode: workspace.opencode } : {}),
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomically persist the current workspace list back to the server's config file.
 *
 * Behavior:
 * - No-op (returns false) when `config.configPath` is unset.
 * - Creates the config file if it doesn't exist yet (with a minimal stub that only
 *   contains the workspaces section), so first-time CRUD calls succeed.
 * - Reads the existing JSON (if any), merges in the updated `workspaces` and
 *   `authorizedRoots`, and writes via tmpfile + rename for crash-safety.
 *
 * Used by workspace CRUD endpoints to make their mutations durable across restarts.
 */
export async function persistServerWorkspaceState(config: ServerConfig): Promise<boolean> {
  const configPath = config.configPath?.trim() ?? "";
  if (!configPath) return false;

  let parsed: Record<string, unknown> = {};
  if (await fileExists(configPath)) {
    try {
      const raw = await readFile(configPath, "utf8");
      const json = JSON.parse(raw) as unknown;
      if (json && typeof json === "object" && !Array.isArray(json)) {
        parsed = json as Record<string, unknown>;
      }
    } catch {
      // Corrupt JSON — keep `parsed` empty so we overwrite with a clean shape.
      parsed = {};
    }
  }

  const next: Record<string, unknown> = {
    ...parsed,
    workspaces: config.workspaces.map(serializeWorkspaceConfigEntry),
    authorizedRoots: Array.from(new Set(config.authorizedRoots.map((root) => resolve(root)))),
  };

  await mkdir(dirname(configPath), { recursive: true });
  const tmpPath = `${configPath}.tmp.${shortId()}`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(tmpPath, configPath);
    return true;
  } finally {
    try {
      await rm(tmpPath, { force: true });
    } catch {
      // ignore — rename already moved the file or never created it
    }
  }
}
