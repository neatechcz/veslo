import type {
  VesloOpenCodeRouterBindingUpdateResult,
  VesloOpenCodeRouterBindingsResult,
  VesloOpenCodeRouterHealthSnapshot,
  VesloOpenCodeRouterSendResult,
  VesloOpenCodeRouterSlackIdentitiesResult,
  VesloOpenCodeRouterSlackIdentityDeleteResult,
  VesloOpenCodeRouterSlackIdentityUpsertResult,
  VesloOpenCodeRouterSlackResult,
  VesloOpenCodeRouterTelegramEnabledResult,
  VesloOpenCodeRouterTelegramIdentitiesResult,
  VesloOpenCodeRouterTelegramIdentityDeleteResult,
  VesloOpenCodeRouterTelegramIdentityUpsertResult,
  VesloOpenCodeRouterTelegramInfo,
  VesloOpenCodeRouterTelegramResult,
} from "../veslo-server/types";

type RawJsonResponse<T> = {
  ok: boolean;
  status: number;
  json: T | null;
};

type RequestJsonOptions = {
  method?: string;
  token?: string;
  hostToken?: string;
  body?: unknown;
  timeoutMs?: number;
};

type RequestJsonRawOptions = {
  method?: string;
  token?: string;
  hostToken?: string;
  body?: unknown;
  timeoutMs?: number;
};

export type MessagingIdentitiesClientContext = {
  baseUrl: string;
  token?: string;
  hostToken?: string;
  timeoutMs: number;
  mountedWorkspaceId: string | null;
  requestJson: <T>(baseUrl: string, path: string, options?: RequestJsonOptions) => Promise<T>;
  requestJsonRaw: <T>(baseUrl: string, path: string, options?: RequestJsonRawOptions) => Promise<RawJsonResponse<T>>;
  isNotFoundError: (error: unknown) => boolean;
};

const OPENCODE_ROUTER_API_PREFIX = "/opencode-router";

const ensureLeadingSlash = (path: string) => (path.startsWith("/") ? path : `/${path}`);

const openCodeRouterApiPath = (path: string) =>
  `${OPENCODE_ROUTER_API_PREFIX}${ensureLeadingSlash(path)}`;

const workspaceOpenCodeRouterApiPath = (workspaceId: string, path: string) =>
  `/workspace/${encodeURIComponent(workspaceId)}${openCodeRouterApiPath(path)}`;

const mountedWorkspaceOpenCodeRouterApiPath = (workspaceId: string, path: string) =>
  `/w/${encodeURIComponent(workspaceId)}${openCodeRouterApiPath(path)}`;

const healthPortQuery = (healthPort?: number | null) =>
  typeof healthPort === "number" ? `?healthPort=${encodeURIComponent(String(healthPort))}` : "";

