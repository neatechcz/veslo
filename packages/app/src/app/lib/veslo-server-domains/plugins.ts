import type { VesloPluginItem } from "../veslo-server/types";
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

export function createPluginsClient(context: PluginsClientContext) {
  const { baseUrl, token, hostToken, requestJson } = context;

  return {
    list: (workspaceId: string, options?: { includeGlobal?: boolean }) => {
      const query = options?.includeGlobal ? "?includeGlobal=true" : "";
      return requestJson<{ items: VesloPluginItem[]; loadOrder: string[] }>(
        baseUrl,
        `${workspacePluginsPath(workspaceId)}${query}`,
        { token, hostToken },
      );
    },

    add: (workspaceId: string, spec: string) =>
      requestJson<{ items: VesloPluginItem[]; loadOrder: string[] }>(
        baseUrl,
        workspacePluginsPath(workspaceId),
        { token, hostToken, method: "POST", body: { spec } },
      ),

    remove: (workspaceId: string, name: string) =>
      requestJson<{ items: VesloPluginItem[]; loadOrder: string[] }>(
        baseUrl,
        `${workspacePluginsPath(workspaceId)}/${encodeURIComponent(name)}`,
        { token, hostToken, method: "DELETE" },
      ),
  };
}

export type PluginsClient = ReturnType<typeof createPluginsClient>;
