import type { Provider as ConfigProvider, ProviderListResponse } from "@opencode-ai/sdk/v2/client";

type ProviderListItem = ProviderListResponse["all"][number];
type ProviderListModel = ProviderListItem["models"][string];

type ProviderConnectionItem = Pick<ProviderListItem, "id" | "env">;

export const LM_STUDIO_PROVIDER_ID = "lmstudio";
export const LM_STUDIO_PROVIDER_NAME = "LM Studio (local)";
export const LM_STUDIO_PROVIDER_NPM = "@ai-sdk/openai-compatible";
export const LM_STUDIO_DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";

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

export const isApiCredentialRequired = (providerId?: string | null) =>
  (providerId?.trim().toLowerCase() ?? "") !== LM_STUDIO_PROVIDER_ID;

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

const buildModalities = (caps?: ConfigProvider["models"][string]["capabilities"]) => {
  if (!caps) return undefined;

  const input = Object.entries(caps.input)
    .filter(([, enabled]) => enabled)
    .map(([key]) => key as "text" | "audio" | "image" | "video" | "pdf");
  const output = Object.entries(caps.output)
    .filter(([, enabled]) => enabled)
    .map(([key]) => key as "text" | "audio" | "image" | "video" | "pdf");

  if (!input.length && !output.length) return undefined;
  return { input, output };
};

const mapModel = (model: ConfigProvider["models"][string]): ProviderListModel => {
  const interleaved = model.capabilities?.interleaved;
  const modalities = buildModalities(model.capabilities);
  const status = model.status === "alpha" || model.status === "beta" || model.status === "deprecated"
    ? model.status
    : undefined;

  return {
    id: model.id,
    name: model.name ?? model.id,
    family: model.family,
    release_date: model.release_date ?? "",
    attachment: model.capabilities?.attachment ?? false,
    reasoning: model.capabilities?.reasoning ?? false,
    temperature: model.capabilities?.temperature ?? false,
    tool_call: model.capabilities?.toolcall ?? false,
    interleaved: interleaved === false ? undefined : interleaved,
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
    modalities,
    experimental: status === "alpha" ? true : undefined,
    status,
    options: model.options ?? {},
    headers: model.headers ?? undefined,
    provider: model.api?.npm ? { npm: model.api.npm } : undefined,
    variants: model.variants,
  };
};

export const mapConfigProvidersToList = (providers: ConfigProvider[]): ProviderListResponse["all"] =>
  providers.map((provider) => {
    const models = Object.fromEntries(
      Object.entries(provider.models ?? {}).map(([key, model]) => [key, mapModel(model)]),
    );

    return {
      id: provider.id,
      name: provider.name ?? provider.id,
      env: provider.env ?? [],
      models,
    };
  });

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
