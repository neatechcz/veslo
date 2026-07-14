import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
  type Accessor,
  type Setter,
} from "solid-js";

import {
  resolveManagedAiAccessRefreshFailure,
  resolveManagedAiAccessRefreshPreflight,
  resolveManagedAiAccessRefreshSuccess,
} from "../controllers/managed-ai-runtime-controller";
import type { DenAuthState } from "../lib/den-auth";
import {
  AI_ACCESS_ADMIN_MANAGED_MESSAGE_KEY,
  AI_ACCESS_LOAD_FAILED_MESSAGE_KEY,
  AI_ACCESS_LOADING_MESSAGE_KEY,
  AI_ACCESS_NOT_CONFIGURED_MESSAGE_KEY,
  resolveManagedAiAccessBundleState,
  resolveManagedAiAccessMessageKey,
  shouldDeferManagedAiAccessRefresh,
  shouldEnsureManagedAiLocalGateway,
  type ManagedAiAccessProfile,
} from "../lib/ai-access";
import {
  resolveManagedAiAccessRetryDelayMs,
  shouldRetryManagedAiAccessRefresh,
} from "../lib/managed-ai-access-retry";
import type {
  VesloManagedAiAccessBundle,
  VesloServerClient,
} from "../lib/veslo-server";
import type { ProviderListItem } from "../types";
import { isGatewayOwnedProvider } from "../utils/providers";

export const MANAGED_AI_ACCESS_CACHE_STORAGE_KEY = "veslo.managedAiAccess.v1";
export const MANAGED_AI_ACCESS_CACHE_TTL_MS = 30 * 60 * 1000;
export const MANAGED_AI_ACCESS_PROOF_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

export type ManagedAiAccessCacheRecord = {
  schemaVersion: 1;
  cacheKey: string;
  fetchedAt: number;
  profile: ManagedAiAccessProfile;
  gatewayAccessToken: string;
};

export type ManagedAiAccessProofCacheState = {
  cacheKey: string;
  loaded: boolean;
  record: ManagedAiAccessCacheRecord | null;
};

export type ManagedAiAccessStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

type ManagedAiAccessProofRead = {
  providerId: string;
  effectiveModel: ManagedAiAccessProfile["effectiveModel"];
  updatedAt?: string | null;
  fetchedAt: number;
};

export type ManagedAiAccessProofCache = {
  read: (input: { cacheKey: string; maxAgeMs: number }) => Promise<ManagedAiAccessProofRead | null>;
  write: (input: {
    cacheKey: string;
    proof: {
      providerId: string;
      effectiveModel: ManagedAiAccessProfile["effectiveModel"];
      updatedAt: string | null;
    };
  }) => Promise<unknown>;
  clear: (cacheKey?: string | null) => Promise<unknown>;
};

export type ManagedAiAccessCacheDeps = {
  storage?: ManagedAiAccessStorage | null;
  proofCache?: Partial<ManagedAiAccessProofCache> | null;
  isTauriRuntime?: Accessor<boolean>;
  now?: () => number;
};

export type ManagedAiAccessGatewayClient = Pick<
  VesloServerClient,
  "baseUrl" | "getMyAiAccess"
>;

export type ManagedAiAccessWindowTarget = {
  addEventListener: (type: "focus", listener: () => void) => void;
  removeEventListener: (type: "focus", listener: () => void) => void;
};

export type ManagedAiAccessDocumentTarget = {
  visibilityState?: string;
  addEventListener: (type: "visibilitychange", listener: () => void) => void;
  removeEventListener: (type: "visibilitychange", listener: () => void) => void;
};

