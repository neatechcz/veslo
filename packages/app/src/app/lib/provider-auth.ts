/**
 * Provider authentication and connection management.
 *
 * Extracted from app.tsx — all functions accept their dependencies
 * via the `createProviderAuthModule` factory so they remain decoupled
 * from the SolidJS signal layer.
 */

import type {
  ProviderAuthAuthorization,
  TextPartInput,
} from "@opencode-ai/sdk/v2/client";
import { parse } from "jsonc-parser";
import type { VesloServerClient } from "./veslo-server";

import { fetchWithTimeout } from "./http";
import {
  extractOpenAiCompatibleModelIds,
  GATEWAY_OWNED_PROVIDER_IDS,
  isGatewayApiKeyProvider,
  isGatewayOAuthProvider,
  isGatewayOwnedProvider,
  LM_STUDIO_DEFAULT_BASE_URL,
  LM_STUDIO_PROVIDER_ID,
  LM_STUDIO_PROVIDER_NAME,
  LM_STUDIO_PROVIDER_NPM,
  mergeConnectedProviderIds,
  resolveLmStudioBaseUrl,
} from "../utils/providers";

import type { Client, ProviderListItem } from "../types";
import { safeStringify } from "../utils";

// ── Re-exported types ──────────────────────────────────────────────

export type ProviderAuthMethod = { type: "oauth" | "api"; label: string };

export type ProviderOAuthStartResult = {
  methodIndex: number;
  authorization: ProviderAuthAuthorization;
};

// ── Standalone helpers (also used outside provider-auth) ───────────

export const describeProviderError = (error: unknown, fallback: string): string => {
  const readString = (value: unknown, max = 700) => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.length <= max) return trimmed;
    return `${trimmed.slice(0, Math.max(0, max - 3))}...`;
  };

  const records: Record<string, unknown>[] = [];
  const root = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
  if (root) {
    records.push(root);
    if (root.data && typeof root.data === "object") records.push(root.data as Record<string, unknown>);
    if (root.cause && typeof root.cause === "object") {
      const cause = root.cause as Record<string, unknown>;
      records.push(cause);
      if (cause.data && typeof cause.data === "object") records.push(cause.data as Record<string, unknown>);
    }
  }

  const firstString = (keys: string[]) => {
    for (const record of records) {
      for (const key of keys) {
        const value = readString(record[key]);
        if (value) return value;
      }
    }
    return null;
  };

  const firstNumber = (keys: string[]) => {
    for (const record of records) {
      for (const key of keys) {
        const value = record[key];
        if (typeof value === "number" && Number.isFinite(value)) return value;
      }
    }
    return null;
  };

  const status = firstNumber(["statusCode", "status"]);
  const provider = firstString(["providerID", "providerId", "provider"]);
  const code = firstString(["code", "errorCode"]);
  const response = firstString(["responseBody", "body", "response"]);
  const raw =
    (error instanceof Error ? readString(error.message) : null) ||
    firstString(["message", "detail", "reason", "error"]) ||
    (typeof error === "string" ? readString(error) : null);

  const generic = raw && /^unknown\s+error$/i.test(raw);
  const heading = (() => {
    if (status === 401 || status === 403) return "Authentication failed";
    if (status === 429) return "Rate limit exceeded";
    if (provider) return `Provider error (${provider})`;
    return fallback;
  })();

  const lines = [heading];
  if (raw && !generic && raw !== heading) lines.push(raw);
  if (status && !heading.includes(String(status))) lines.push(`Status: ${status}`);
  if (provider && !heading.includes(provider)) lines.push(`Provider: ${provider}`);
  if (code) lines.push(`Code: ${code}`);
  if (response) lines.push(`Response: ${response}`);
  if (lines.length > 1) return lines.join("\n");

  if (raw && !generic) return raw;
  if (error && typeof error === "object") {
    const serialized = safeStringify(error);
    if (serialized && serialized !== "{}") return serialized;
  }
  return fallback;
};

export const assertNoClientError = (result: unknown): void => {
  const maybe = result as { error?: unknown } | null | undefined;
  if (!maybe || maybe.error === undefined) return;
  throw new Error(describeProviderError(maybe.error, "Request failed"));
};

// ── Internal helpers ───────────────────────────────────────────────

