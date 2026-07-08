import type { Provider as ConfigProvider } from "@opencode-ai/sdk/v2/client";
import type { ProviderListItem, ProviderListModel } from "../types";

type ProviderConnectionItem = Pick<ProviderListItem, "id" | "env">;

const LM_STUDIO_PROVIDER_ID = "lmstudio";
const LM_STUDIO_PROVIDER_NAME = "LM Studio (local)";
const LM_STUDIO_PROVIDER_NPM = "@ai-sdk/openai-compatible";
const LM_STUDIO_DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";
const GATEWAY_OWNED_PROVIDER_IDS = ["openai", "anthropic", "codex_oauth", "openai_compatible"] as const;

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

const isGatewayOAuthProvider = (providerId?: string | null) =>
  (providerId?.trim().toLowerCase() ?? "") === "openai";

const isGatewayApiKeyProvider = (providerId?: string | null) =>
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

const MODEL_MODALITIES = ["text", "audio", "image", "video", "pdf"] as const;
type ModelModality = (typeof MODEL_MODALITIES)[number];

const enabledModalities = (value: unknown): ModelModality[] => {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return MODEL_MODALITIES.filter((key) => record[key] === true);
};

const buildModalities = (caps?: ConfigProvider["models"][string]["capabilities"]) => {
  if (!caps) return undefined;
  const input = enabledModalities(caps.input);
  const output = enabledModalities(caps.output);
  if (!input.length && !output.length) return undefined;
  return { input, output };
};

const normalizeModelStatus = (value: unknown): ProviderListModel["status"] => {
  return value === "alpha" || value === "beta" || value === "deprecated" || value === "active" ? value : undefined;
};

const mapModel = (modelId: string, model: ConfigProvider["models"][string]): ProviderListModel => {
  const status = normalizeModelStatus(model.status);
  return {
    id: model.id ?? modelId,
    name: model.name ?? model.id ?? modelId,
    family: model.family,
    release_date: model.release_date ?? "",
    attachment: model.capabilities?.attachment ?? false,
    reasoning: Boolean(model.capabilities?.reasoning),
    temperature: model.capabilities?.temperature ?? false,
    tool_call: model.capabilities?.toolcall ?? false,
    interleaved: model.capabilities?.interleaved ? true : undefined,
    cost: model.cost
      ? {
          input: model.cost.input,
          output: model.cost.output,
          cache_read: model.cost.cache.read,
          cache_write: model.cost.cache.write,
          context_over_200k: model.cost.experimentalOver200K
            ? {
                input: model.cost.experimentalOver200K.input,
                output: model.cost.experimentalOver200K.output,
                cache_read: model.cost.experimentalOver200K.cache.read,
                cache_write: model.cost.experimentalOver200K.cache.write,
              }
            : undefined,
        }
      : undefined,
    limit: model.limit,
    modalities: buildModalities(model.capabilities),
    experimental: status === "alpha" ? true : undefined,
    status,
    options: model.options ?? {},
    headers: model.headers ?? undefined,
    provider: model.api?.npm ? { npm: model.api.npm } : undefined,
    variants: model.variants,
  };
};

export const mapConfigProvidersToList = (providers: ConfigProvider[]): ProviderListItem[] =>
  providers.map((provider) => ({
    id: provider.id,
    name: provider.name ?? provider.id,
    env: provider.env ?? [],
    models: Object.fromEntries(
      Object.entries(provider.models ?? {}).map(([modelId, model]) => [modelId, mapModel(modelId, model)]),
    ),
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
