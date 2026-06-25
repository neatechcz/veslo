import { parse } from "jsonc-parser";

import type { ModelRef } from "../types";
import type { VesloGatewayProvider, VesloUserAiAccess } from "./veslo-server";
import { formatConfigWithDefaultModel } from "./model-persistence";
import {
  OPENCODE_SESSION_ID_TEMPLATE,
  VESLO_OPENCODE_SERVER_CLIENT_TOKEN_TEMPLATE,
  applyGatewayProviderRouting,
} from "./opencode";
import { isGatewayOwnedProvider } from "../utils/providers";

export const AI_ACCESS_ADMIN_MANAGED_MESSAGE =
  "Provider and model selection are managed by your platform admin.";
export const AI_ACCESS_LOADING_MESSAGE = "Loading your AI access configuration.";
export const AI_ACCESS_NOT_CONFIGURED_MESSAGE =
  "Your AI access has not been configured by the platform admin yet.";
export const AI_ACCESS_INVALID_MESSAGE =
  "Assigned AI access is incomplete. Ask your platform admin to update it.";
export const AI_ACCESS_LOAD_FAILED_MESSAGE = "Failed to load AI access";
export const AI_ACCESS_ADMIN_MANAGED_MESSAGE_KEY = "ai_access.admin_managed";
export const AI_ACCESS_LOADING_MESSAGE_KEY = "ai_access.loading";
export const AI_ACCESS_NOT_CONFIGURED_MESSAGE_KEY = "ai_access.not_configured";
export const AI_ACCESS_INVALID_MESSAGE_KEY = "ai_access.invalid";
export const AI_ACCESS_LOAD_FAILED_MESSAGE_KEY = "ai_access.load_failed";
export const DEFAULT_MANAGED_AI_GATEWAY_BASE_URL = "https://ai.veslo.work";
const REDACTED_SECRET_VALUE = "[REDACTED]";

const AI_ACCESS_MESSAGE_KEY_BY_TEXT = new Map<string, string>([
  [AI_ACCESS_ADMIN_MANAGED_MESSAGE, AI_ACCESS_ADMIN_MANAGED_MESSAGE_KEY],
  [AI_ACCESS_LOADING_MESSAGE, AI_ACCESS_LOADING_MESSAGE_KEY],
  [AI_ACCESS_NOT_CONFIGURED_MESSAGE, AI_ACCESS_NOT_CONFIGURED_MESSAGE_KEY],
  [AI_ACCESS_INVALID_MESSAGE, AI_ACCESS_INVALID_MESSAGE_KEY],
  [AI_ACCESS_LOAD_FAILED_MESSAGE, AI_ACCESS_LOAD_FAILED_MESSAGE_KEY],
]);

export function resolveManagedAiAccessMessageKey(message: string | null | undefined): string | null {
  const trimmed = message?.trim() ?? "";
  return trimmed ? AI_ACCESS_MESSAGE_KEY_BY_TEXT.get(trimmed) ?? null : null;
}

export type ManagedAiAccessProfile = {
  userId: string;
  providerId: VesloGatewayProvider;
  defaultModel: ModelRef;
  allowedModels: string[];
  updatedAt: string | null;
};

function isLoopbackHttpUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    const hostname = parsed.hostname.trim().toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