export type ManagedAiAccessStoreOptions = ManagedAiAccessCacheDeps & {
  authenticatedUser: Accessor<string | null>;
  denAuthRevision: Accessor<number>;
  readDenAuth: () => DenAuthState | null;
  isTauriRuntime: Accessor<boolean>;
  gatewayVesloServerClient: Accessor<ManagedAiAccessGatewayClient | null>;
  managedAiGatewayBaseUrl: Accessor<string>;
  vesloServerAuth: Accessor<{ token?: string | null }>;
  activeVesloServerHostInfo: Accessor<{ baseUrl?: string | null } | null>;
  activeWorkspaceDisplay: Accessor<{ workspaceType?: string | null }>;
  activeVesloServerWorkspaceId?: Accessor<string | null>;
  ensureLocalVesloServerRunning: (options: { ignoreStartupPreference: true }) => Promise<boolean>;
  providers: Accessor<ProviderListItem[]>;
  formatModelLabel: (
    model: ManagedAiAccessProfile["effectiveModel"],
    providers: ProviderListItem[],
  ) => string;
  translate: (key: string) => string;
  reportError: (error: unknown, scope: string) => void;
  describeRequestError: (error: unknown, fallback: string) => string;
  requestManagedAiAccessBundle?: (
    baseUrl: string,
    userToken: string,
    orgId?: string,
  ) => Promise<VesloManagedAiAccessBundle>;
  timers?: {
    setTimeout?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimeout?: (timeoutId: ReturnType<typeof setTimeout>) => void;
  };
  windowTarget?: ManagedAiAccessWindowTarget | null;
  documentTarget?: ManagedAiAccessDocumentTarget | null;
  effect?: (fn: () => void) => void;
};

export type ManagedAiAccessStore = {
  managedAiAccess: Accessor<ManagedAiAccessProfile | null>;
  managedAiGatewayAccessToken: Accessor<string>;
  managedAiAccessBusy: Accessor<boolean>;
  managedAiAccessError: Accessor<string | null>;
  managedAiAccessRetryScheduled: Accessor<boolean>;
  managedAiAccessModel: Accessor<ManagedAiAccessProfile["effectiveModel"] | null>;
  denGatewayAccessToken: Accessor<string>;
  managedAiAccessMessage: Accessor<string>;
  managedAiAccessProviderLabel: Accessor<string | null>;
  managedAiAccessEffectiveModelLabel: Accessor<string | null>;
  managedAiAccessBlockedReason: Accessor<string | null>;
  requestManagedAiAccessRefresh: () => void;
  clearManagedAiAccessCache: (cacheKey?: string | null) => void;
  writeCurrentManagedAiAccessCache: (
    profile: ManagedAiAccessProfile,
    gatewayAccessToken: string,
  ) => void;
  applyManagedAiAccessProfile: (
    profile: ManagedAiAccessProfile,
    gatewayAccessToken: string,
    options?: { writeCache?: boolean },
  ) => void;
  setManagedAiAccessError: Setter<string | null>;
};

let managedAiAccessRefreshInFlight: {
  cacheKey: string;
  promise: Promise<VesloManagedAiAccessBundle>;
} | null = null;

function defaultStorage(): ManagedAiAccessStorage | null {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

function defaultWindowTarget(): ManagedAiAccessWindowTarget | null {
  if (typeof window === "undefined") return null;
  return window;
}

function defaultDocumentTarget(): ManagedAiAccessDocumentTarget | null {
  if (typeof document === "undefined") return null;
  return document;
}

const isManagedAiAccessProfileValue = (value: unknown): value is ManagedAiAccessProfile => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<ManagedAiAccessProfile>;
  const providerId = typeof record.providerId === "string" ? record.providerId.trim() : "";
  const effectiveProvider = typeof record.effectiveModel?.providerID === "string"
    ? record.effectiveModel.providerID.trim()
    : "";
  const effectiveModelId = typeof record.effectiveModel?.modelID === "string"
    ? record.effectiveModel.modelID.trim()
    : "";
  return Boolean(
    typeof record.userId === "string" &&
      record.userId.trim() &&
      isGatewayOwnedProvider(providerId) &&
      record.effectiveModel &&
      typeof record.effectiveModel === "object" &&
      effectiveProvider === providerId &&
      effectiveModelId,
  );
};

function cacheDeps(input?: ManagedAiAccessCacheDeps): Required<Pick<ManagedAiAccessCacheDeps, "isTauriRuntime" | "now">> & {
  storage: ManagedAiAccessStorage | null;
  proofCache: Partial<ManagedAiAccessProofCache> | null;
} {
  return {
    storage: input?.storage === undefined ? defaultStorage() : input.storage,
    proofCache: input?.proofCache ?? null,
    isTauriRuntime: input?.isTauriRuntime ?? (() => false),
    now: input?.now ?? (() => Date.now()),
  };
}