export function createMessagingIdentitiesClient(context: MessagingIdentitiesClientContext) {
  const { baseUrl, token, hostToken, timeoutMs, mountedWorkspaceId, requestJson, requestJsonRaw, isNotFoundError } = context;

  return {
    health: () =>
      requestJsonRaw<VesloOpenCodeRouterHealthSnapshot>(baseUrl, openCodeRouterApiPath("health"), {
        token,
        hostToken,
        timeoutMs,
      }),

    bindings: (filters?: { channel?: string; identityId?: string }) => {
      const search = new URLSearchParams();
      if (filters?.channel?.trim()) search.set("channel", filters.channel.trim());
      if (filters?.identityId?.trim()) search.set("identityId", filters.identityId.trim());
      const suffix = search.toString();
      const path = `${openCodeRouterApiPath("bindings")}${suffix ? `?${suffix}` : ""}`;
      return requestJsonRaw<VesloOpenCodeRouterBindingsResult>(baseUrl, path, { token, hostToken, timeoutMs });
    },

    telegramIdentities: () =>
      requestJsonRaw<VesloOpenCodeRouterTelegramIdentitiesResult>(baseUrl, openCodeRouterApiPath("identities/telegram"), {
        token,
        hostToken,
        timeoutMs,
      }),

    slackIdentities: () =>
      requestJsonRaw<VesloOpenCodeRouterSlackIdentitiesResult>(baseUrl, openCodeRouterApiPath("identities/slack"), {
        token,
        hostToken,
        timeoutMs,
      }),

    setTelegramToken: (workspaceId: string, tokenValue: string, healthPort?: number | null) =>
      requestJson<VesloOpenCodeRouterTelegramResult>(
        baseUrl,
        workspaceOpenCodeRouterApiPath(workspaceId, "telegram-token"),
        {
          token,
          hostToken,
          method: "POST",
          body: { token: tokenValue, healthPort },
          timeoutMs,
        },
      ),

    setSlackTokens: (workspaceId: string, botToken: string, appToken: string, healthPort?: number | null) =>
      requestJson<VesloOpenCodeRouterSlackResult>(
        baseUrl,
        workspaceOpenCodeRouterApiPath(workspaceId, "slack-tokens"),
        {
          token,
          hostToken,
          method: "POST",
          body: { botToken, appToken, healthPort },
          timeoutMs,
        },
      ),

    getTelegram: (workspaceId: string) =>
      requestJson<VesloOpenCodeRouterTelegramInfo>(
        baseUrl,
        workspaceOpenCodeRouterApiPath(workspaceId, "telegram"),
        { token, hostToken, timeoutMs },
      ),

    getTelegramIdentities: (workspaceId: string, options?: { healthPort?: number | null }) =>
      requestJson<VesloOpenCodeRouterTelegramIdentitiesResult>(
        baseUrl,
        `${workspaceOpenCodeRouterApiPath(workspaceId, "identities/telegram")}${healthPortQuery(options?.healthPort)}`,
        { token, hostToken, timeoutMs },
      ),

    upsertTelegramIdentity: (
      workspaceId: string,
      input: { id?: string; token: string; enabled?: boolean; access?: "public" | "private"; pairingCode?: string },
      options?: { healthPort?: number | null },
    ) =>
      requestJson<VesloOpenCodeRouterTelegramIdentityUpsertResult>(
        baseUrl,
        workspaceOpenCodeRouterApiPath(workspaceId, "identities/telegram"),
        {
          token,
          hostToken,
          method: "POST",
          body: {
            ...(input.id?.trim() ? { id: input.id.trim() } : {}),
            token: input.token,
            ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
            ...(input.access ? { access: input.access } : {}),
            ...(input.pairingCode?.trim() ? { pairingCode: input.pairingCode.trim() } : {}),
            healthPort: options?.healthPort ?? null,
          },
          timeoutMs,
        },
      ),

    deleteTelegramIdentity: (workspaceId: string, identityId: string, options?: { healthPort?: number | null }) =>
      requestJson<VesloOpenCodeRouterTelegramIdentityDeleteResult>(
        baseUrl,
        `${workspaceOpenCodeRouterApiPath(workspaceId, `identities/telegram/${encodeURIComponent(identityId)}`)}${healthPortQuery(options?.healthPort)}`,
        { token, hostToken, method: "DELETE", timeoutMs },
      ),

    getSlackIdentities: (workspaceId: string, options?: { healthPort?: number | null }) =>
      requestJson<VesloOpenCodeRouterSlackIdentitiesResult>(
        baseUrl,
        `${workspaceOpenCodeRouterApiPath(workspaceId, "identities/slack")}${healthPortQuery(options?.healthPort)}`,
        { token, hostToken, timeoutMs },
      ),

    upsertSlackIdentity: (
      workspaceId: string,
      input: { id?: string; botToken: string; appToken: string; enabled?: boolean },
      options?: { healthPort?: number | null },
    ) =>
      requestJson<VesloOpenCodeRouterSlackIdentityUpsertResult>(
        baseUrl,
        workspaceOpenCodeRouterApiPath(workspaceId, "identities/slack"),
        {
          token,
          hostToken,
          method: "POST",
          body: {
            ...(input.id?.trim() ? { id: input.id.trim() } : {}),
            botToken: input.botToken,
            appToken: input.appToken,
            ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
            healthPort: options?.healthPort ?? null,
          },
          timeoutMs,
        },
      ),

    deleteSlackIdentity: (workspaceId: string, identityId: string, options?: { healthPort?: number | null }) =>
      requestJson<VesloOpenCodeRouterSlackIdentityDeleteResult>(
        baseUrl,
        `${workspaceOpenCodeRouterApiPath(workspaceId, `identities/slack/${encodeURIComponent(identityId)}`)}${healthPortQuery(options?.healthPort)}`,
        { token, hostToken, method: "DELETE", timeoutMs },
      ),

    getBindings: (
      workspaceId: string,
      filters?: { channel?: string; identityId?: string; healthPort?: number | null },
    ) => {
      const search = new URLSearchParams();
      if (filters?.channel?.trim()) search.set("channel", filters.channel.trim());
      if (filters?.identityId?.trim()) search.set("identityId", filters.identityId.trim());
      if (typeof filters?.healthPort === "number") search.set("healthPort", String(filters.healthPort));
      const suffix = search.toString();
      return requestJson<VesloOpenCodeRouterBindingsResult>(
        baseUrl,
        `${workspaceOpenCodeRouterApiPath(workspaceId, "bindings")}${suffix ? `?${suffix}` : ""}`,
        { token, hostToken, timeoutMs },
      );
    },

    setBinding: (
      workspaceId: string,
      input: { channel: string; identityId?: string; peerId: string; directory?: string },
      options?: { healthPort?: number | null },
    ) =>
      requestJson<VesloOpenCodeRouterBindingUpdateResult>(
        baseUrl,
        workspaceOpenCodeRouterApiPath(workspaceId, "bindings"),
        {
          token,
          hostToken,
          method: "POST",
          body: {
            channel: input.channel,
            ...(input.identityId?.trim() ? { identityId: input.identityId.trim() } : {}),
            peerId: input.peerId,
            ...(input.directory?.trim() ? { directory: input.directory.trim() } : {}),
            healthPort: options?.healthPort ?? null,
          },
          timeoutMs,
        },
      ),

    sendMessage: (
      workspaceId: string,
      input: {
        channel: "telegram" | "slack";
        text: string;
        identityId?: string;
        directory?: string;
        peerId?: string;
        autoBind?: boolean;
      },
      options?: { healthPort?: number | null },
    ) => {
      const payload = {
        channel: input.channel,
        text: input.text,
        ...(input.identityId?.trim() ? { identityId: input.identityId.trim() } : {}),
        ...(input.directory?.trim() ? { directory: input.directory.trim() } : {}),
        ...(input.peerId?.trim() ? { peerId: input.peerId.trim() } : {}),
        ...(input.autoBind === true ? { autoBind: true } : {}),
        healthPort: options?.healthPort ?? null,
      };

      const primaryPath = workspaceOpenCodeRouterApiPath(workspaceId, "send");
      const fallbackPath =
        mountedWorkspaceId && mountedWorkspaceId === workspaceId
          ? openCodeRouterApiPath("send")
          : mountedWorkspaceOpenCodeRouterApiPath(workspaceId, "send");

      return requestJson<VesloOpenCodeRouterSendResult>(baseUrl, primaryPath, {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs,
      }).catch(async (error) => {
        if (!isNotFoundError(error)) {
          throw error;
        }
        return requestJson<VesloOpenCodeRouterSendResult>(baseUrl, fallbackPath, {
          token,
          hostToken,
          method: "POST",
          body: payload,
          timeoutMs,
        });
      });
    },

    setTelegramEnabled: (
      workspaceId: string,
      enabled: boolean,
      options?: { clearToken?: boolean; healthPort?: number | null },
    ) =>
      requestJson<VesloOpenCodeRouterTelegramEnabledResult>(
        baseUrl,
        workspaceOpenCodeRouterApiPath(workspaceId, "telegram-enabled"),
        {
          token,
          hostToken,
          method: "POST",
          body: { enabled, clearToken: options?.clearToken ?? false, healthPort: options?.healthPort ?? null },
          timeoutMs,
        },
      ),
  };
}

export type MessagingIdentitiesClient = ReturnType<typeof createMessagingIdentitiesClient>;
