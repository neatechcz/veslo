import type {
  VesloAutomation,
  VesloAutomationCreatePayload,
  VesloAutomationRun,
  VesloAutomationUpdatePayload,
} from "../../types";

type RequestJsonOptions = {
  method?: string;
  token?: string;
  hostToken?: string;
  body?: unknown;
  timeoutMs?: number;
};

export type AutomationsClientContext = {
  baseUrl: string;
  token?: string;
  hostToken?: string;
  requestJson: <T>(baseUrl: string, path: string, options?: RequestJsonOptions) => Promise<T>;
};

const workspaceAutomationsPath = (workspaceId: string) =>
  `/workspace/${encodeURIComponent(workspaceId)}/automations`;

const workspaceAutomationPath = (workspaceId: string, automationId: string) =>
  `${workspaceAutomationsPath(workspaceId)}/${encodeURIComponent(automationId)}`;

export function createAutomationsClient(context: AutomationsClientContext) {
  const { baseUrl, token, hostToken, requestJson } = context;

  return {
    list: (workspaceId: string) =>
      requestJson<{ items: VesloAutomation[]; updatedAt: string }>(
        baseUrl,
        workspaceAutomationsPath(workspaceId),
        { token, hostToken },
      ),

    create: (workspaceId: string, payload: VesloAutomationCreatePayload) =>
      requestJson<{ automation: VesloAutomation }>(
        baseUrl,
        workspaceAutomationsPath(workspaceId),
        { token, hostToken, method: "POST", body: payload },
      ),

    update: (workspaceId: string, automationId: string, payload: VesloAutomationUpdatePayload) =>
      requestJson<{ automation: VesloAutomation }>(
        baseUrl,
        workspaceAutomationPath(workspaceId, automationId),
        { token, hostToken, method: "PATCH", body: payload },
      ),

    delete: (workspaceId: string, automationId: string) =>
      requestJson<{ automation: VesloAutomation }>(
        baseUrl,
        workspaceAutomationPath(workspaceId, automationId),
        { token, hostToken, method: "DELETE" },
      ),

    run: (workspaceId: string, automationId: string) =>
      requestJson<{ run: VesloAutomationRun }>(
        baseUrl,
        `${workspaceAutomationPath(workspaceId, automationId)}/run`,
        { token, hostToken, method: "POST" },
      ),

    listRuns: (workspaceId: string, automationId: string) =>
      requestJson<{ items: VesloAutomationRun[] }>(
        baseUrl,
        `${workspaceAutomationPath(workspaceId, automationId)}/runs`,
        { token, hostToken },
      ),
  };
}

export type AutomationsClient = ReturnType<typeof createAutomationsClient>;
