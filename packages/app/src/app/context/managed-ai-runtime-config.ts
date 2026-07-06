import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import { parse } from "jsonc-parser";

import {
  resolveManagedAiConfigSyncPreflight,
  resolveManagedAiConfigWriteDecision,
} from "../controllers/managed-ai-config-sync";
import {
  extractManagedApiKey,
  formatManagedAiAccessConfig,
  hasUsableManagedAiRuntimeConfig,
  requiresManagedAiEngineBaseUrl,
  resolveManagedAiAccessBundleState,
  resolveManagedAiProviderRoutingTarget,
  shouldPreserveManagedAiConfig,
  type ManagedAiAccessProfile,
} from "../lib/ai-access";
import { shouldAutoReloadManagedAiConfig } from "../lib/managed-ai-config-reload";
import {
  resolveEffectiveRuntimeSandboxState,
  type EffectiveRuntimeSandboxState,
  type RuntimeSandboxCapability,
  type RuntimeSandboxEngineInfo,
  type RuntimeSandboxEngineSnapshot,
} from "../lib/runtime-sandbox-state";
import {
  type VesloUserAiAccess,
  type VesloServerStatus,
} from "../lib/veslo-server";
import {
  formatConfigWithDefaultModel,
  parseDefaultModelFromConfig,
} from "../lib/model-persistence";
import { managedConfigContentsMatchForServerPatch } from "../lib/opencode";
import type { SendRuntimePreflightTargetWorkspace } from "./send-runtime-readiness";
import type { ModelRef } from "../types";
import {
  formatModelRef,
  modelEquals,
  normalizeDirectoryPath,
  parseModelRef,
} from "../utils";

export type ManagedAiRuntimeWorkspace = {
  id?: string | null;
  vesloWorkspaceId?: string | null;
  workspaceType?: "local" | "remote" | string | null;
  path?: string | null;
  directory?: string | null;
};

export type ManagedAiRuntimeRoutingInfo = {
  baseUrl?: string | null;
  engineUrl?: string | null;
  clientToken?: string | null;
  hostToken?: string | null;
};

export type ManagedAiRuntimeGatewayClient = {
  baseUrl: string;
  token?: string | null;
};

export type ManagedAiRuntimeConfigCapabilities = {
  config?: { read?: boolean | null; write?: boolean | null } | null;
  sandbox?: RuntimeSandboxCapability;
} | null;

export type ManagedAiRuntimeConfigVesloClient = {
  baseUrl: string;
  token?: string | null;
  getConfig: (workspaceId: string) => Promise<{ opencode?: Record<string, unknown> | null }>;
  patchConfig: (
    workspaceId: string,
    payload: { opencode?: Record<string, unknown> },
  ) => Promise<unknown>;
  listWorkspaces: () => Promise<{
    items?: Array<{ id: string; workspaceType?: string | null }> | null;
  }>;
};

export type ManagedAiRuntimeConfigRuntimeClient = {
  baseUrl: string;
  getMyAiAccess: (userToken: string) => Promise<{
    aiAccess?: VesloUserAiAccess | null;
    accessToken?: string | null;
  }>;
};

export type ManagedAiRuntimeConfigSyncOptions = {
  effect?: (fn: () => void) => void;
  isTauriRuntime: Accessor<boolean>;
  workspaceDefaultModelReady: Accessor<boolean>;
  defaultModelExplicit: Accessor<boolean>;
  defaultModel: Accessor<ModelRef>;
  managedAiAccess: Accessor<ManagedAiAccessProfile | null>;
  managedAiAccessBusy: Accessor<boolean>;
  managedAiAccessError: Accessor<string | null>;
  managedAiGatewayAccessToken: Accessor<string>;
  denGatewayAccessToken: Accessor<string>;
  denAuthRevision: Accessor<number>;
  gatewayVesloServerClient: Accessor<ManagedAiRuntimeGatewayClient | null>;
  vesloServerClient: Accessor<ManagedAiRuntimeConfigVesloClient | null>;
  vesloServerStatus: Accessor<VesloServerStatus>;
  vesloServerWorkspaceId: Accessor<string | null | undefined>;
  resolvedVesloCapabilities: Accessor<ManagedAiRuntimeConfigCapabilities>;
  activeVesloServerRoutingInfo: Accessor<ManagedAiRuntimeRoutingInfo | null>;
  baseUrl: Accessor<string>;
  activeWorkspaceDisplay: Accessor<ManagedAiRuntimeWorkspace>;
  activeWorkspaceId: Accessor<string>;
  activeWorkspaceRoot: Accessor<string>;
  activeWorkspacePath: Accessor<string>;
  workspaces: Accessor<ManagedAiRuntimeWorkspace[]>;
  engine: Accessor<RuntimeSandboxEngineInfo>;
  orchestratorStatusEngines: Accessor<RuntimeSandboxEngineSnapshot[]>;
  orchestratorEngines: Accessor<RuntimeSandboxEngineSnapshot[]>;
  resolveConversationServerWorkspaceId: (workspaceId: string) => string | null;
  ensureConversationReadWorkspaceRegistered: (
    client: ManagedAiRuntimeConfigVesloClient,
    workspaceId: string,
    workspaceRoot?: string | null,
  ) => Promise<string | null>;
  readOpencodeConfig: (
    scope: "project",
    root: string,
  ) => Promise<{ content: string | null }>;
  writeOpencodeConfig: (
    scope: "project",
    root: string,
    content: string,
  ) => Promise<{ ok: boolean; stdout?: string; stderr?: string }>;
  markReloadRequired: (
    scope: "config",
    change: { type: "config"; name: string; action: "updated" },
  ) => void;
  anyActiveRuns: Accessor<boolean>;
  sendPromptInFlight: Accessor<boolean>;
  canReloadWorkspace: Accessor<boolean>;
  setError: (message: string | null) => void;
  reportError: (error: unknown, scope: string) => void;
  addOpencodeCacheHint: (message: string) => string;
  safeStringify: (value: unknown) => string;
  recordManagedAiWorkflowTrace: (event: string, payload: Record<string, unknown>) => void;
  createVesloServerClient: (input: {
    baseUrl: string;
    token?: string;
    hostToken?: string;
  }) => ManagedAiRuntimeConfigRuntimeClient;
  applyManagedAiAccessProfile: (
    profile: ManagedAiAccessProfile,
    gatewayAccessToken: string,
    options?: { writeCache?: boolean },
  ) => void;
  setManagedAiAccessError: (message: string | null) => void;
  beginManagedAiBootstrap?: () => (() => void);
  shouldRetryManagedAiConfigReadForSend?: (error: unknown, baseUrl: string) => boolean;
  delay?: (ms: number) => Promise<void>;
  random?: () => number;
};

