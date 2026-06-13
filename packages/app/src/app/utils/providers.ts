import type { Provider as ConfigProvider, ProviderListResponse } from "@opencode-ai/sdk/v2/client";

type ProviderListItem = ProviderListResponse["all"][number];
type ProviderListModel = ProviderListItem["models"][string];

type ProviderConnectionItem = Pick<ProviderListItem, "id" | "env">;

export const LM_STUDIO_PROVIDER_ID = "lmstudio";
export const LM_STUDIO_PROVIDER_NAME = "LM Studio (local)";
export const LM_STUDIO_PROVIDER_NPM = "@ai-sdk/openai-compatible";
export const LM_STUDIO_DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";
export const GATEWAY_OWNED_PROVIDER_IDS = ["openai", "anthropic", "codex_oauth", "openai_compatible"] as const;

export type GatewayOwnedProviderId = (typeof GATEWAY_OWNED_PROVIDER_IDS)[number];

const GATEWAY_OWNED_PROVIDER_SET = new Set<string>(GATEWAY_OWNED_PROVIDER_IDS);

export const resolveLmStudioBaseUrl = (
  explicitInput?: string | null,
  configuredBaseUrl?: string | null,
) => {
  const explicit = explicitInput?.trim() ?? "";
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }

  const configured = configuredBaseUrl?.trim() ?? "";
  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  return LM_STUDIO_DEFAULT_BASE_URL;
};

export const isGatewayOwnedProvider = (
  providerId?: string | null,
): providerId is GatewayOwnedProviderId => GATEWAY_OWNED_PROVIDER_SET.has(providerId?.trim().toLowerCase() ?? "");

export const isGatewayOAuthProvider = (providerId?: string | null) =>
  (providerId?.trim().toLowerCase() ?? "") === "openai";

export const isGatewayApiKeyProvider = (providerId?: string | null) =>
  (providerId?.trim().toLowerCase() ?? "") === "anthropic";

export const isApiCredentialRequired = (providerId?: string | null) =>
  (providerId?.trim().toLowerCase() ?? "") !== LM_STUDIO_PROVIDER_ID;

export const mergeConnectedProviderIds = (...groups: Array<readonly (string | null | undefined)[]>) => {
  const merged = new Set<string>();
  for (const group of groups) {
    for (const value of group ?? []) {
      const trimmed = value?.trim();
      if (!trimmed) continue;
      merged.add(trimmed);
    }
  }
  return Array.from(merged);
};

export const extractOpenAiCompatibleModelIds = (payload: unknown) => {
  if (!payload || typeof payload !== "object") return [] as string[];

  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [] as string[];

  const ids = new Set<string>();
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (!trimmed) continue;
    ids.add(trimmed);
  }

  return Array.from(ids);
};

const normalizeModelStatus = (value: unknown): ProviderListModel["status"] => {
  return value === "alpha" || value === "beta" || value === "deprecated" ? value : undefined;
};

const normalizeProviderModels = (models: ConfigProvider["models"] | undefined): ProviderListItem["models"] => {
  const next: ProviderListItem["models"] = {};
  for (const [modelId, model] of Object.entries(models ?? {})) {
    const record = model as Record<string, unknown>;
    const capabilities = (record.capabilities && typeof record.capabilities === "object")
      ? record.capabilities as Record<string, unknown>
      : {};
    const input = (capabilities.input && typeof capabilities.input === "object")
      ? capabilities.input as Record<string, unknown>
      : {};

    next[modelId] = {
      ...model,
      id: model.id ?? modelId,
      name: model.name ?? model.id ?? modelId,
      release_date: model.release_date ?? "",
      attachment: Boolean(record.attachment ?? capabilities.attachment ?? input.image),
      reasoning: Boolean(record.reasoning ?? capabilities.reasoning),
      temperature: Boolean(record.temperature ?? capabilities.temperature),
      tool_call: Boolean(record.tool_call ?? record.toolcall ?? capabilities.tool_call ?? capabilities.toolcall),
      status: normalizeModelStatus(record.status),
    };
  }
  return next;
};

export const mapConfigProvidersToList = (providers: ConfigProvider[]): ProviderListResponse["all"] =>
  providers.map((provider) => ({
    id: provider.id,
    name: provider.name ?? provider.id,
    env: provider.env ?? [],
    models: normalizeProviderModels(provider.models),
  }));

export const resolveEffectiveConnectedProviderIds = (
  providers: ProviderConnectionItem[],
  connectedIds: string[],
) => {
  const next = new Set(
    (connectedIds ?? []).map((id) => id.trim()).filter(Boolean),
  );

  for (const provider of providers ?? []) {
    const providerId = provider?.id?.trim();
    if (!providerId) continue;

    const requiredEnv = Array.isArray(provider.env)
      ? provider.env.filter((envName) => envName.trim().length > 0)
      : [];
    if (requiredEnv.length === 0) {
      next.add(providerId);
    }
  }

  return Array.from(next);
};
