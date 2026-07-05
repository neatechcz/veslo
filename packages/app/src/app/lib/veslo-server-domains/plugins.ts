import type {
  VesloPluginListResponse,
  VesloPluginMaterializationSyncResult,
  VesloPluginMutationResponse,
} from "../veslo-server/types";
import { workspacePath } from "./path";

type RequestJsonOptions = {
  method?: string;
  token?: string;
  hostToken?: string;
  body?: unknown;
  timeoutMs?: number;
};

export type PluginsClientContext = {
  baseUrl: string;
  token?: string;
  hostToken?: string;
  requestJson: <T>(baseUrl: string, path: string, options?: RequestJsonOptions) => Promise<T>;
};

const workspacePluginsPath = (workspaceId: string) => `${workspacePath(workspaceId)}/plugins`;

function buildPluginsListPath(workspaceId: string, options?: { includeGlobal?: boolean; debug?: boolean }) {
  const queryParams = new URLSearchParams();
  if (options?.includeGlobal) queryParams.set("includeGlobal", "true");
  if (options?.debug) queryParams.set("debug", "true");
  const query = queryParams.toString();
  return `${workspacePluginsPath(workspaceId)}${query ? `?${query}` : ""}`;
}

export function createPluginsClient(context: PluginsClientContext) {
  const { baseUrl, token, hostToken, requestJson } = context;

  return {
    list: (workspaceId: string, options?: { includeGlobal?: boolean; debug?: boolean }) =>
      requestJson<VesloPluginListResponse>(
        baseUrl,
        buildPluginsListPath(workspaceId, options),
        { token, hostToken },
      ),

    syncMaterialization: (workspaceId: string) =>
      requestJson<VesloPluginMaterializationSyncResult>(
        baseUrl,
        `${workspacePluginsPath(workspaceId)}/materialization/sync`,
        { token, hostToken, method: "POST" },
      ),

    setEnabled: (workspaceId: string, pluginId: string, enabled: boolean) =>
      requestJson<VesloPluginMutationResponse>(
        baseUrl,
        `${workspacePluginsPath(workspaceId)}/${encodeURIComponent(pluginId)}/enabled`,
        { token, hostToken, method: "POST", body: { enabled } },
      ),

    add: (workspaceId: string, spec: string) =>
      requestJson<VesloPluginListResponse>(
        baseUrl,
        workspacePluginsPath(workspaceId),
        { token, hostToken, method: "POST", body: { spec } },
      ),

    remove: (workspaceId: string, name: string) =>
      requestJson<VesloPluginListResponse>(
        baseUrl,
        `${workspacePluginsPath(workspaceId)}/${encodeURIComponent(name)}`,
        { token, hostToken, method: "DELETE" },
      ),

    removeManaged: (workspaceId: string, pluginId: string) =>
      requestJson<VesloPluginMutationResponse>(
        baseUrl,
        `${workspacePluginsPath(workspaceId)}/${encodeURIComponent(pluginId)}`,
        { token, hostToken, method: "DELETE" },
      ),

    restore: (workspaceId: string, pluginId: string) =>
      requestJson<VesloPluginMutationResponse>(
        baseUrl,
        `${workspacePluginsPath(workspaceId)}/${encodeURIComponent(pluginId)}/restore`,
        { token, hostToken, method: "POST" },
      ),
  };
}

export type PluginsClient = ReturnType<typeof createPluginsClient>;
