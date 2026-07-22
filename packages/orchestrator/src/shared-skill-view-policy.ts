/**
 * In the legacy shared-engine fallback, most reads must stay passive so they
 * cannot cold-start an engine. `/event` is the exception: it is a long-lived
 * stream whose target engine must already carry the caller's skill view.
 */
export function requiresSharedSkillViewForProxy(method: string, targetPath: string): boolean {
  const normalizedMethod = method.trim().toUpperCase();
  if (normalizedMethod !== "GET" && normalizedMethod !== "HEAD") return true;
  return normalizedMethod === "GET" && /^\/event\/?$/.test(targetPath);
}

/**
 * Event-stream clients are not guaranteed to carry the server-owned runtime
 * view revision. Read only the already-published manifest so their initial
 * shared-engine selection agrees with the following prompt submit.
 */
export async function readPublishedSharedSkillViewRevision(workspacePath: string): Promise<string | undefined> {
  try {
    const workspaceRoot = resolve(workspacePath);
    const manifest = JSON.parse(
      await readFile(join(workspaceRoot, ".opencode", "veslo.runtime.skills.json"), "utf8"),
    ) as {
      schemaVersion?: unknown;
      workspaceRoot?: unknown;
      revision?: unknown;
    };
    if (
      (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) ||
      typeof manifest.workspaceRoot !== "string" ||
      resolve(manifest.workspaceRoot) !== workspaceRoot ||
      typeof manifest.revision !== "string"
    ) {
      return undefined;
    }
    const revision = manifest.revision.trim();
    return revision || undefined;
  } catch {
    return undefined;
  }
}
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
