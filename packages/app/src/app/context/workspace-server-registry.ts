import type { WorkspaceInfo } from "../lib/tauri";
import { VesloServerError, type VesloServerClient } from "../lib/veslo-server";
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

type WorkspaceRegistrySyncResult =
  | { ok: true; workspaceId?: string | null; path?: string | null }
  | { ok: false; reason: string; error?: string };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function workspaceExistsDetails(err: unknown): { id: string; path: string } | null {
  if (!(err instanceof VesloServerError) || err.status !== 409 || err.code !== "workspace_exists") {
    return null;
  }
  const details = err.details && typeof err.details === "object"
    ? err.details as { id?: unknown; path?: unknown }
    : null;
  const id = typeof details?.id === "string" ? details.id.trim() : "";
  const path = typeof details?.path === "string" ? details.path.trim() : "";
  return id && path ? { id, path } : null;
}

function workspaceRegistryUnsynced(reason: string, details?: Record<string, unknown>): Error {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  return new Error(`workspace_registry_unsynced:${reason}${suffix}`);
}

export function createWorkspaceServerRegistry(deps: WorkspaceServerRegistryDeps) {
  const addLocalWorkspaceOnServer = async (
    path: string,
    name?: string,
  ): Promise<WorkspaceRegistrySyncResult> => {
    const client = deps.vesloServerClient?.();
    if (!client) {
      return { ok: false, reason: "server_client_unavailable" };
    }
    const trimmed = path.trim();
    if (!trimmed) {
      return { ok: false, reason: "empty_path" };
    }
    try {
      const response = await client.addLocalWorkspace({ path: trimmed, name: name?.trim() || undefined });
      return {
        ok: true,
        workspaceId: response.workspace?.id ?? response.activeId ?? null,
        path: response.workspace?.path ?? trimmed,
      };
    } catch (err) {
      const existing = workspaceExistsDetails(err);
      if (existing) {
        return {
          ok: true,
          workspaceId: existing.id,
          path: existing.path,
        };
      }
      const message = errorMessage(err);
      deps.wsDebug("addLocalWorkspaceOnServer:failed", { path: trimmed, error: message });
      return { ok: false, reason: "add_failed", error: message };
    }
  };

  const activateVesloHostWorkspace = async (workspacePath: string) => {
    const client = deps.vesloServerClient?.();
    if (!client) {
      throw workspaceRegistryUnsynced("server_client_unavailable", { workspacePath });
    }
    const targetPath = normalizeDirectoryPath(workspacePath);
    if (!targetPath) {
      throw workspaceRegistryUnsynced("empty_workspace_path");
    }
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
          const registration = await addLocalWorkspaceOnServer(
            local.path,
            local.displayName?.trim() || local.name?.trim(),
          );
          if (!registration.ok) {
            throw workspaceRegistryUnsynced("registration_failed", {
              path: local.path,
              reason: registration.reason,
              error: registration.error,
            });
          }
          const refreshed = await client.listWorkspaces();
          const refreshedItems = Array.isArray(refreshed.items) ? refreshed.items : [];
          match = refreshedItems.find((entry) => normalizeDirectoryPath(entry.path) === targetPath);
          if (refreshed.activeId === match?.id) return;
        }
      }
      if (!match?.id) {
        throw workspaceRegistryUnsynced("workspace_not_registered", { workspacePath: targetPath });
      }
      if (response.activeId === match.id) return;
      await client.activateWorkspace(match.id);
    } catch (err) {
      const message = errorMessage(err);
      deps.wsDebug("activateVesloHostWorkspace:failed", { path: targetPath, error: message });
      if (message.startsWith("workspace_registry_unsynced:")) {
        throw err;
      }
      throw workspaceRegistryUnsynced("activation_failed", { path: targetPath, error: message });
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
    if (missing.length > 0) {
      deps.wsDebug("reconcileVesloServerWorkspaces:workspace_registry_unsynced", {
        missing: missing.map((w) => ({
          id: w.id,
          path: w.path,
          name: w.displayName?.trim() || w.name?.trim() || null,
        })),
      });
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
