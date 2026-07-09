import type { VesloHubMcpItem, VesloMcpItem } from "../veslo-server/types";
import { buildDenContextHeaders } from "../veslo-server/header-profiles";
import { workspacePath } from "./path";

type RequestJsonOptions = {
  method?: string;
  token?: string;
  hostToken?: string;
  body?: unknown;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
};

export type McpClientContext = {
  baseUrl: string;
  token?: string;
  hostToken?: string;
  requestJson: <T>(baseUrl: string, path: string, options?: RequestJsonOptions) => Promise<T>;
};

type DenContextOptions = {
  denApiBase?: string;
  denToken?: string;
  denOrgId?: string;
};

const workspaceMcpPath = (workspaceId: string) => `${workspacePath(workspaceId)}/mcp`;

export function createMcpClient(context: McpClientContext) {
  const { baseUrl, token, hostToken, requestJson } = context;

  return {
    listHub: (options?: DenContextOptions) =>
      requestJson<{ items: VesloHubMcpItem[] }>(baseUrl, "/hub/mcp", {
        token,
        hostToken,
        extraHeaders: buildDenContextHeaders(options),
      }),

    installHub: (workspaceId: string, name: string, options?: DenContextOptions) =>
      requestJson<{ ok: boolean; name: string; action: "added" | "updated" }>(
        baseUrl,
        `${workspaceMcpPath(workspaceId)}/hub/${encodeURIComponent(name)}`,
        {
          token,
          hostToken,
          method: "POST",
          extraHeaders: buildDenContextHeaders(options),
        },
      ),

    list: (workspaceId: string) =>
      requestJson<{ items: VesloMcpItem[] }>(baseUrl, workspaceMcpPath(workspaceId), { token, hostToken }),

    add: (workspaceId: string, payload: { name: string; config: Record<string, unknown> }) =>
      requestJson<{ items: VesloMcpItem[] }>(baseUrl, workspaceMcpPath(workspaceId), {
        token,
        hostToken,
        method: "POST",
        body: payload,
      }),

    remove: (workspaceId: string, name: string) =>
      requestJson<{ items: VesloMcpItem[] }>(baseUrl, `${workspaceMcpPath(workspaceId)}/${encodeURIComponent(name)}`, {
        token,
        hostToken,
        method: "DELETE",
      }),

    refreshRuntimeToken: (workspaceId: string, name: string, options?: DenContextOptions) =>
      requestJson<{ ok: true; name: string; action: "updated"; expiresAt: string | null }>(
        baseUrl,
        `${workspaceMcpPath(workspaceId)}/${encodeURIComponent(name)}/runtime-token/refresh`,
        {
          token,
          hostToken,
          method: "POST",
          extraHeaders: buildDenContextHeaders(options),
        },
      ),

    logoutAuth: (workspaceId: string, name: string, options?: DenContextOptions) =>
      requestJson<{ ok: true }>(baseUrl, `${workspaceMcpPath(workspaceId)}/${encodeURIComponent(name)}/auth`, {
        token,
        hostToken,
        method: "DELETE",
        extraHeaders: buildDenContextHeaders(options),
      }),
  };
}

export type McpClient = ReturnType<typeof createMcpClient>;