export type ManagedAiRuntimeConfigSync = {
  resolveRuntimeSandboxStateForTarget: (
    targetWorkspace?: SendRuntimePreflightTargetWorkspace | null,
  ) => EffectiveRuntimeSandboxState;
  hasUsableManagedAiRuntimeConfigForSend: (
    targetWorkspace?: SendRuntimePreflightTargetWorkspace | null,
  ) => Promise<boolean>;
  ensureManagedAiRuntimeAuthorizationForSend: (
    targetWorkspace?: SendRuntimePreflightTargetWorkspace | null,
  ) => Promise<boolean>;
  syncActiveWorkspaceManagedAiConfig: () => Promise<void>;
  healInactiveManagedAiWorkspaceConfigs: () => Promise<void>;
  rememberKnownConfigSnapshot: (key: string, content: string | null) => void;
  clearManagedConfigTracking: () => void;
};

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeUrlForManagedAiTrace(value: string | null | undefined): Record<string, unknown> {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return { present: false };
  try {
    const parsed = new URL(trimmed);
    return {
      present: true,
      origin: parsed.origin,
      pathname: parsed.pathname.replace(/\/+$/, "") || "/",
    };
  } catch {
    return {
      present: true,
      invalid: true,
      length: trimmed.length,
    };
  }
}

function getConfigSnapshot(content: string | null): string {
  if (!content?.trim()) return "";
  try {
    const parsed = parse(content) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const copy = { ...parsed };
      delete copy.model;
      return JSON.stringify(copy);
    }
    return content;
  } catch {
    return content;
  }
}

function workspaceKind(workspace: ManagedAiRuntimeWorkspace): "local" | "remote" | null {
  return workspace.workspaceType === "local" || workspace.workspaceType === "remote"
    ? workspace.workspaceType
    : null;
}

async function resolveManagedAiServerWorkspaceId(input: {
  client: ManagedAiRuntimeConfigVesloClient;
  workspace: ManagedAiRuntimeWorkspace;
  workspaceId: string;
  workspaceRoot?: string | null;
  resolvedWorkspaceId?: string | null;
  register: ManagedAiRuntimeConfigSyncOptions["ensureConversationReadWorkspaceRegistered"];
}): Promise<string> {
  const resolved = input.resolvedWorkspaceId?.trim() ?? "";
  const workspaceId = input.workspaceId.trim();
  if (!workspaceId || workspaceKind(input.workspace) !== "local") return resolved;
  if (input.workspace.vesloWorkspaceId?.trim()) return resolved;

  const registered = await input.register(input.client, workspaceId, input.workspaceRoot);
  return registered?.trim() || "";
}

