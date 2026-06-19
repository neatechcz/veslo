import type { WorkspaceInfo } from "../lib/tauri";
import type { VesloServerClient } from "../lib/veslo-server";
import { normalizeDirectoryPath } from "../utils";

export type WorkspaceServerRegistryDeps = {
  getWorkspaces: () => WorkspaceInfo[];
  vesloServerClient?: () => VesloServerClient | null;
  vesloServerHostInfo?: () => {
    baseUrl?: string | null;
    engineUrl?: string | null;
    clientToken?: string | null;
  } | null;
  wsDebug: (label: string, payload?: unknown) => void;
};

export function createWorkspaceServerRegistry(deps: WorkspaceServerRegistryDeps) {
  const addLocalWorkspaceOnServer = async (path: string, name?: string) => {
    const client = deps.vesloServerClient?.();
    if (!client) return;
    const trimmed = path.trim();
    if (!trimmed) return;
    try {
      await client.addLocalWorkspace({ path: trimmed, name: name?.trim() || undefined });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/workspace_exists|409/i.test(message)) {
        deps.wsDebug("addLocalWorkspaceOnServer:failed", { path: trimmed, error: message });
      }
    }
  };

  const activateVesloHostWorkspace = async (workspacePath: string) => {
    const client = deps.vesloServerClient?.();
    if (!client) return;
    const targetPath = normalizeDirectoryPath(workspacePath);
    if (!targetPath) return;
    try {
      const response = await client.listWorkspaces();
      const items = Array.isArray(response.items) ? response.items : [];
      let match = items.find((entry) => normalizeDirectoryPath(entry.path) === targetPath);
      if (!match) {
        const local = deps.getWorkspaces().find(
          (w) =>
            w.workspaceType === "local" &&
            normalizeDirectoryPath(w.path?.trim() ?? "") === targetPath,
        );
        if (local?.path) {
          await addLocalWorkspaceOnServer(local.path, local.displayName?.trim() || local.name?.trim());
          const refreshed = await client.listWorkspaces();
          const refreshedItems = Array.isArray(refreshed.items) ? refreshed.items : [];
          match = refreshedItems.find((entry) => normalizeDirectoryPath(entry.path) === targetPath);
          if (refreshed.activeId === match?.id) return;
        }
      }
      if (!match?.id) return;
      if (response.activeId === match.id) return;
      await client.activateWorkspace(match.id);
    } catch {
      // ignore
    }
  };

  const reconcileManagedAiApiKeys = async () => {
    // Managed AI config writes are owned by the app-level managed config sync,
    // which has the full profile, gateway token, and inactive-workspace guards.
    deps.wsDebug("reconcileManagedAiApiKeys:skip", {
      reason: "managed-config-owned-by-app-sync",
    });
  };

  const reconcileVesloServerWorkspaces = async () => {
    const client = deps.vesloServerClient?.();
    if (!client) return;
    let knownPaths = new Set<string>();
    try {
      const response = await client.listWorkspaces();
      const items = Array.isArray(response.items) ? response.items : [];
      knownPaths = new Set(items.map((entry) => normalizeDirectoryPath(entry.path)));
    } catch {
      return;
    }
    const missing = deps.getWorkspaces().filter((w) => {
      if (w.workspaceType !== "local") return false;
      const path = normalizeDirectoryPath(w.path?.trim() ?? "");
      return path.length > 0 && !knownPaths.has(path);
    });
    for (const w of missing) {
      if (!w.path) continue;
      await addLocalWorkspaceOnServer(w.path, w.displayName?.trim() || w.name?.trim());
    }
    await reconcileManagedAiApiKeys();
  };

  return {
    activateVesloHostWorkspace,
    addLocalWorkspaceOnServer,
    reconcileVesloServerWorkspaces,
    reconcileManagedAiApiKeys,
  };
}