const buildProviderAuthMethods = (
  methods: Record<string, ProviderAuthMethod[]>,
  availableProviders: ProviderListItem[],
) => {
  const merged = { ...methods } as Record<string, ProviderAuthMethod[]>;
  const lmStudioExisting = merged[LM_STUDIO_PROVIDER_ID] ?? [];
  if (!lmStudioExisting.some((method) => method.type === "api")) {
    merged[LM_STUDIO_PROVIDER_ID] = [...lmStudioExisting, { type: "api", label: "Local URL (no key)" }];
  }

  for (const provider of availableProviders ?? []) {
    const id = provider.id?.trim();
    if (!id || id === "opencode") continue;
    if (id === LM_STUDIO_PROVIDER_ID) {
      continue;
    }
    if (!Array.isArray(provider.env) || provider.env.length === 0) continue;
    const existing = merged[id] ?? [];
    if (isGatewayOAuthProvider(id)) {
      merged[id] = existing.filter((method) => method.type !== "api");
      continue;
    }
    if (existing.some((method) => method.type === "api")) continue;
    merged[id] = [...existing, { type: "api", label: "API key" }];
  }

  const openAiMethods = (merged.openai ?? []).filter((method) => method.type !== "api");
  if (!openAiMethods.some((method) => method.type === "oauth")) {
    openAiMethods.push({ type: "oauth", label: "OAuth" });
  }
  merged.openai = openAiMethods;

  const anthropicMethods = merged.anthropic ?? [];
  if (!anthropicMethods.some((method) => method.type === "api")) {
    anthropicMethods.push({ type: "api", label: "API key" });
  }
  merged.anthropic = anthropicMethods;

  return merged;
};