function normalizeHttpUrl(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

export function resolveManagedAiGatewayBaseUrl(input: {
  settingsUrl: string | null | undefined;
  gatewayClientBaseUrl: string | null | undefined;
  localFallbackBaseUrl: string | null | undefined;
  isDesktopRuntime: boolean;
}): string {
  const settingsUrl = normalizeHttpUrl(input.settingsUrl);
  const gatewayClientBaseUrl = normalizeHttpUrl(input.gatewayClientBaseUrl);
  const localFallbackBaseUrl = normalizeHttpUrl(input.localFallbackBaseUrl);
  const desktopLocalBaseUrl = gatewayClientBaseUrl || localFallbackBaseUrl;

  if (input.isDesktopRuntime && isLoopbackHttpUrl(desktopLocalBaseUrl)) {
    return "";
  }

  if (input.isDesktopRuntime) {
    return DEFAULT_MANAGED_AI_GATEWAY_BASE_URL;
  }

  if (settingsUrl && !isLoopbackHttpUrl(settingsUrl)) {
    return settingsUrl;
  }

  return gatewayClientBaseUrl && !isLoopbackHttpUrl(gatewayClientBaseUrl)
    ? gatewayClientBaseUrl
    : "";
}

export function resolveManagedAiProviderRoutingTarget(input: {
  isDesktopRuntime: boolean;
  workspaceType: "local" | "remote" | null | undefined;
  activeBaseUrl: string | null | undefined;
  engineBaseUrl?: string | null | undefined;
  requireEngineBaseUrl?: boolean;
  activeToken: string | null | undefined;
  gatewayBaseUrl: string | null | undefined;
  gatewayToken: string | null | undefined;
}): { baseUrl: string; engineBaseUrl: string; serverClientToken: string } | null {
  const activeBaseUrl = normalizeHttpUrl(input.activeBaseUrl);
  const engineBaseUrl = normalizeHttpUrl(input.engineBaseUrl);
  const activeToken = input.activeToken?.trim() ?? "";
  if (
    input.isDesktopRuntime &&
    input.workspaceType === "local" &&
    isLoopbackHttpUrl(activeBaseUrl)
  ) {
    if (input.requireEngineBaseUrl && (!engineBaseUrl || isLoopbackHttpUrl(engineBaseUrl))) {
      return null;
    }
    return {
      baseUrl: activeBaseUrl,
      engineBaseUrl: engineBaseUrl || activeBaseUrl,
      serverClientToken: activeToken,
    };
  }

  if (input.isDesktopRuntime && input.workspaceType === "local") {
    return null;
  }

  const gatewayBaseUrl = normalizeHttpUrl(input.gatewayBaseUrl);
  const gatewayToken = input.gatewayToken?.trim() ?? "";
  if (!gatewayBaseUrl || !gatewayToken) {
    return null;
  }

  return {
    baseUrl: gatewayBaseUrl,
    engineBaseUrl: gatewayBaseUrl,
    serverClientToken: gatewayToken,
  };
}

export function requiresManagedAiEngineBaseUrl(input: {
  isDesktopRuntime: boolean;
  workspaceType: "local" | "remote" | null | undefined;
  engineBaseUrl?: string | null;
  requiresEngineBridgeUrl?: boolean | null;
  configuredSandboxEnabled?: boolean | null;
  configuredSandboxBackend?: string | null;
  effectiveSandboxBackend?: string | null;
  childKind?: string | null;
  sandboxEnabled?: boolean | null;
  sandboxBackend?: string | null;
}): boolean {
  if (!input.isDesktopRuntime || input.workspaceType !== "local") {
    return false;
  }

  if (requiresManagedAiBridgeForRuntime(input)) return true;
  const childKind = input.childKind?.trim() ?? "";
  if (input.requiresEngineBridgeUrl === false || childKind === "direct") return false;

  if (input.sandboxEnabled !== true || input.sandboxBackend !== "windows-wsl2") return false;

  // Older callers did not provide the runtime sandbox verdict. Keep the
  // conservative legacy fallback for those paths.
  const engineBaseUrl = normalizeHttpUrl(input.engineBaseUrl);
  return Boolean(engineBaseUrl && !isLoopbackHttpUrl(engineBaseUrl));
}

export function requiresManagedAiBridgeForRuntime(input: {
  isDesktopRuntime: boolean;
  workspaceType: "local" | "remote" | null | undefined;
  requiresEngineBridgeUrl?: boolean | null;
  configuredSandboxEnabled?: boolean | null;
  configuredSandboxBackend?: string | null;
  effectiveSandboxBackend?: string | null;
  childKind?: string | null;
}): boolean {
  if (!input.isDesktopRuntime || input.workspaceType !== "local") return false;
  if (input.requiresEngineBridgeUrl === true) return true;

  const childKind = input.childKind?.trim() ?? "";
  if (childKind === "direct") return false;

  if (
    input.configuredSandboxEnabled === true &&
    input.configuredSandboxBackend === "windows-wsl2"
  ) {
    return true;
  }

  return input.effectiveSandboxBackend === "windows-wsl2";
}

function readConfigObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function parseConfigObject(content: string | null | undefined): Record<string, unknown> {
  const raw = content?.trim() ?? "";
  if (!raw) return {};
  const parsed = parse(raw);
  return readConfigObject(parsed);
}

function hasManagedGatewayHeaders(value: unknown, expectedWorkspaceId?: string | null): boolean {
  const headers = readConfigObject(value);
  const sessionTemplate = typeof headers["x-veslo-session-id"] === "string"
    ? headers["x-veslo-session-id"].trim()
    : "";
  if (sessionTemplate !== OPENCODE_SESSION_ID_TEMPLATE) return false;

  const workspaceId = expectedWorkspaceId?.trim() ?? "";
  if (!workspaceId) return true;
  const configuredWorkspaceId = typeof headers["x-veslo-workspace-id"] === "string"
    ? headers["x-veslo-workspace-id"].trim()
    : "";
  return configuredWorkspaceId === workspaceId;
}

function hasUsableServerClientCredential(
  providerId: string,
  providerConfig: Record<string, unknown>,
  serverClientToken?: string | null,
): boolean {
  const expectedToken = serverClientToken?.trim() ?? "";
  if (!expectedToken) return false;

  const options = readConfigObject(providerConfig.options);
  const isOpenAiCompatibleGatewayProvider = providerId === "codex_oauth" || providerId === "openai_compatible";
  if (isOpenAiCompatibleGatewayProvider) {
    const apiKey = typeof options.apiKey === "string" ? options.apiKey.trim() : "";
    return apiKey === VESLO_OPENCODE_SERVER_CLIENT_TOKEN_TEMPLATE ||
      apiKey === expectedToken ||
      apiKey === REDACTED_SECRET_VALUE;
  }

  const models = readConfigObject(providerConfig.models);
  return Object.values(models).some((model) => {
    const headers = readConfigObject(readConfigObject(model).headers);
    const authorization = typeof headers.Authorization === "string"
      ? headers.Authorization.trim()
      : typeof headers.authorization === "string"
        ? headers.authorization.trim()
        : "";
    return authorization === `Bearer ${VESLO_OPENCODE_SERVER_CLIENT_TOKEN_TEMPLATE}` ||
      authorization === `Bearer ${expectedToken}` ||
      authorization === REDACTED_SECRET_VALUE;
  });
}

function hasManagedGatewayProviderRouting(
  providerId: string,
  providerConfig: Record<string, unknown>,
  gatewayBaseUrl?: string | null,
  workspaceId?: string | null,
): boolean {
  const options = readConfigObject(providerConfig.options);
  const baseUrl = normalizeHttpUrl(typeof options.baseURL === "string" ? options.baseURL : "");
  const expectedRoute = `/ai-gateway/providers/${providerId}/v1`;
  if (!baseUrl.endsWith(expectedRoute)) {
    return false;
  }

  const normalizedGatewayBaseUrl = normalizeHttpUrl(gatewayBaseUrl);
  if (normalizedGatewayBaseUrl && baseUrl !== `${normalizedGatewayBaseUrl}${expectedRoute}`) {
    return false;
  }

  const models = readConfigObject(providerConfig.models);
  return Object.values(models).some((model) =>
    hasManagedGatewayHeaders(readConfigObject(model).headers, workspaceId)
  );
}

export function hasManagedAiGatewayRoutingConfig(
  content: string | null | undefined,
  providerId?: string | null,
  gatewayBaseUrl?: string | null,
): boolean {
  const parsed = parseConfigObject(content);
  const providers = readConfigObject(parsed.provider);
  const targetProviderId = providerId?.trim().toLowerCase() ?? "";

  return Object.entries(providers).some(([candidateId, rawConfig]) => {
    const normalizedId = candidateId.trim().toLowerCase();
    if (!isGatewayOwnedProvider(normalizedId)) {
      return false;
    }
    if (targetProviderId && normalizedId !== targetProviderId) {
      return false;
    }
    return hasManagedGatewayProviderRouting(normalizedId, readConfigObject(rawConfig), gatewayBaseUrl);
  });
}

export function hasUsableManagedAiRuntimeConfig(input: {
  content: string | null | undefined;
  providerId?: string | null;
  gatewayBaseUrl?: string | null;
  serverClientToken?: string | null;
  workspaceId?: string | null;
}): boolean {
  const parsed = parseConfigObject(input.content);
  const providers = readConfigObject(parsed.provider);
  const targetProviderId = input.providerId?.trim().toLowerCase() ?? "";

  return Object.entries(providers).some(([candidateId, rawConfig]) => {
    const normalizedId = candidateId.trim().toLowerCase();
    const providerConfig = readConfigObject(rawConfig);
    if (!isGatewayOwnedProvider(normalizedId)) return false;
    if (targetProviderId && normalizedId !== targetProviderId) return false;
    if (!hasManagedGatewayProviderRouting(normalizedId, providerConfig, input.gatewayBaseUrl, input.workspaceId)) {
      return false;
    }
    return hasUsableServerClientCredential(normalizedId, providerConfig, input.serverClientToken);
  });
}

export function shouldDeferManagedAiAccessRefresh(input: {
  gatewayBaseUrl: string | null | undefined;
  isDesktopRuntime: boolean;
  localClientToken: string | null | undefined;
}): boolean {
  if (!input.isDesktopRuntime) return false;
  if (!isLoopbackHttpUrl(input.gatewayBaseUrl ?? "")) return false;
  return !input.localClientToken?.trim();
}

export function shouldEnsureManagedAiLocalGateway(input: {
  isDesktopRuntime: boolean;
  workspaceType: "local" | "remote" | null | undefined;
  userToken: string | null | undefined;
  localServerRunning: boolean;
  localClientToken: string | null | undefined;
}): boolean {
  if (!input.isDesktopRuntime) return false;
  if (input.workspaceType !== "local") return false;
  if (!input.userToken?.trim()) return false;
  return !input.localServerRunning || !input.localClientToken?.trim();
}

export function shouldPreserveManagedAiConfig(input: {
  content: string | null | undefined;
  managedProfile: ManagedAiAccessProfile | null;
  gatewayBaseUrl: string | null | undefined;
  serverClientToken: string | null | undefined;
  gatewayAccessToken: string | null | undefined;
  accessBusy: boolean;
  accessError: string | null | undefined;
}): boolean {
  if (
    !hasManagedAiGatewayRoutingConfig(
      input.content,
      input.managedProfile?.providerId ?? null,
      input.gatewayBaseUrl,
    )
  ) {
    return false;
  }

  if (input.accessBusy) {
    return true;
  }

  return !input.managedProfile ||
    !input.gatewayBaseUrl?.trim() ||
    !input.serverClientToken?.trim() ||
    !input.gatewayAccessToken?.trim();
}

export function resolveManagedAiAccess(record: VesloUserAiAccess | null | undefined): {
  profile: ManagedAiAccessProfile | null;
  reason: string | null;
} {
  if (!record || record.enabled !== true) {
    return { profile: null, reason: AI_ACCESS_NOT_CONFIGURED_MESSAGE };
  }

  const userId = record.userId?.trim() ?? "";
  const provider = record.provider?.trim().toLowerCase() ?? "";
  const defaultModelId = record.defaultModel?.trim() ?? "";
  if (!userId || !isGatewayOwnedProvider(provider) || !defaultModelId) {
    return { profile: null, reason: AI_ACCESS_INVALID_MESSAGE };
  }

  const allowedModels = Array.isArray(record.allowedModels)
    ? record.allowedModels
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean)
    : [];

  if (allowedModels.length > 0 && !allowedModels.includes(defaultModelId)) {
    return { profile: null, reason: AI_ACCESS_INVALID_MESSAGE };
  }

  return {
    profile: {
      userId,
      providerId: provider,
      defaultModel: {
        providerID: provider,
        modelID: defaultModelId,
      },
      allowedModels,
      updatedAt: typeof record.updatedAt === "string" && record.updatedAt.trim()
        ? record.updatedAt
        : null,
    },
    reason: null,
  };
}

