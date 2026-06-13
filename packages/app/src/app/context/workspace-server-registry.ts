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
    const client = deps.vesloServerClient?.();
    const hostInfo = deps.vesloServerHostInfo?.();
    const currentToken = hostInfo?.clientToken?.trim() ?? "";
    const currentBaseUrl = (
      hostInfo?.engineUrl?.trim() ||
      hostInfo?.baseUrl?.trim() ||
      ""
    ).replace(/\/+$/, "");
    if (!client || !currentToken) return;
    let serverItems: Array<{ id: string; workspaceType?: string; path?: string }> = [];
    try {
      const response = await client.listWorkspaces();
      serverItems = Array.isArray(response.items) ? response.items : [];
    } catch {
      return;
    }
    for (const ws of serverItems) {
      if (ws.workspaceType !== "local" || !ws.id) continue;
      try {
        const config = await client.getConfig(ws.id);
        const opencode = (config.opencode ?? {}) as Record<string, unknown>;
        const provider = opencode.provider;
        if (!provider || typeof provider !== "object") continue;
        let changed = false;
        for (const entry of Object.values(provider as Record<string, unknown>)) {
          if (!entry || typeof entry !== "object") continue;
          const opts = (entry as Record<string, unknown>).options;
          if (!opts || typeof opts !== "object") continue;
          const optsRecord = opts as Record<string, unknown>;
          if (
            typeof optsRecord.apiKey === "string" &&
            optsRecord.apiKey !== currentToken
          ) {
            optsRecord.apiKey = currentToken;
            changed = true;
          }
          if (
            currentBaseUrl &&
            typeof optsRecord.baseURL === "string"
          ) {
            const rest = optsRecord.baseURL.replace(/^https?:\/\/[^/]+/, "");
            const next = `${currentBaseUrl}${rest}`;
            if (optsRecord.baseURL !== next) {
              optsRecord.baseURL = next;
              changed = true;
            }
          }
        }
        if (changed) {
          await client.patchConfig(ws.id, { opencode });
        }
      } catch (err) {
        deps.wsDebug("reconcileManagedAiApiKeys:skip", {
          workspaceId: ws.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
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