export function createManagedAiRuntimeConfigSync(
  deps: ManagedAiRuntimeConfigSyncOptions,
): ManagedAiRuntimeConfigSync {
  const effect = deps.effect ?? ((fn: () => void) => createEffect(fn));
  const delay = deps.delay ?? defaultDelay;
  const random = deps.random ?? Math.random;
  const lastKnownConfigSnapshotByWs = new Map<string, string>();
  const inactiveWorkspaceBaseUrlHealedFor = new Map<string, string>();
  let managedAiConfigSyncGeneration = 0;
  let inactiveWorkspaceBaseUrlHealGeneration = 0;
  let lastManagedAiAccessResetKey = "";
  const [
    lastManagedAiConfigAppliedForServerToken,
    setLastManagedAiConfigAppliedForServerToken,
  ] = createSignal("");

  const clearManagedConfigTracking = () => {
    setLastManagedAiConfigAppliedForServerToken("");
    lastKnownConfigSnapshotByWs.clear();
    inactiveWorkspaceBaseUrlHealedFor.clear();
  };

  const rememberKnownConfigSnapshot = (key: string, content: string | null) => {
    const normalizedKey = key.trim();
    if (!normalizedKey) return;
    lastKnownConfigSnapshotByWs.set(normalizedKey, getConfigSnapshot(content));
  };

  const markManagedAiConfigApplied = (reloadKey: string): void => {
    const normalized = reloadKey.trim();
    if (!normalized) return;
    if (lastManagedAiConfigAppliedForServerToken() === normalized) return;
    setLastManagedAiConfigAppliedForServerToken(normalized);
  };

  const resolveRuntimeSandboxStateForTarget = (
    targetWorkspace?: SendRuntimePreflightTargetWorkspace | null,
  ): EffectiveRuntimeSandboxState => {
    const activeWorkspaceId = deps.activeWorkspaceId().trim();
    const targetWorkspaceId = targetWorkspace?.workspaceId?.trim() || activeWorkspaceId;
    const targetWorkspaceEntry = targetWorkspaceId
      ? deps.workspaces().find((entry) => entry.id?.trim() === targetWorkspaceId)
      : undefined;
    const targetWorkspaceRoot =
      targetWorkspace?.workspaceRoot?.trim() ||
      targetWorkspace?.directory?.trim() ||
      targetWorkspaceEntry?.path?.trim() ||
      targetWorkspaceEntry?.directory?.trim() ||
      (targetWorkspaceId === activeWorkspaceId ? deps.activeWorkspaceRoot().trim() : "");
    const activeEngineInfo = deps.engine();
    const activeEngineProjectDir = normalizeDirectoryPath(activeEngineInfo?.projectDir ?? "");
    const normalizedTargetRoot = normalizeDirectoryPath(targetWorkspaceRoot);
    const engineInfoMatchesTarget =
      !targetWorkspaceId ||
      targetWorkspaceId === activeWorkspaceId ||
      (Boolean(activeEngineProjectDir) && activeEngineProjectDir === normalizedTargetRoot);
    const statusEngines = deps.orchestratorStatusEngines();
    const liveEngines = deps.orchestratorEngines();
    return resolveEffectiveRuntimeSandboxState({
      configuredSandbox: deps.resolvedVesloCapabilities()?.sandbox,
      engineInfo: engineInfoMatchesTarget ? activeEngineInfo : null,
      orchestratorEngines: liveEngines.length ? liveEngines : statusEngines,
      targetWorkspaceId,
      targetWorkspaceRoot,
    });
  };

  const readManagedAiRuntimeConfigForSend = async (
    client: ManagedAiRuntimeConfigVesloClient,
    workspaceId: string,
    baseUrl: string,
    tracePayload: Record<string, unknown>,
  ): Promise<{ opencode?: Record<string, unknown> | null }> => {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await client.getConfig(workspaceId);
      } catch (error) {
        if (
          attempt >= maxAttempts ||
          !deps.shouldRetryManagedAiConfigReadForSend?.(error, baseUrl)
        ) {
          throw error;
        }
        const delayMs = 120 + Math.floor(random() * 180);
        deps.recordManagedAiWorkflowTrace("managed-ai-runtime-config-check:retry", {
          ...tracePayload,
          vesloWorkspaceId: workspaceId,
          attempt,
          nextAttempt: attempt + 1,
          delayMs,
          message: error instanceof Error ? error.message : deps.safeStringify(error),
        });
        await delay(delayMs);
      }
    }
    throw new Error("managed AI runtime config read retry loop exhausted");
  };

  const buildProviderRoutingContext = (
    workspace: ManagedAiRuntimeWorkspace,
    targetWorkspaceId: string,
    targetWorkspaceRoot: string,
  ) => {
    const providerRoutingLocalHost = deps.activeVesloServerRoutingInfo();
    const providerRoutingLocalBaseUrl = providerRoutingLocalHost?.baseUrl ?? "";
    const providerRoutingEngineBaseUrl = providerRoutingLocalHost?.engineUrl ?? "";
    const runtimeSandboxState = resolveRuntimeSandboxStateForTarget({
      workspaceId: targetWorkspaceId || null,
      workspaceRoot: targetWorkspaceRoot || null,
      directory: targetWorkspaceRoot || null,
    });
    const providerRoutingRequiresEngineBaseUrl = requiresManagedAiEngineBaseUrl({
      isDesktopRuntime: deps.isTauriRuntime(),
      workspaceType: workspaceKind(workspace),
      engineBaseUrl: providerRoutingEngineBaseUrl,
      requiresEngineBridgeUrl: runtimeSandboxState.requiresEngineBridgeUrl,
      configuredSandboxEnabled: runtimeSandboxState.configuredEnabled,
      configuredSandboxBackend: runtimeSandboxState.configuredBackend,
      effectiveSandboxBackend: runtimeSandboxState.effectiveBackend,
      childKind: runtimeSandboxState.childKind,
      sandboxEnabled: runtimeSandboxState.isSandboxed,
      sandboxBackend: runtimeSandboxState.effectiveBackend,
    });
    const gatewayClient = deps.gatewayVesloServerClient();
    const providerRoutingTarget = resolveManagedAiProviderRoutingTarget({
      isDesktopRuntime: deps.isTauriRuntime(),
      workspaceType: workspaceKind(workspace),
      activeBaseUrl: providerRoutingLocalBaseUrl,
      engineBaseUrl: providerRoutingEngineBaseUrl,
      requireEngineBaseUrl: providerRoutingRequiresEngineBaseUrl,
      activeToken: providerRoutingLocalHost?.clientToken ?? "",
      gatewayBaseUrl: gatewayClient?.baseUrl ?? "",
      gatewayToken: gatewayClient?.token ?? "",
    });
    const tracePayload = {
      targetWorkspaceId: targetWorkspaceId || null,
      activeWorkspaceId: deps.activeWorkspaceId().trim() || null,
      workspaceType: workspace.workspaceType,
      workspaceRoot: targetWorkspaceRoot || null,
      providerId: deps.managedAiAccess()?.providerId ?? null,
      requiresEngineBaseUrl: providerRoutingRequiresEngineBaseUrl,
      configuredSandboxBackend: runtimeSandboxState.configuredBackend,
      effectiveSandboxBackend: runtimeSandboxState.effectiveBackend,
      engineChildKind: runtimeSandboxState.childKind,
      sandboxFallback: runtimeSandboxState.sandboxFallback,
      localBaseUrl: summarizeUrlForManagedAiTrace(providerRoutingLocalBaseUrl),
      engineBaseUrl: summarizeUrlForManagedAiTrace(providerRoutingEngineBaseUrl),
      resolvedBaseUrl: summarizeUrlForManagedAiTrace(providerRoutingTarget?.baseUrl ?? null),
      resolvedEngineBaseUrl: summarizeUrlForManagedAiTrace(providerRoutingTarget?.engineBaseUrl ?? null),
      hasLocalClientToken: Boolean(providerRoutingLocalHost?.clientToken),
      hasLocalHostToken: Boolean(providerRoutingLocalHost?.hostToken),
      hasGatewayClient: Boolean(gatewayClient),
      hasGatewayToken: Boolean(gatewayClient?.token),
      hasRoutingTarget: Boolean(providerRoutingTarget),
      hasServerClientToken: Boolean(providerRoutingTarget?.serverClientToken),
    };
    return {
      providerRoutingLocalHost,
      providerRoutingLocalBaseUrl,
      providerRoutingEngineBaseUrl,
      runtimeSandboxState,
      providerRoutingRequiresEngineBaseUrl,
      gatewayClient,
      providerRoutingTarget,
      tracePayload,
    };
  };

  const hasUsableManagedAiRuntimeConfigForSend = async (
    targetWorkspace?: SendRuntimePreflightTargetWorkspace | null,
  ): Promise<boolean> => {
    if (!deps.isTauriRuntime()) {
      deps.recordManagedAiWorkflowTrace("managed-ai-runtime-config-check:skip", {
        reason: "not-tauri-runtime",
      });
      return false;
    }
    const targetWorkspaceId = targetWorkspace?.workspaceId?.trim() ?? "";
    const targetWorkspaceEntry = targetWorkspaceId
      ? deps.workspaces().find((entry) => entry.id?.trim() === targetWorkspaceId)
      : undefined;
    const workspace = targetWorkspaceEntry || deps.activeWorkspaceDisplay();
    if (workspace.workspaceType !== "local") {
      deps.recordManagedAiWorkflowTrace("managed-ai-runtime-config-check:skip", {
        reason: "non-local-workspace",
        targetWorkspaceId: targetWorkspaceId || null,
        workspaceType: workspace.workspaceType,
      });
      return false;
    }
    const targetWorkspaceRoot =
      targetWorkspace?.workspaceRoot?.trim() ||
      targetWorkspace?.directory?.trim() ||
      workspace.path?.trim() ||
      workspace.directory?.trim() ||
      (targetWorkspaceId === deps.activeWorkspaceId().trim() ? deps.activeWorkspaceRoot().trim() : "");
    const routing = buildProviderRoutingContext(workspace, targetWorkspaceId, targetWorkspaceRoot);
    deps.recordManagedAiWorkflowTrace("managed-ai-runtime-config-check:start", routing.tracePayload);
    if (!routing.providerRoutingTarget?.serverClientToken) {
      deps.recordManagedAiWorkflowTrace("managed-ai-runtime-config-check:skip", {
        ...routing.tracePayload,
        reason: "provider-routing-target-missing",
      });
      return false;
    }

    const providerId = deps.managedAiAccess()?.providerId ?? null;
    const vesloClient = deps.vesloServerClient();
    let vesloWorkspaceId = deps.resolveConversationServerWorkspaceId(
      targetWorkspaceId || deps.activeWorkspaceId().trim(),
    );
    const capabilities = deps.resolvedVesloCapabilities();
    const canUseVesloServer =
      deps.vesloServerStatus() === "connected" &&
      vesloClient &&
      capabilities?.config?.read;

    try {
      if (canUseVesloServer && vesloClient) {
        vesloWorkspaceId = await resolveManagedAiServerWorkspaceId({
          client: vesloClient,
          workspace,
          workspaceId: targetWorkspaceId || deps.activeWorkspaceId().trim(),
          workspaceRoot: targetWorkspaceRoot,
          resolvedWorkspaceId: vesloWorkspaceId,
          register: deps.ensureConversationReadWorkspaceRegistered,
        });
        if (!vesloWorkspaceId) {
          deps.recordManagedAiWorkflowTrace("managed-ai-runtime-config-check:result", {
            ...routing.tracePayload,
            configSource: "veslo-server-config",
            ok: false,
            reason: "veslo-workspace-id-missing",
          });
          return false;
        }
        const config = await readManagedAiRuntimeConfigForSend(
          vesloClient,
          vesloWorkspaceId,
          vesloClient.baseUrl,
          routing.tracePayload,
        );
        const ok = hasUsableManagedAiRuntimeConfig({
          content: JSON.stringify(config.opencode ?? {}, null, 2),
          providerId,
          gatewayBaseUrl: routing.providerRoutingTarget.engineBaseUrl,
          serverClientToken: routing.providerRoutingTarget.serverClientToken,
          workspaceId: vesloWorkspaceId,
        });
        deps.recordManagedAiWorkflowTrace("managed-ai-runtime-config-check:result", {
          ...routing.tracePayload,
          configSource: "veslo-server-config",
          vesloWorkspaceId,
          ok,
        });
        return ok;
      }

      const root = targetWorkspaceRoot || deps.activeWorkspacePath().trim();
      if (!root) {
        deps.recordManagedAiWorkflowTrace("managed-ai-runtime-config-check:result", {
          ...routing.tracePayload,
          configSource: "project-config-file",
          ok: false,
          reason: "workspace-root-missing",
        });
        return false;
      }
      const configFile = await deps.readOpencodeConfig("project", root);
      const ok = hasUsableManagedAiRuntimeConfig({
        content: configFile.content,
        providerId,
        gatewayBaseUrl: routing.providerRoutingTarget.engineBaseUrl,
        serverClientToken: routing.providerRoutingTarget.serverClientToken,
        workspaceId: vesloWorkspaceId,
      });
      deps.recordManagedAiWorkflowTrace("managed-ai-runtime-config-check:result", {
        ...routing.tracePayload,
        configSource: "project-config-file",
        root,
        ok,
      });
      return ok;
    } catch (error) {
      deps.recordManagedAiWorkflowTrace("managed-ai-runtime-config-check:error", {
        ...routing.tracePayload,
        message: error instanceof Error ? error.message : deps.safeStringify(error),
      });
      return false;
    }
  };

  const ensureManagedAiRuntimeAuthorizationForSend = async (
    targetWorkspace?: SendRuntimePreflightTargetWorkspace | null,
  ): Promise<boolean> => {
    if (!deps.isTauriRuntime()) return true;
    const userToken = deps.denGatewayAccessToken();
    if (!userToken) {
      deps.recordManagedAiWorkflowTrace("managed-ai-runtime-auth-prime:skip", {
        reason: "missing-user-token",
      });
      return false;
    }

    const targetWorkspaceId = targetWorkspace?.workspaceId?.trim() ?? "";
    const targetWorkspaceEntry = targetWorkspaceId
      ? deps.workspaces().find((entry) => entry.id?.trim() === targetWorkspaceId)
      : undefined;
    const workspace = targetWorkspaceEntry || deps.activeWorkspaceDisplay();
    if (workspace.workspaceType !== "local") {
      deps.recordManagedAiWorkflowTrace("managed-ai-runtime-auth-prime:skip", {
        reason: "non-local-workspace",
        targetWorkspaceId: targetWorkspaceId || null,
        workspaceType: workspace.workspaceType,
      });
      return true;
    }

    const targetWorkspaceRoot =
      targetWorkspace?.workspaceRoot?.trim() ||
      targetWorkspace?.directory?.trim() ||
      workspace.path?.trim() ||
      workspace.directory?.trim() ||
      (targetWorkspaceId === deps.activeWorkspaceId().trim() ? deps.activeWorkspaceRoot().trim() : "");
    const routing = buildProviderRoutingContext(workspace, targetWorkspaceId, targetWorkspaceRoot);

    if (!routing.providerRoutingTarget?.baseUrl || !routing.providerRoutingTarget.serverClientToken) {
      deps.recordManagedAiWorkflowTrace("managed-ai-runtime-auth-prime:skip", {
        ...routing.tracePayload,
        reason: "provider-routing-target-missing",
      });
      return false;
    }

    deps.recordManagedAiWorkflowTrace("managed-ai-runtime-auth-prime:start", routing.tracePayload);
    try {
      const runtimeClient = deps.createVesloServerClient({
        baseUrl: routing.providerRoutingTarget.baseUrl,
        token: routing.providerRoutingTarget.serverClientToken,
        hostToken: routing.providerRoutingLocalHost?.hostToken || undefined,
      });
      const response = await runtimeClient.getMyAiAccess(userToken);
      const { profile, gatewayAccessToken, reason } = resolveManagedAiAccessBundleState({
        aiAccess: response.aiAccess,
        accessToken: response.accessToken,
        fallbackAccessToken: userToken,
        requireGatewayAccessToken: false,
      });
      if (!profile) {
        deps.recordManagedAiWorkflowTrace("managed-ai-runtime-auth-prime:result", {
          ...routing.tracePayload,
          ok: false,
          reason,
        });
        if (reason) deps.setManagedAiAccessError(reason);
        return false;
      }

      deps.applyManagedAiAccessProfile(profile, gatewayAccessToken, { writeCache: true });
      deps.recordManagedAiWorkflowTrace("managed-ai-runtime-auth-prime:result", {
        ...routing.tracePayload,
        ok: true,
        providerId: profile.providerId,
        defaultModelId: profile.defaultModel.modelID,
        gatewayAccessTokenPresent: Boolean(gatewayAccessToken),
      });
      return true;
    } catch (error) {
      deps.recordManagedAiWorkflowTrace("managed-ai-runtime-auth-prime:error", {
        ...routing.tracePayload,
        message: error instanceof Error ? error.message : deps.safeStringify(error),
      });
      return false;
    }
  };

  const syncActiveWorkspaceManagedAiConfig = async (
    options?: { isCancelled?: () => boolean },
  ): Promise<void> => {
    const workspace = deps.activeWorkspaceDisplay();
    const syncPreflight = resolveManagedAiConfigSyncPreflight({
      workspaceDefaultModelReady: deps.workspaceDefaultModelReady(),
      isDesktopRuntime: deps.isTauriRuntime(),
      defaultModelExplicit: deps.defaultModelExplicit(),
      workspaceType: workspaceKind(workspace),
      workspaceRoot: deps.activeWorkspacePath(),
    });
    if (syncPreflight.type === "skip") return;
    deps.denAuthRevision();

    const root = syncPreflight.workspaceRoot;
    const nextModel = deps.defaultModel();
    const managedProfile = deps.managedAiAccess();
    const managedAccessBusy = managedProfile ? false : deps.managedAiAccessBusy();
    const managedAccessError = managedProfile ? null : deps.managedAiAccessError();
    const vesloClient = deps.vesloServerClient();
    const workspaceId = workspace.id?.trim() || deps.activeWorkspaceId().trim();
    let vesloWorkspaceId = deps.resolveConversationServerWorkspaceId(workspaceId);
    const vesloCapabilities = deps.resolvedVesloCapabilities();
    const routing = buildProviderRoutingContext(workspace, workspaceId, root);
    const gatewayAccessToken = deps.managedAiGatewayAccessToken() || deps.denGatewayAccessToken();
    const canUseVesloServerBase =
      deps.vesloServerStatus() === "connected" &&
      vesloClient &&
      vesloCapabilities?.config?.write;
    const providerRoutingReady = Boolean(
      routing.providerRoutingTarget?.serverClientToken && gatewayAccessToken,
    );
    const providerRoutingReloadKey = routing.providerRoutingTarget
      ? `${routing.providerRoutingTarget.serverClientToken}@${routing.providerRoutingTarget.engineBaseUrl}`
      : "";
    let configSyncTracePayload = {
      workspaceId: workspace.id || null,
      workspaceType: workspace.workspaceType,
      workspaceRoot: root || null,
      vesloWorkspaceId: vesloWorkspaceId || null,
      managedProviderId: managedProfile?.providerId ?? null,
      managedDefaultModelId: managedProfile?.defaultModel.modelID ?? null,
      managedAllowedModelCount: managedProfile?.allowedModels.length ?? 0,
      providerRoutingReady,
      providerRoutingRequiresEngineBaseUrl: routing.providerRoutingRequiresEngineBaseUrl,
      configuredSandboxBackend: routing.runtimeSandboxState.configuredBackend,
      effectiveSandboxBackend: routing.runtimeSandboxState.effectiveBackend,
      engineChildKind: routing.runtimeSandboxState.childKind,
      sandboxFallback: routing.runtimeSandboxState.sandboxFallback,
      localBaseUrl: summarizeUrlForManagedAiTrace(routing.providerRoutingLocalBaseUrl),
      engineBaseUrl: summarizeUrlForManagedAiTrace(routing.providerRoutingEngineBaseUrl),
      resolvedBaseUrl: summarizeUrlForManagedAiTrace(routing.providerRoutingTarget?.baseUrl ?? null),
      resolvedEngineBaseUrl: summarizeUrlForManagedAiTrace(routing.providerRoutingTarget?.engineBaseUrl ?? null),
      hasLocalClientToken: Boolean(routing.providerRoutingLocalHost?.clientToken),
      hasGatewayClient: Boolean(routing.gatewayClient),
      hasGatewayToken: Boolean(routing.gatewayClient?.token),
      hasGatewayAccessToken: Boolean(gatewayAccessToken),
      canUseVesloServer: Boolean(canUseVesloServerBase && vesloWorkspaceId),
      vesloConfigWriteCapable: Boolean(vesloCapabilities?.config?.write),
    };
    const syncGeneration = ++managedAiConfigSyncGeneration;
    const isCurrentManagedAiConfigSync = () =>
      !(options?.isCancelled?.() ?? false) && syncGeneration === managedAiConfigSyncGeneration;
    const releaseManagedAiBootstrap =
      managedProfile && providerRoutingReady ? deps.beginManagedAiBootstrap?.() ?? null : null;

    try {
      if (canUseVesloServerBase && vesloClient) {
        vesloWorkspaceId = await resolveManagedAiServerWorkspaceId({
          client: vesloClient,
          workspace,
          workspaceId,
          workspaceRoot: root,
          resolvedWorkspaceId: vesloWorkspaceId,
          register: deps.ensureConversationReadWorkspaceRegistered,
        });
        configSyncTracePayload = {
          ...configSyncTracePayload,
          vesloWorkspaceId: vesloWorkspaceId || null,
          canUseVesloServer: Boolean(vesloWorkspaceId),
        };
      }
      deps.recordManagedAiWorkflowTrace("managed-ai-config-sync:preflight", configSyncTracePayload);

      const providerReadinessDecision = resolveManagedAiConfigWriteDecision({
        managedProfilePresent: Boolean(managedProfile),
        providerRoutingReady,
        managedConfigAlreadyCurrent: false,
        shouldPreserveManagedConfig: false,
        defaultModelAlreadyCurrent: false,
      });
      if (
        providerReadinessDecision.type === "skip" &&
        providerReadinessDecision.reason === "provider-routing-not-ready"
      ) {
        deps.recordManagedAiWorkflowTrace("managed-ai-config-sync:skip", {
          ...configSyncTracePayload,
          reason: providerReadinessDecision.reason,
        });
        return;
      }

      if (canUseVesloServerBase && vesloClient && vesloWorkspaceId) {
        await syncVesloServerConfig({
          vesloClient,
          vesloWorkspaceId,
          managedProfile,
          gatewayAccessToken,
          managedAccessBusy,
          managedAccessError,
          nextModel,
          providerRoutingReady,
          providerRoutingTarget: routing.providerRoutingTarget,
          providerRoutingReloadKey,
          configSyncTracePayload,
          isCurrentManagedAiConfigSync,
        });
        return;
      }

      await syncProjectConfig({
        root,
        vesloWorkspaceId,
        managedProfile,
        gatewayAccessToken,
        managedAccessBusy,
        managedAccessError,
        nextModel,
        providerRoutingReady,
        providerRoutingTarget: routing.providerRoutingTarget,
        providerRoutingReloadKey,
        configSyncTracePayload,
        isCurrentManagedAiConfigSync,
      });
    } catch (error) {
      if (options?.isCancelled?.()) return;
      const message = error instanceof Error ? error.message : deps.safeStringify(error);
      deps.recordManagedAiWorkflowTrace("managed-ai-config-sync:error", {
        ...configSyncTracePayload,
        message,
      });
      deps.setError(deps.addOpencodeCacheHint(message));
    } finally {
      releaseManagedAiBootstrap?.();
    }
  };

  const maybeMarkManagedConfigApplied = (
    providerRoutingReloadKey: string,
    hasConfigChanged: boolean,
  ) => {
    if (
      shouldAutoReloadManagedAiConfig({
        hasManagedProfile: true,
        hasConfigChanged,
        hasActiveRuns: deps.anyActiveRuns() || deps.sendPromptInFlight(),
        canReloadWorkspace: deps.canReloadWorkspace(),
      }) &&
      lastManagedAiConfigAppliedForServerToken() !== providerRoutingReloadKey
    ) {
      markManagedAiConfigApplied(providerRoutingReloadKey);
    }
  };

  async function syncVesloServerConfig(input: {
    vesloClient: ManagedAiRuntimeConfigVesloClient;
    vesloWorkspaceId: string;
    managedProfile: ManagedAiAccessProfile | null;
    gatewayAccessToken: string;
    managedAccessBusy: boolean;
    managedAccessError: string | null;
    nextModel: ModelRef;
    providerRoutingReady: boolean;
    providerRoutingTarget: ReturnType<typeof resolveManagedAiProviderRoutingTarget>;
    providerRoutingReloadKey: string;
    configSyncTracePayload: Record<string, unknown>;
    isCurrentManagedAiConfigSync: () => boolean;
  }) {
    const config = await input.vesloClient.getConfig(input.vesloWorkspaceId);
    if (!input.isCurrentManagedAiConfigSync()) return;
    const currentOpencodeContent = JSON.stringify(config.opencode ?? {}, null, 2);
    deps.recordManagedAiWorkflowTrace("managed-ai-config-sync:read-current", {
      ...input.configSyncTracePayload,
      configSource: "veslo-server-config",
      currentBytes: currentOpencodeContent.length,
    });

    if (input.managedProfile && input.providerRoutingTarget && input.gatewayAccessToken) {
      const content = formatManagedAiAccessConfig(currentOpencodeContent, {
        profile: input.managedProfile,
        serverBaseUrl: input.providerRoutingTarget.baseUrl,
        engineBaseUrl: input.providerRoutingTarget.engineBaseUrl,
        serverClientToken: input.providerRoutingTarget.serverClientToken,
        gatewayAccessToken: input.gatewayAccessToken,
        workspaceId: input.vesloWorkspaceId,
      });
      const desiredSnapshot = getConfigSnapshot(content);
      const wsKey = input.vesloWorkspaceId;
      const currentApiKey = extractManagedApiKey(currentOpencodeContent);
      if (currentApiKey && currentApiKey !== input.providerRoutingTarget.serverClientToken) {
        lastKnownConfigSnapshotByWs.delete(wsKey);
      }
      const cachedSnapshotMatches = lastKnownConfigSnapshotByWs.get(wsKey) === desiredSnapshot;
      const redactedServerConfigMatches = managedConfigContentsMatch(
        currentOpencodeContent,
        content,
      );
      const currentApiKeyMatches = currentApiKey
        ? currentApiKey === input.providerRoutingTarget.serverClientToken
        : null;
      const managedDecision = resolveManagedAiConfigWriteDecision({
        managedProfilePresent: Boolean(input.managedProfile),
        providerRoutingReady: input.providerRoutingReady,
        managedConfigAlreadyCurrent: cachedSnapshotMatches || redactedServerConfigMatches,
        shouldPreserveManagedConfig: false,
        defaultModelAlreadyCurrent: false,
      });
      const managedDecisionReason = managedDecision.type === "skip" ? managedDecision.reason : null;
      deps.recordManagedAiWorkflowTrace("managed-ai-config-sync:managed-decision", {
        ...input.configSyncTracePayload,
        configSource: "veslo-server-config",
        decision: managedDecision.type,
        reason: managedDecisionReason,
        cachedSnapshotMatches,
        redactedServerConfigMatches,
        currentApiKeyPresent: Boolean(currentApiKey),
        currentApiKeyMatches,
        desiredBytes: content.length,
      });
      if (managedDecision.type === "skip") {
        if (!cachedSnapshotMatches && redactedServerConfigMatches) {
          lastKnownConfigSnapshotByWs.set(wsKey, desiredSnapshot);
        }
        return;
      }
      if (managedDecision.type !== "write-managed-config") {
        lastKnownConfigSnapshotByWs.set(wsKey, desiredSnapshot);
        return;
      }
      if (!input.isCurrentManagedAiConfigSync()) return;
      await input.vesloClient.patchConfig(input.vesloWorkspaceId, {
        opencode: JSON.parse(content) as Record<string, unknown>,
      });
      deps.recordManagedAiWorkflowTrace("managed-ai-config-sync:patch-done", {
        ...input.configSyncTracePayload,
        configSource: "veslo-server-config",
        desiredBytes: content.length,
      });
      lastKnownConfigSnapshotByWs.set(wsKey, desiredSnapshot);
      deps.markReloadRequired("config", { type: "config", name: "opencode.json", action: "updated" });
      maybeMarkManagedConfigApplied(input.providerRoutingReloadKey, true);
      return;
    }

    const preserveManagedConfig = shouldPreserveManagedAiConfig({
      content: currentOpencodeContent,
      managedProfile: input.managedProfile,
      gatewayBaseUrl: input.providerRoutingTarget?.engineBaseUrl ?? input.providerRoutingTarget?.baseUrl ?? "",
      serverClientToken: input.providerRoutingTarget?.serverClientToken ?? "",
      gatewayAccessToken: input.gatewayAccessToken,
      accessBusy: input.managedAccessBusy,
      accessError: input.managedAccessError,
    });
    const currentModel = typeof config.opencode?.model === "string" ? parseModelRef(config.opencode.model) : null;
    const defaultModelAlreadyCurrent = Boolean(currentModel && modelEquals(currentModel, input.nextModel));
    const defaultModelDecision = resolveManagedAiConfigWriteDecision({
      managedProfilePresent: Boolean(input.managedProfile),
      providerRoutingReady: input.providerRoutingReady,
      managedConfigAlreadyCurrent: false,
      shouldPreserveManagedConfig: preserveManagedConfig,
      defaultModelAlreadyCurrent,
    });
    if (defaultModelDecision.type !== "write-default-model") return;
    if (!input.isCurrentManagedAiConfigSync()) return;
    await input.vesloClient.patchConfig(input.vesloWorkspaceId, {
      opencode: { model: formatModelRef(input.nextModel) },
    });
    deps.markReloadRequired("config", { type: "config", name: "opencode.json", action: "updated" });
  }

  async function syncProjectConfig(input: {
    root: string;
    vesloWorkspaceId: string | null;
    managedProfile: ManagedAiAccessProfile | null;
    gatewayAccessToken: string;
    managedAccessBusy: boolean;
    managedAccessError: string | null;
    nextModel: ModelRef;
    providerRoutingReady: boolean;
    providerRoutingTarget: ReturnType<typeof resolveManagedAiProviderRoutingTarget>;
    providerRoutingReloadKey: string;
    configSyncTracePayload: Record<string, unknown>;
    isCurrentManagedAiConfigSync: () => boolean;
  }) {
    const configFile = await deps.readOpencodeConfig("project", input.root);
    if (!input.isCurrentManagedAiConfigSync()) return;
    deps.recordManagedAiWorkflowTrace("managed-ai-config-sync:read-current", {
      ...input.configSyncTracePayload,
      configSource: "project-config-file",
      currentBytes: configFile.content?.length ?? 0,
    });
    if (input.managedProfile && input.providerRoutingTarget && input.gatewayAccessToken) {
      const content = formatManagedAiAccessConfig(configFile.content, {
        profile: input.managedProfile,
        serverBaseUrl: input.providerRoutingTarget.baseUrl,
        engineBaseUrl: input.providerRoutingTarget.engineBaseUrl,
        serverClientToken: input.providerRoutingTarget.serverClientToken,
        gatewayAccessToken: input.gatewayAccessToken,
        workspaceId: input.vesloWorkspaceId,
      });
      const exactContentMatches = (configFile.content ?? "").trim() === content.trim();
      const managedConfigMatches =
        exactContentMatches || managedConfigContentsMatch(configFile.content, content);
      const fileDecision = resolveManagedAiConfigWriteDecision({
        managedProfilePresent: Boolean(input.managedProfile),
        providerRoutingReady: input.providerRoutingReady,
        managedConfigAlreadyCurrent: managedConfigMatches,
        shouldPreserveManagedConfig: false,
        defaultModelAlreadyCurrent: false,
      });
      const fileDecisionReason = fileDecision.type === "skip" ? fileDecision.reason : null;
      deps.recordManagedAiWorkflowTrace("managed-ai-config-sync:managed-decision", {
        ...input.configSyncTracePayload,
        configSource: "project-config-file",
        decision: fileDecision.type,
        reason: fileDecisionReason,
        exactContentMatches,
        managedConfigMatches,
        desiredBytes: content.length,
      });
      if (fileDecision.type !== "write-managed-config") return;
      if (!input.isCurrentManagedAiConfigSync()) return;
      const result = await deps.writeOpencodeConfig("project", input.root, content);
      if (!result.ok) {
        throw new Error(result.stderr || result.stdout || "Failed to update opencode.json");
      }
      lastKnownConfigSnapshotByWs.set(input.root, getConfigSnapshot(content));
      deps.recordManagedAiWorkflowTrace("managed-ai-config-sync:patch-done", {
        ...input.configSyncTracePayload,
        configSource: "project-config-file",
        desiredBytes: content.length,
      });
      deps.markReloadRequired("config", { type: "config", name: "opencode.json", action: "updated" });
      maybeMarkManagedConfigApplied(input.providerRoutingReloadKey, true);
      return;
    }

    const preserveManagedConfig = shouldPreserveManagedAiConfig({
      content: configFile.content,
      managedProfile: input.managedProfile,
      gatewayBaseUrl: input.providerRoutingTarget?.engineBaseUrl ?? input.providerRoutingTarget?.baseUrl ?? "",
      serverClientToken: input.providerRoutingTarget?.serverClientToken ?? "",
      gatewayAccessToken: input.gatewayAccessToken,
      accessBusy: input.managedAccessBusy,
      accessError: input.managedAccessError,
    });
    const existingModel = parseDefaultModelFromConfig(configFile.content);
    const defaultModelAlreadyCurrent = Boolean(existingModel && modelEquals(existingModel, input.nextModel));
    const fileDecision = resolveManagedAiConfigWriteDecision({
      managedProfilePresent: Boolean(input.managedProfile),
      providerRoutingReady: input.providerRoutingReady,
      managedConfigAlreadyCurrent: false,
      shouldPreserveManagedConfig: preserveManagedConfig,
      defaultModelAlreadyCurrent,
    });
    if (fileDecision.type !== "write-default-model") return;
    if (!input.isCurrentManagedAiConfigSync()) return;
    const content = formatConfigWithDefaultModel(configFile.content, input.nextModel);
    const result = await deps.writeOpencodeConfig("project", input.root, content);
    if (!result.ok) {
      throw new Error(result.stderr || result.stdout || "Failed to update opencode.json");
    }
    lastKnownConfigSnapshotByWs.set(input.root, getConfigSnapshot(content));
    deps.markReloadRequired("config", { type: "config", name: "opencode.json", action: "updated" });
  }

  function managedConfigContentsMatch(current: string | null | undefined, desired: string): boolean {
    return managedConfigContentsMatchForServerPatch(current, desired);
  }

  const healInactiveManagedAiWorkspaceConfigs = async (
    options?: { isCancelled?: () => boolean },
  ): Promise<void> => {
    if (!deps.isTauriRuntime()) return;
    const vesloClient = deps.vesloServerClient();
    if (!vesloClient) return;
    if (deps.vesloServerStatus() !== "connected") return;
    const vesloCapabilities = deps.resolvedVesloCapabilities();
    if (!vesloCapabilities?.config?.write) return;
    const managedProfile = deps.managedAiAccess();
    if (!managedProfile) return;
    const providerRoutingLocalHost = deps.activeVesloServerRoutingInfo();
    if (!providerRoutingLocalHost?.baseUrl) return;
    const gatewayClient = deps.gatewayVesloServerClient();
    const runtimeSandboxState = resolveRuntimeSandboxStateForTarget();
    const providerRoutingRequiresEngineBaseUrl = requiresManagedAiEngineBaseUrl({
      isDesktopRuntime: deps.isTauriRuntime(),
      workspaceType: "local",
      engineBaseUrl: providerRoutingLocalHost.engineUrl ?? "",
      requiresEngineBridgeUrl: runtimeSandboxState.requiresEngineBridgeUrl,
      configuredSandboxEnabled: runtimeSandboxState.configuredEnabled,
      configuredSandboxBackend: runtimeSandboxState.configuredBackend,
      effectiveSandboxBackend: runtimeSandboxState.effectiveBackend,
      childKind: runtimeSandboxState.childKind,
      sandboxEnabled: runtimeSandboxState.isSandboxed,
      sandboxBackend: runtimeSandboxState.effectiveBackend,
    });
    const providerRoutingTarget = resolveManagedAiProviderRoutingTarget({
      isDesktopRuntime: deps.isTauriRuntime(),
      workspaceType: "local",
      activeBaseUrl: providerRoutingLocalHost.baseUrl,
      engineBaseUrl: providerRoutingLocalHost.engineUrl ?? "",
      requireEngineBaseUrl: providerRoutingRequiresEngineBaseUrl,
      activeToken: providerRoutingLocalHost?.clientToken ?? "",
      gatewayBaseUrl: gatewayClient?.baseUrl ?? "",
      gatewayToken: gatewayClient?.token ?? "",
    });
    if (!providerRoutingTarget?.serverClientToken) return;
    const gatewayAccessToken = deps.managedAiGatewayAccessToken() || deps.denGatewayAccessToken();
    if (!gatewayAccessToken) return;

    const sessionToken = `${providerRoutingTarget.serverClientToken}@${providerRoutingTarget.engineBaseUrl}`;
    const activeWorkspace = deps.activeWorkspaceDisplay();
    const activeWorkspaceAppId = activeWorkspace.id?.trim() || deps.activeWorkspaceId().trim();
    const activeWorkspaceId =
      (deps.vesloServerWorkspaceId() ?? "").trim() ||
      deps.resolveConversationServerWorkspaceId(activeWorkspaceAppId) ||
      "";
    const healGeneration = ++inactiveWorkspaceBaseUrlHealGeneration;
    const isCurrentInactiveWorkspaceHeal = () =>
      !(options?.isCancelled?.() ?? false) &&
      healGeneration === inactiveWorkspaceBaseUrlHealGeneration;

    let workspaceItems: Awaited<ReturnType<ManagedAiRuntimeConfigVesloClient["listWorkspaces"]>>["items"];
    try {
      const response = await vesloClient.listWorkspaces();
      if (!isCurrentInactiveWorkspaceHeal()) return;
      workspaceItems = Array.isArray(response.items) ? response.items : [];
    } catch (error) {
      if (!(options?.isCancelled?.() ?? false)) deps.reportError(error, "managed-baseurl.listWorkspaces");
      return;
    }
    for (const workspace of workspaceItems) {
      if (!isCurrentInactiveWorkspaceHeal()) return;
      if (workspace.workspaceType !== "local") continue;
      if (workspace.id === activeWorkspaceId) continue;
      if (inactiveWorkspaceBaseUrlHealedFor.get(workspace.id) === sessionToken) continue;
      try {
        const config = await vesloClient.getConfig(workspace.id);
        if (!isCurrentInactiveWorkspaceHeal()) return;
        const currentOpencodeContent = JSON.stringify(config.opencode ?? {}, null, 2);
        const desiredContent = formatManagedAiAccessConfig(currentOpencodeContent, {
          profile: managedProfile,
          serverBaseUrl: providerRoutingTarget.baseUrl,
          engineBaseUrl: providerRoutingTarget.engineBaseUrl,
          serverClientToken: providerRoutingTarget.serverClientToken,
          gatewayAccessToken,
          workspaceId: workspace.id,
        });
        if (managedConfigContentsMatch(currentOpencodeContent, desiredContent)) {
          inactiveWorkspaceBaseUrlHealedFor.set(workspace.id, sessionToken);
          continue;
        }
        if (!isCurrentInactiveWorkspaceHeal()) return;
        await vesloClient.patchConfig(workspace.id, {
          opencode: JSON.parse(desiredContent) as Record<string, unknown>,
        });
        if (!isCurrentInactiveWorkspaceHeal()) return;
        inactiveWorkspaceBaseUrlHealedFor.set(workspace.id, sessionToken);
      } catch (error) {
        if (options?.isCancelled?.()) continue;
        const message = error instanceof Error ? error.message : deps.safeStringify(error);
        if (/not authorized|unauthorized|401/i.test(message)) {
          inactiveWorkspaceBaseUrlHealedFor.set(workspace.id, sessionToken);
          continue;
        }
        deps.reportError(error, `managed-baseurl.heal:${workspace.id}`);
      }
    }
  };

  effect(() => {
    const nextKey = JSON.stringify(deps.managedAiAccess() ?? null);
    if (nextKey === lastManagedAiAccessResetKey) return;
    lastManagedAiAccessResetKey = nextKey;
    clearManagedConfigTracking();
  });

  effect(() => {
    let cancelled = false;
    void syncActiveWorkspaceManagedAiConfig({ isCancelled: () => cancelled });
    onCleanup(() => {
      cancelled = true;
    });
  });

  effect(() => {
    let cancelled = false;
    void healInactiveManagedAiWorkspaceConfigs({ isCancelled: () => cancelled });
    onCleanup(() => {
      cancelled = true;
    });
  });

  return {
    resolveRuntimeSandboxStateForTarget,
    hasUsableManagedAiRuntimeConfigForSend,
    ensureManagedAiRuntimeAuthorizationForSend,
    syncActiveWorkspaceManagedAiConfig: () => syncActiveWorkspaceManagedAiConfig(),
    healInactiveManagedAiWorkspaceConfigs: () => healInactiveManagedAiWorkspaceConfigs(),
    rememberKnownConfigSnapshot,
    clearManagedConfigTracking,
  };
}