function normalizeGatewayAccessToken(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || trimmed === REDACTED_SECRET_VALUE) return "";
  return trimmed;
}

export function resolveManagedAiAccessBundleState(input: {
  aiAccess: VesloUserAiAccess | null | undefined;
  accessToken: string | null | undefined;
  fallbackAccessToken: string | null | undefined;
  requireGatewayAccessToken: boolean;
}): {
  profile: ManagedAiAccessProfile | null;
  gatewayAccessToken: string;
  reason: string | null;
} {
  const { profile: resolvedProfile, reason: resolvedReason } = resolveManagedAiAccess(input.aiAccess);
  if (!resolvedProfile) {
    return {
      profile: null,
      gatewayAccessToken: "",
      reason: resolvedReason ?? AI_ACCESS_NOT_CONFIGURED_MESSAGE,
    };
  }

  const gatewayAccessToken =
    normalizeGatewayAccessToken(input.accessToken) ||
    normalizeGatewayAccessToken(input.fallbackAccessToken);

  if (input.requireGatewayAccessToken && !gatewayAccessToken) {
    return {
      profile: null,
      gatewayAccessToken: "",
      reason: AI_ACCESS_INVALID_MESSAGE,
    };
  }

  return {
    profile: resolvedProfile,
    gatewayAccessToken,
    reason: null,
  };
}