const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number, label: string) => {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Timed out during ${label}.`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

// ── Module factory ─────────────────────────────────────────────────

export interface ProviderAuthDeps {
  getClient: () => Client | null;
  getVesloServerClient?: () => VesloServerClient | null;
  getGatewayAuthToken?: () => string | null;
  getProviders: () => ProviderListItem[];
  getProviderDefaults: () => Record<string, string>;
  getProviderAuthMethods: () => Record<string, ProviderAuthMethod[]>;
  getWorkspaceRoot: () => string;
  setProviderAuthError: (error: string | null) => void;
  /** globalSync.set("provider", data) */
  globalSyncSetProvider: (data: unknown) => void;
  /** globalSync.set("provider", { ...data, connected: mergedConnected }) */
  globalSyncSetProviderMerged: (data: unknown, mergedConnected: string[]) => void;
  unwrap: <T>(result: { data?: T; error?: unknown }) => NonNullable<T>;
  isTauriRuntime: () => boolean;
  readOpencodeConfig: (
    scope: "project",
    workspaceRoot: string,
  ) => Promise<{ content?: string | null } | null>;
  writeOpencodeConfig: (
    scope: "project",
    workspaceRoot: string,
    content: string,
  ) => Promise<{ ok: boolean; stderr?: string; stdout?: string }>;
}

export function createProviderAuthModule(deps: ProviderAuthDeps) {
  const {
    getClient,
    getVesloServerClient,
    getGatewayAuthToken,
    getProviders,
    getProviderDefaults,
    getProviderAuthMethods,
    getWorkspaceRoot,
    setProviderAuthError,
    globalSyncSetProvider,
    globalSyncSetProviderMerged,
    unwrap,
    isTauriRuntime,
    readOpencodeConfig,
    writeOpencodeConfig,
  } = deps;

  // ── helpers ────────────────────────────────────────────────────

  const requireClient = (): Client => {
    const c = getClient();
    if (!c) throw new Error("Not connected to a server");
    return c;
  };

  const buildGatewayAuthorization = (url: string): ProviderAuthAuthorization => ({
    url,
    method: "code",
    instructions: "Authorize in your browser, then paste the returned code here.",
  });

  const resolveGatewayClient = () => getVesloServerClient?.() ?? null;

  const resolveGatewayAuthToken = () => {
    const trimmed = getGatewayAuthToken?.()?.trim() ?? "";
    return trimmed || null;
  };

  const requireGatewayContext = (providerId: string) => {
    const client = resolveGatewayClient();
    if (!client) {
      throw new Error(`Veslo server is required to manage ${providerId} credentials.`);
    }

    const userToken = resolveGatewayAuthToken();
    if (!userToken) {
      throw new Error(`Sign in to Veslo before managing ${providerId} credentials.`);
    }

    return { client, userToken };
  };

  const resolveGatewayConnectedProviderIds = async () => {
    const client = resolveGatewayClient();
    const userToken = resolveGatewayAuthToken();
    if (!client || !userToken) {
      return null;
    }

    const settled = await Promise.allSettled(
      GATEWAY_OWNED_PROVIDER_IDS.map(async (providerId) => {
        const listed = await client.listGatewayCredentials(userToken, providerId);
        const hasActiveCredential = (listed.credentials ?? []).some((credential) => credential.state !== "revoked");
        return hasActiveCredential ? providerId : null;
      }),
    );

    return settled.flatMap((result) => (result.status === "fulfilled" && result.value ? [result.value] : []));
  };

  const loadProviderAuthMethods = async () => {
    const c = requireClient();
    const methods = unwrap(await c.provider.auth());
    return buildProviderAuthMethods(methods as Record<string, ProviderAuthMethod[]>, getProviders());
  };

  const resolveProviderConnectionTestModelID = (providerId: string) => {
    const provider = getProviders().find((item) => item.id === providerId);
    if (!provider) {
      throw new Error(`Unknown provider: ${providerId}`);
    }

    const configuredDefault = getProviderDefaults()[providerId];
    if (configuredDefault && provider.models?.[configuredDefault]) {
      return configuredDefault;
    }

    const firstModel = Object.keys(provider.models ?? {})[0];
    if (firstModel) {
      return firstModel;
    }

    throw new Error(`No models available for ${providerId}`);
  };

  const runProviderConnectionTest = async (c: Client, providerId: string) => {
    const modelID = resolveProviderConnectionTestModelID(providerId);
    const directory = getWorkspaceRoot().trim();
    const created = unwrap(
      await c.session.create({
        directory: directory || undefined,
        title: `[Veslo] Connection test · ${providerId}`,
      }),
    );
    const sessionID = created.id;

    try {
      unwrap(
        await withTimeout(
          c.session.prompt({
            sessionID,
            model: { providerID: providerId, modelID },
            parts: [{ type: "text", text: "Connection test. Reply with OK." } as TextPartInput],
          }),
          30_000,
          "provider connection test",
        ),
      );
    } finally {
      try {
        await c.session.abort({ sessionID });
      } catch {
        // ignore
      }
      try {
        await c.session.delete({ sessionID });
      } catch {
        // ignore
      }
    }
  };

  const refreshProviderState = async (c: Client, forceConnectedProviderId?: string) => {
    const updated = unwrap(await c.provider.list());
    const gatewayConnectedProviderIds = await resolveGatewayConnectedProviderIds();

    if (!forceConnectedProviderId && gatewayConnectedProviderIds === null) {
      globalSyncSetProvider(updated);
      return;
    }

    const mergedConnected = mergeConnectedProviderIds(
      updated.connected ?? [],
      gatewayConnectedProviderIds ?? [],
      forceConnectedProviderId ? [forceConnectedProviderId] : [],
    );
    globalSyncSetProviderMerged(updated, mergedConnected);
  };

  const saveAndTestProviderApiKey = async (providerId: string, apiKey: string) => {
    const c = requireClient();

    const resolvedProviderId = providerId.trim();
    if (!resolvedProviderId) {
      throw new Error("Provider ID is required");
    }

    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new Error("API key is required");
    }

    if (isGatewayOwnedProvider(resolvedProviderId)) {
      if (!isGatewayApiKeyProvider(resolvedProviderId)) {
        throw new Error(`API key auth is not supported for ${resolvedProviderId}. Use OAuth instead.`);
      }

      const { client: gatewayClient, userToken } = requireGatewayContext(resolvedProviderId);
      await gatewayClient.saveAnthropicApiKey(userToken, trimmed);
      await refreshProviderState(c);
      return `Connected ${resolvedProviderId}`;
    }

    await c.auth.set({
      providerID: resolvedProviderId,
      auth: { type: "api", key: trimmed },
    });
    // Dispose the instance to force provider state recomputation.
    unwrap(await c.instance.dispose());
    // Refresh provider state before the connection test so that the newly-added provider
    // is available when resolveProviderConnectionTestModelID looks it up.
    await refreshProviderState(c);
    await runProviderConnectionTest(c, resolvedProviderId);
    await refreshProviderState(c, resolvedProviderId);

    return `Connected ${resolvedProviderId}`;
  };

  // ── public API ─────────────────────────────────────────────────

  async function startProviderAuth(providerId?: string): Promise<ProviderOAuthStartResult> {
    setProviderAuthError(null);
    const c = requireClient();
    try {
      const cachedMethods = getProviderAuthMethods();
      const authMethods = Object.keys(cachedMethods).length
        ? cachedMethods
        : await loadProviderAuthMethods();
      const providerIds = Object.keys(authMethods).sort();
      if (!providerIds.length) {
        throw new Error("No providers available");
      }

      const resolved = providerId?.trim() ?? "";
      if (!resolved) {
        throw new Error("Provider ID is required");
      }

      if (isGatewayOAuthProvider(resolved)) {
        const { client: gatewayClient, userToken } = requireGatewayContext(resolved);
        const started = await gatewayClient.startOpenAiOAuth(userToken);
        return {
          methodIndex: 0,
          authorization: buildGatewayAuthorization(started.authorizeUrl),
        };
      }

      const methods = authMethods[resolved];
      if (!methods || !methods.length) {
        throw new Error(`Unknown provider: ${resolved}`);
      }

      const oauthIndex = methods.findIndex((method) => method.type === "oauth");
      if (oauthIndex === -1) {
        throw new Error(`No OAuth flow available for ${resolved}. Use an API key instead.`);
      }

      const auth = unwrap(await c.provider.oauth.authorize({ providerID: resolved, method: oauthIndex }));
      return {
        methodIndex: oauthIndex,
        authorization: auth,
      };
    } catch (error) {
      const message = describeProviderError(error, "Failed to connect provider");
      setProviderAuthError(message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async function completeProviderAuthOAuth(providerId: string, methodIndex: number, code?: string) {
    setProviderAuthError(null);
    const c = requireClient();

    const resolved = providerId?.trim();
    if (!resolved) {
      throw new Error("Provider ID is required");
    }

    if (!Number.isInteger(methodIndex) || methodIndex < 0) {
      throw new Error("OAuth method is required");
    }

    try {
      const trimmedCode = code?.trim();
      if (isGatewayOAuthProvider(resolved)) {
        if (!trimmedCode) {
          throw new Error("Authorization code is required");
        }

        const { client: gatewayClient, userToken } = requireGatewayContext(resolved);
        await gatewayClient.finishOpenAiOAuth(userToken, trimmedCode);
        await refreshProviderState(c);
        return `Connected ${resolved}`;
      }

      const result = await c.provider.oauth.callback({
        providerID: resolved,
        method: methodIndex,
        code: trimmedCode || undefined,
      });
      assertNoClientError(result);
      const updated = unwrap(await c.provider.list());
      globalSyncSetProvider(updated);
      return `Connected ${resolved}`;
    } catch (error) {
      const message = describeProviderError(error, "Failed to complete OAuth");
      setProviderAuthError(message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async function submitProviderApiKey(providerId: string, apiKey: string) {
    setProviderAuthError(null);
    try {
      return await saveAndTestProviderApiKey(providerId, apiKey);
    } catch (error) {
      const message = describeProviderError(error, "Connection test failed");
      setProviderAuthError(message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async function testProviderApiKey(providerId: string, apiKey: string) {
    setProviderAuthError(null);
    try {
      return await saveAndTestProviderApiKey(providerId, apiKey);
    } catch (error) {
      const message = describeProviderError(error, "Connection test failed");
      setProviderAuthError(message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async function disconnectProvider(providerId: string) {
    setProviderAuthError(null);
    const c = requireClient();

    const resolved = providerId.trim();
    if (!resolved) {
      throw new Error("Provider ID is required");
    }

    if (isGatewayOwnedProvider(resolved)) {
      const { client: gatewayClient, userToken } = requireGatewayContext(resolved);
      const listed = await gatewayClient.listGatewayCredentials(userToken, resolved);
      const activeCredentials = (listed.credentials ?? []).filter((credential) => credential.state !== "revoked");
      await Promise.all(
        activeCredentials.map((credential) =>
          gatewayClient.revokeGatewayCredential(userToken, resolved, credential.id)
        ),
      );
      await refreshProviderState(c);
      return `Disconnected ${resolved}`;
    }

    const removeProviderAuth = async () => {
      const rawClient = (c as unknown as { client?: { delete?: (options: { url: string }) => Promise<unknown> } })
        .client;
      if (rawClient?.delete) {
        await rawClient.delete({ url: `/auth/${encodeURIComponent(resolved)}` });
        return;
      }
      await c.auth.set({ providerID: resolved, auth: null as never });
    };

    try {
      await removeProviderAuth();
      unwrap(await c.instance.dispose());
      await refreshProviderState(c);
      return `Disconnected ${resolved}`;
    } catch (error) {
      const message = describeProviderError(error, "Failed to disconnect provider");
      setProviderAuthError(message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async function connectLmStudioProvider(baseUrlInput?: string) {
    setProviderAuthError(null);
    const c = requireClient();

    if (!isTauriRuntime()) {
      throw new Error("LM Studio setup is currently supported in the desktop app only.");
    }

    const workspaceRoot = getWorkspaceRoot().trim();
    if (!workspaceRoot) {
      throw new Error("Pick a workspace folder first.");
    }

    const configFile = await readOpencodeConfig("project", workspaceRoot);
    const parsed = (() => {
      const raw = configFile?.content?.trim() ?? "";
      if (!raw) return {} as Record<string, unknown>;
      const next = parse(raw);
      if (!next || typeof next !== "object" || Array.isArray(next)) {
        return {} as Record<string, unknown>;
      }
      return next as Record<string, unknown>;
    })();

    const providerRootRaw =
      parsed.provider && typeof parsed.provider === "object" && !Array.isArray(parsed.provider)
        ? (parsed.provider as Record<string, unknown>)
        : {};
    const lmstudioRaw =
      providerRootRaw[LM_STUDIO_PROVIDER_ID] &&
      typeof providerRootRaw[LM_STUDIO_PROVIDER_ID] === "object" &&
      !Array.isArray(providerRootRaw[LM_STUDIO_PROVIDER_ID])
        ? (providerRootRaw[LM_STUDIO_PROVIDER_ID] as Record<string, unknown>)
        : {};
    const optionsRaw =
      lmstudioRaw.options && typeof lmstudioRaw.options === "object" && !Array.isArray(lmstudioRaw.options)
        ? (lmstudioRaw.options as Record<string, unknown>)
        : {};
    const existingModelsRaw =
      lmstudioRaw.models && typeof lmstudioRaw.models === "object" && !Array.isArray(lmstudioRaw.models)
        ? (lmstudioRaw.models as Record<string, unknown>)
        : {};

    const configuredBaseUrl = typeof optionsRaw.baseURL === "string" ? optionsRaw.baseURL : "";
    const candidateBaseUrl = resolveLmStudioBaseUrl(baseUrlInput, configuredBaseUrl || LM_STUDIO_DEFAULT_BASE_URL);

    let baseURL = candidateBaseUrl;
    try {
      const parsedUrl = new URL(candidateBaseUrl);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw new Error("invalid protocol");
      }
      baseURL = parsedUrl.toString().replace(/\/+$/, "");
    } catch {
      throw new Error("LM Studio URL must be a valid http(s) URL (for example http://127.0.0.1:1234/v1).");
    }

    const modelsUrl = `${baseURL}/models`;

    let payload: unknown;
    try {
      const response = await fetchWithTimeout(
        globalThis.fetch,
        modelsUrl,
        { method: "GET", headers: { Accept: "application/json" } },
        10_000,
      );
      if (!response.ok) {
        throw new Error(`LM Studio request failed (${response.status}).`);
      }
      payload = await response.json();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("LM Studio did not respond in time.");
      }
      throw error instanceof Error
        ? error
        : new Error("Failed to connect to LM Studio.");
    }

    const modelIds = extractOpenAiCompatibleModelIds(payload);
    if (!modelIds.length) {
      throw new Error("LM Studio responded, but no local models were found. Load a model in LM Studio and retry.");
    }

    const models = Object.fromEntries(
      modelIds.map((modelId) => {
        const existingModelRaw =
          existingModelsRaw[modelId] &&
          typeof existingModelsRaw[modelId] === "object" &&
          !Array.isArray(existingModelsRaw[modelId])
            ? (existingModelsRaw[modelId] as Record<string, unknown>)
            : {};
        const existingName = typeof existingModelRaw.name === "string" ? existingModelRaw.name.trim() : "";
        return [modelId, { ...existingModelRaw, name: existingName || `${modelId} (local)` }];
      }),
    );

    parsed.provider = {
      ...providerRootRaw,
      [LM_STUDIO_PROVIDER_ID]: {
        ...lmstudioRaw,
        npm: LM_STUDIO_PROVIDER_NPM,
        name: LM_STUDIO_PROVIDER_NAME,
        options: {
          ...optionsRaw,
          baseURL,
        },
        models,
      },
    };

    const serialized = JSON.stringify(parsed, null, 2);
    const writeResult = await writeOpencodeConfig("project", workspaceRoot, `${serialized}\n`);
    if (!writeResult.ok) {
      throw new Error(writeResult.stderr || writeResult.stdout || "Failed to update opencode.json");
    }

    unwrap(await c.instance.dispose());
    await refreshProviderState(c, LM_STUDIO_PROVIDER_ID);
    return `Connected LM Studio (${modelIds.length} model${modelIds.length === 1 ? "" : "s"})`;
  }

  return {
    loadProviderAuthMethods,
    startProviderAuth,
    completeProviderAuthOAuth,
    saveAndTestProviderApiKey,
    submitProviderApiKey,
    testProviderApiKey,
    disconnectProvider,
    connectLmStudioProvider,
    runProviderConnectionTest,
    refreshProviderState,
  };
}