export const buildManagedAiAccessCacheKey = (input: {
  userId: string | null | undefined;
  orgId: string | null | undefined;
  gatewayBaseUrl: string | null | undefined;
}) => {
  const userId = input.userId?.trim() ?? "";
  const orgId = input.orgId?.trim() ?? "";
  const gatewayBaseUrl = input.gatewayBaseUrl?.trim().replace(/\/+$/, "") ?? "";
  return userId && gatewayBaseUrl ? `${userId}|${orgId}|${gatewayBaseUrl}` : "";
};

export const readManagedAiAccessCache = (
  cacheKey: string,
  deps?: ManagedAiAccessCacheDeps,
): ManagedAiAccessCacheRecord | null => {
  const resolved = cacheDeps(deps);
  if (resolved.isTauriRuntime()) return null;
  if (!cacheKey || !resolved.storage) return null;
  try {
    const raw = resolved.storage.getItem(MANAGED_AI_ACCESS_CACHE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ManagedAiAccessCacheRecord>;
    if (parsed.schemaVersion !== 1) return null;
    if (parsed.cacheKey !== cacheKey) return null;
    if (
      !Number.isFinite(parsed.fetchedAt) ||
      resolved.now() - Number(parsed.fetchedAt) > MANAGED_AI_ACCESS_CACHE_TTL_MS
    ) {
      return null;
    }
    if (!isManagedAiAccessProfileValue(parsed.profile)) return null;
    const gatewayAccessToken =
      typeof parsed.gatewayAccessToken === "string" ? parsed.gatewayAccessToken.trim() : "";
    if (!gatewayAccessToken || gatewayAccessToken === "[REDACTED]") return null;
    return {
      schemaVersion: 1,
      cacheKey,
      fetchedAt: Number(parsed.fetchedAt),
      profile: parsed.profile,
      gatewayAccessToken,
    };
  } catch {
    return null;
  }
};

export const writeManagedAiAccessCache = (
  cacheKey: string,
  profile: ManagedAiAccessProfile,
  gatewayAccessToken: string,
  deps?: ManagedAiAccessCacheDeps,
) => {
  const resolved = cacheDeps(deps);
  if (!cacheKey) return;
  if (resolved.isTauriRuntime()) {
    void resolved.proofCache?.write?.({
      cacheKey,
      proof: {
        providerId: profile.providerId,
        effectiveModel: profile.effectiveModel,
        updatedAt: profile.updatedAt,
      },
    }).catch(() => undefined);
    return;
  }
  if (!resolved.storage) return;
  const token = gatewayAccessToken.trim();
  if (!token || token === "[REDACTED]") return;
  try {
    const record: ManagedAiAccessCacheRecord = {
      schemaVersion: 1,
      cacheKey,
      fetchedAt: resolved.now(),
      profile,
      gatewayAccessToken: token,
    };
    resolved.storage.setItem(MANAGED_AI_ACCESS_CACHE_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // ignore storage failures; the live refresh path still owns correctness
  }
};

export const clearManagedAiAccessCache = (
  cacheKey?: string | null,
  deps?: ManagedAiAccessCacheDeps,
) => {
  const resolved = cacheDeps(deps);
  if (resolved.isTauriRuntime()) {
    void resolved.proofCache?.clear?.(cacheKey).catch(() => undefined);
  }
  if (!resolved.storage) return;
  try {
    resolved.storage.removeItem(MANAGED_AI_ACCESS_CACHE_STORAGE_KEY);
  } catch {
    // ignore
  }
};

export const readManagedAiAccessProofCache = async (
  cacheKey: string,
  userId: string,
  deps?: ManagedAiAccessCacheDeps,
): Promise<ManagedAiAccessCacheRecord | null> => {
  const resolved = cacheDeps(deps);
  if (!cacheKey || !userId || !resolved.isTauriRuntime() || !resolved.proofCache?.read) {
    return null;
  }
  try {
    const proof = await resolved.proofCache.read({
      cacheKey,
      maxAgeMs: MANAGED_AI_ACCESS_PROOF_CACHE_TTL_MS,
    });
    if (!proof) return null;
    if (!isGatewayOwnedProvider(proof.providerId)) return null;
    if (proof.effectiveModel.providerID !== proof.providerId || !proof.effectiveModel.modelID.trim()) {
      return null;
    }
    const profile: ManagedAiAccessProfile = {
      userId,
      providerId: proof.providerId,
      effectiveModel: proof.effectiveModel,
      updatedAt: proof.updatedAt ?? null,
    };
    if (!isManagedAiAccessProfileValue(profile)) return null;
    return {
      schemaVersion: 1,
      cacheKey,
      fetchedAt: proof.fetchedAt,
      profile,
      gatewayAccessToken: "",
    };
  } catch {
    return null;
  }
};

export const loadManagedAiAccessSingleFlight = (
  cacheKey: string,
  load: () => Promise<VesloManagedAiAccessBundle>,
): Promise<VesloManagedAiAccessBundle> => {
  if (cacheKey && managedAiAccessRefreshInFlight?.cacheKey === cacheKey) {
    return managedAiAccessRefreshInFlight.promise;
  }

  const promise = load().finally(() => {
    if (managedAiAccessRefreshInFlight?.cacheKey === cacheKey) {
      managedAiAccessRefreshInFlight = null;
    }
  });

  if (cacheKey) {
    managedAiAccessRefreshInFlight = { cacheKey, promise };
  }

  return promise;
};

export function createManagedAiAccessStore(
  options: ManagedAiAccessStoreOptions,
): ManagedAiAccessStore {
  const effect = options.effect ?? ((fn: () => void) => createEffect(fn));
  const timers = {
    setTimeout:
      options.timers?.setTimeout ??
      ((callback: () => void, ms: number) => setTimeout(callback, ms)),
    clearTimeout:
      options.timers?.clearTimeout ??
      ((timeoutId: ReturnType<typeof setTimeout>) => clearTimeout(timeoutId)),
  };
  const windowTarget =
    options.windowTarget === undefined ? defaultWindowTarget() : options.windowTarget;
  const documentTarget =
    options.documentTarget === undefined ? defaultDocumentTarget() : options.documentTarget;
  const cacheOptions = (): ManagedAiAccessCacheDeps => ({
    storage: options.storage,
    proofCache: options.proofCache,
    isTauriRuntime: options.isTauriRuntime,
    now: options.now,
  });

  const [managedAiAccess, setManagedAiAccess] =
    createSignal<ManagedAiAccessProfile | null>(null);
  const [managedAiGatewayAccessToken, setManagedAiGatewayAccessToken] = createSignal("");
  const [managedAiAccessBusy, setManagedAiAccessBusy] = createSignal(false);
  const [managedAiAccessError, setManagedAiAccessError] = createSignal<string | null>(null);
  const [managedAiAccessRefreshNonce, setManagedAiAccessRefreshNonce] = createSignal(0);
  const [managedAiAccessRetryAttempt, setManagedAiAccessRetryAttempt] = createSignal(0);
  const [managedAiAccessRetryScheduled, setManagedAiAccessRetryScheduled] = createSignal(false);
  const [managedAiAccessProofCacheState, setManagedAiAccessProofCacheState] =
    createSignal<ManagedAiAccessProofCacheState>({
      cacheKey: "",
      loaded: true,
      record: null,
    });

  const denGatewayAccessToken = createMemo(() => {
    options.denAuthRevision();
    return options.readDenAuth()?.token?.trim() ?? "";
  });

  const managedAiAccessModel = createMemo(() => managedAiAccess()?.effectiveModel ?? null);

  const requestManagedAiAccessRefresh = () => {
    setManagedAiAccessRefreshNonce((value) => value + 1);
  };

  const managedAiAccessCacheContext = createMemo(() => {
    options.denAuthRevision();
    const gatewayClient = options.gatewayVesloServerClient();
    const managedAiBaseUrl = options.managedAiGatewayBaseUrl();
    const denAuth = options.readDenAuth();
    const gatewayBaseUrl =
      managedAiBaseUrl ||
      (options.isTauriRuntime() ? denAuth?.denApiBase ?? "" : "") ||
      gatewayClient?.baseUrl ||
      "";
    return {
      cacheKey: buildManagedAiAccessCacheKey({
        userId: denAuth?.user?.id,
        orgId: denAuth?.orgId || denAuth?.org?.id,
        gatewayBaseUrl,
      }),
      userId: denAuth?.user?.id?.trim() ?? "",
      gatewayBaseUrl,
    };
  });

  effect(() => {
    if (!options.isTauriRuntime()) return;
    const context = managedAiAccessCacheContext();
    const cacheKey = context.cacheKey.trim();
    const userId = context.userId.trim();
    if (!cacheKey || !userId) {
      setManagedAiAccessProofCacheState({ cacheKey, loaded: true, record: null });
      return;
    }
    const currentState = untrack(managedAiAccessProofCacheState);
    if (currentState.cacheKey === cacheKey && currentState.loaded) return;

    let cancelled = false;
    setManagedAiAccessProofCacheState({ cacheKey, loaded: false, record: null });
    void readManagedAiAccessProofCache(cacheKey, userId, cacheOptions())
      .then((record) => {
        if (cancelled) return;
        setManagedAiAccessProofCacheState({ cacheKey, loaded: true, record });
      })
      .catch(() => {
        if (cancelled) return;
        setManagedAiAccessProofCacheState({ cacheKey, loaded: true, record: null });
      });

    onCleanup(() => {
      cancelled = true;
    });
  });

  const translateManagedAiAccessMessage = (message: string | null | undefined) => {
    const trimmed = message?.trim() ?? "";
    if (!trimmed) return options.translate(AI_ACCESS_NOT_CONFIGURED_MESSAGE_KEY);
    const translationKey = resolveManagedAiAccessMessageKey(trimmed);
    return translationKey ? options.translate(translationKey) : trimmed;
  };

  const managedAiAccessMessage = createMemo(() => {
    if (managedAiAccess()) return options.translate(AI_ACCESS_ADMIN_MANAGED_MESSAGE_KEY);
    if (managedAiAccessBusy()) return options.translate(AI_ACCESS_LOADING_MESSAGE_KEY);
    return translateManagedAiAccessMessage(managedAiAccessError());
  });

  const managedAiAccessProviderLabel = createMemo(() => {
    const profile = managedAiAccess();
    if (!profile) return null;
    const provider = options.providers().find((entry) => entry.id === profile.providerId);
    return provider?.name ?? profile.providerId;
  });

  const managedAiAccessEffectiveModelLabel = createMemo(() => {
    const profile = managedAiAccess();
    if (!profile) return null;
    return options.formatModelLabel(profile.effectiveModel, options.providers());
  });

  const managedAiAccessBlockedReason = createMemo(() => {
    const userToken = denGatewayAccessToken();
    if (!userToken || !options.gatewayVesloServerClient()) {
      return null;
    }
    if (managedAiAccess()) return null;
    if (managedAiAccessBusy() || managedAiAccessRetryScheduled()) {
      return options.translate(AI_ACCESS_LOADING_MESSAGE_KEY);
    }
    return translateManagedAiAccessMessage(managedAiAccessError());
  });

  effect(() => {
    options.authenticatedUser();
    if (managedAiAccess()) return;

    const userToken = denGatewayAccessToken();
    const localAuth = options.vesloServerAuth();
    const hostInfo = options.activeVesloServerHostInfo();
    const workspace = options.activeWorkspaceDisplay();
    const workspaceType =
      workspace.workspaceType === "local" || workspace.workspaceType === "remote"
        ? workspace.workspaceType
        : null;

    if (
      !shouldEnsureManagedAiLocalGateway({
        isDesktopRuntime: options.isTauriRuntime(),
        workspaceType,
        userToken,
        localServerRunning: Boolean(hostInfo?.baseUrl?.trim()),
        localClientToken: localAuth.token,
      })
    ) {
      return;
    }

    let cancelled = false;
    void options.ensureLocalVesloServerRunning({ ignoreStartupPreference: true })
      .then((ok) => {
        if (!cancelled && ok) {
          requestManagedAiAccessRefresh();
        }
      })
      .catch((error) => {
        if (!cancelled) options.reportError(error, "managedAi.localGateway");
      });

    onCleanup(() => {
      cancelled = true;
    });
  });

  effect(() => {
    options.authenticatedUser();
    managedAiAccessRefreshNonce();

    const gatewayClient = options.gatewayVesloServerClient();
    const managedAiBaseUrl = options.managedAiGatewayBaseUrl();
    const userToken = denGatewayAccessToken();
    const denOrgId = options.readDenAuth()?.orgId?.trim() ?? "";
    const cacheContext = managedAiAccessCacheContext();
    const managedAiCacheKey = cacheContext.cacheKey;
    const gatewayLocalAuth = options.vesloServerAuth();
    const runtimeWorkspaceId = options.activeVesloServerWorkspaceId?.()?.trim() ?? "";
    const proofCacheState = managedAiAccessProofCacheState();
    if (
      options.isTauriRuntime() &&
      managedAiCacheKey &&
      (!proofCacheState.loaded || proofCacheState.cacheKey !== managedAiCacheKey)
    ) {
      if (!managedAiAccess()) {
        setManagedAiAccessBusy(true);
      }
      return;
    }

    const proofCachedAccess =
      options.isTauriRuntime() && proofCacheState.cacheKey === managedAiCacheKey
        ? proofCacheState.record
        : null;
    const cachedAccess =
      proofCachedAccess ?? readManagedAiAccessCache(managedAiCacheKey, cacheOptions());
    const refreshPreflight = resolveManagedAiAccessRefreshPreflight({
      hasGatewayClient: Boolean(gatewayClient),
      managedAiBaseUrl,
      userToken,
      deferForLocalGateway: shouldDeferManagedAiAccessRefresh({
        gatewayBaseUrl: managedAiBaseUrl || gatewayClient?.baseUrl || "",
        isDesktopRuntime: options.isTauriRuntime(),
        localClientToken: gatewayLocalAuth.token,
      }),
      cachedAccessPresent: Boolean(cachedAccess),
      freshCachedAccessPresent: Boolean(proofCachedAccess?.gatewayAccessToken),
    });
    if (refreshPreflight.type === "reset") {
      setManagedAiAccess(null);
      setManagedAiGatewayAccessToken("");
      setManagedAiAccessBusy(false);
      setManagedAiAccessError(null);
      setManagedAiAccessRetryAttempt(0);
      setManagedAiAccessRetryScheduled(false);
      return;
    }
    if (refreshPreflight.type === "use-cache") {
      if (cachedAccess) {
        setManagedAiAccess(cachedAccess.profile);
        setManagedAiGatewayAccessToken(cachedAccess.gatewayAccessToken);
        setManagedAiAccessError(null);
      }
      setManagedAiAccessBusy(false);
      setManagedAiAccessRetryAttempt(0);
      return;
    }

    let cancelled = false;
    let retryTimeoutId: ReturnType<typeof setTimeout> | null = null;
    if (refreshPreflight.applyCachedAccessFirst && cachedAccess) {
      setManagedAiAccess(cachedAccess.profile);
      setManagedAiGatewayAccessToken(cachedAccess.gatewayAccessToken);
      setManagedAiAccessError(null);
    }
    setManagedAiAccessBusy(true);
    setManagedAiAccessError(null);

    const scheduleRetry = (profilePresent: boolean) => {
      if (
        !shouldRetryManagedAiAccessRefresh({
          hasGatewayClient: true,
          userToken,
          profilePresent,
        })
      ) {
        setManagedAiAccessRetryAttempt(0);
        setManagedAiAccessRetryScheduled(false);
        return;
      }

      const delayMs = resolveManagedAiAccessRetryDelayMs(managedAiAccessRetryAttempt());
      setManagedAiAccessRetryScheduled(true);
      retryTimeoutId = timers.setTimeout(() => {
        if (cancelled) return;
        setManagedAiAccessRetryScheduled(false);
        setManagedAiAccessRetryAttempt((value) => value + 1);
        requestManagedAiAccessRefresh();
      }, delayMs);
    };

    const loadManagedAiAccess = loadManagedAiAccessSingleFlight(
      gatewayClient && runtimeWorkspaceId
        ? `${managedAiCacheKey}|runtime-workspace:${runtimeWorkspaceId}`
        : managedAiCacheKey,
      () => {
        if (managedAiBaseUrl) {
          if (!options.requestManagedAiAccessBundle) {
            throw new Error("managed AI access bundle requester is not configured");
          }
          return options.requestManagedAiAccessBundle(managedAiBaseUrl, userToken, denOrgId);
        }
        return gatewayClient!.getMyAiAccess(userToken, denOrgId, runtimeWorkspaceId || undefined);
      },
    );

    void loadManagedAiAccess
      .then((response) => {
        if (cancelled) return;
        const { profile, gatewayAccessToken, reason } = resolveManagedAiAccessBundleState({
          aiAccess: response.aiAccess,
          accessToken: response.accessToken,
          fallbackAccessToken: userToken,
          requireGatewayAccessToken: Boolean(managedAiBaseUrl),
        });
        const successDecision = resolveManagedAiAccessRefreshSuccess({
          profile,
          gatewayAccessToken,
          reason,
        });
        if (successDecision.type === "apply-profile") {
          setManagedAiAccess(successDecision.profile);
          setManagedAiGatewayAccessToken(successDecision.gatewayAccessToken);
          setManagedAiAccessError(successDecision.error);
          writeManagedAiAccessCache(
            managedAiCacheKey,
            successDecision.profile,
            successDecision.gatewayAccessToken,
            cacheOptions(),
          );
          setManagedAiAccessRetryAttempt(0);
          setManagedAiAccessRetryScheduled(false);
          return;
        }
        setManagedAiAccess(null);
        setManagedAiGatewayAccessToken(successDecision.gatewayAccessToken);
        setManagedAiAccessError(successDecision.error);
        clearManagedAiAccessCache(managedAiCacheKey, cacheOptions());
        scheduleRetry(false);
      })
      .catch((error) => {
        if (cancelled) return;
        const failureDecision = resolveManagedAiAccessRefreshFailure({
          cachedAccessPresent: Boolean(cachedAccess),
          errorMessage: options.describeRequestError(
            error,
            options.translate(AI_ACCESS_LOAD_FAILED_MESSAGE_KEY),
          ),
        });
        if (failureDecision.clearProfile) {
          setManagedAiAccess(null);
        }
        if (failureDecision.gatewayAccessToken !== null) {
          setManagedAiGatewayAccessToken(failureDecision.gatewayAccessToken);
        }
        setManagedAiAccessError(failureDecision.error);
        scheduleRetry(false);
      })
      .finally(() => {
        if (cancelled) return;
        setManagedAiAccessBusy(false);
      });

    onCleanup(() => {
      cancelled = true;
      if (retryTimeoutId != null) {
        timers.clearTimeout(retryTimeoutId);
      }
      setManagedAiAccessRetryScheduled(false);
    });
  });

  effect(() => {
    options.authenticatedUser();

    if (!windowTarget || !documentTarget) return;
    const gatewayClient = options.gatewayVesloServerClient();
    const userToken = denGatewayAccessToken();
    if (!gatewayClient || !userToken) return;

    const refresh = () => {
      if (documentTarget.visibilityState === "hidden") {
        return;
      }
      requestManagedAiAccessRefresh();
    };

    windowTarget.addEventListener("focus", refresh);
    documentTarget.addEventListener("visibilitychange", refresh);

    onCleanup(() => {
      windowTarget.removeEventListener("focus", refresh);
      documentTarget.removeEventListener("visibilitychange", refresh);
    });
  });

  const writeCurrentManagedAiAccessCache = (
    profile: ManagedAiAccessProfile,
    gatewayAccessToken: string,
  ) => {
    writeManagedAiAccessCache(
      managedAiAccessCacheContext().cacheKey,
      profile,
      gatewayAccessToken,
      cacheOptions(),
    );
  };

  const applyManagedAiAccessProfile = (
    profile: ManagedAiAccessProfile,
    gatewayAccessToken: string,
    applyOptions?: { writeCache?: boolean },
  ) => {
    setManagedAiAccess(profile);
    setManagedAiGatewayAccessToken(gatewayAccessToken);
    setManagedAiAccessError(null);
    if (applyOptions?.writeCache) {
      writeCurrentManagedAiAccessCache(profile, gatewayAccessToken);
    }
  };

  return {
    managedAiAccess,
    managedAiGatewayAccessToken,
    managedAiAccessBusy,
    managedAiAccessError,
    managedAiAccessRetryScheduled,
    managedAiAccessModel,
    denGatewayAccessToken,
    managedAiAccessMessage,
    managedAiAccessProviderLabel,
    managedAiAccessEffectiveModelLabel,
    managedAiAccessBlockedReason,
    requestManagedAiAccessRefresh,
    clearManagedAiAccessCache: (cacheKey?: string | null) =>
      clearManagedAiAccessCache(cacheKey, cacheOptions()),
    writeCurrentManagedAiAccessCache,
    applyManagedAiAccessProfile,
    setManagedAiAccessError,
  };
}
