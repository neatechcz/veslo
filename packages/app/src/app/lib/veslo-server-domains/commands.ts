import type { VesloCommandItem } from "../veslo-server";

type RequestJsonOptions = {
  method?: string;
  token?: string;
  hostToken?: string;
  body?: unknown;
  timeoutMs?: number;
};

export type CommandsClientContext = {
  baseUrl: string;
  token?: string;
  hostToken?: string;
  requestJson: <T>(baseUrl: string, path: string, options?: RequestJsonOptions) => Promise<T>;
};

export type CommandUpsertPayload = {
  name: string;
  description?: string;
  template: string;
  agent?: string;
  model?: string | null;
  subtask?: boolean;
};

const workspaceCommandsPath = (workspaceId: string) => `/workspace/${workspaceId}/commands`;

export function createCommandsClient(context: CommandsClientContext) {
  const { baseUrl, token, hostToken, requestJson } = context;

  return {
    list: (workspaceId: string, scope: "workspace" | "global" = "workspace") =>
      requestJson<{ items: VesloCommandItem[] }>(
        baseUrl,
        `${workspaceCommandsPath(workspaceId)}?scope=${scope}`,
        { token, hostToken },
      ),

    upsert: (workspaceId: string, payload: CommandUpsertPayload) =>
      requestJson<{ items: VesloCommandItem[] }>(
        baseUrl,
        workspaceCommandsPath(workspaceId),
        { token, hostToken, method: "POST", body: payload },
      ),

    delete: (workspaceId: string, name: string) =>
      requestJson<{ ok: boolean }>(
        baseUrl,
        `${workspaceCommandsPath(workspaceId)}/${encodeURIComponent(name)}`,
        { token, hostToken, method: "DELETE" },
      ),
  };
}

export type CommandsClient = ReturnType<typeof createCommandsClient>;