export function extractManagedApiKey(content: string | null | undefined): string | null {
  const trimmed = content?.trim() ?? "";
  if (!trimmed) return null;
  try {
    const parsed = parse(trimmed);
    if (!parsed || typeof parsed !== "object") return null;
    const provider = (parsed as Record<string, unknown>).provider;
    if (!provider || typeof provider !== "object") return null;
    for (const entry of Object.values(provider as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const options = (entry as Record<string, unknown>).options;
      if (!options || typeof options !== "object") continue;
      const apiKey = (options as Record<string, unknown>).apiKey;
      if (typeof apiKey !== "string") continue;
      const normalized = apiKey.trim();
      if (!normalized || normalized === REDACTED_SECRET_VALUE) continue;
      if (normalized === VESLO_OPENCODE_SERVER_CLIENT_TOKEN_TEMPLATE) continue;
      return normalized;
    }
    return null;
  } catch {
    return null;
  }
}

export function formatManagedAiAccessConfig(
  content: string | null | undefined,
  input: {
    profile: ManagedAiAccessProfile;
    serverBaseUrl: string;
    engineBaseUrl?: string | null;
    serverClientToken: string;
    gatewayAccessToken: string;
    workspaceId?: string | null;
  },
): string {
  const withDefaultModel = formatConfigWithDefaultModel(content ?? "", input.profile.defaultModel);
  return `${applyGatewayProviderRouting(withDefaultModel, {
    providerId: input.profile.providerId,
    serverBaseUrl: input.engineBaseUrl?.trim() || input.serverBaseUrl,
    serverClientToken: input.serverClientToken,
    gatewayAccessToken: input.gatewayAccessToken,
    workspaceId: input.workspaceId,
    models: [input.profile.defaultModel.modelID, ...input.profile.allowedModels],
  })}\n`;
}
