import { createEffect, createSignal, onCleanup } from "solid-js";

import type {
  AuthCompleteDeepLinkPayload,
  DenAuthState,
  DesktopAuthExchangeProof,
  DesktopAuthStartResult,
  DesktopAuthStatusResult,
  PendingDesktopAuthSession,
} from "../lib/den-auth";
import {
  clearDenAuth,
  clearDesktopAuthExchangeProof,
  exchangeHandoffCode,
  flushPendingDesktopSnapshotWrite,
  getDenApiBase,
  getDesktopBrowserAuthStatus,
  parseAuthCompleteDeepLink,
  readDenAuth,
  readDesktopAuthExchangeProof,
  readPendingDesktopAuthSession,
  resolveAuthenticatedDenUserLabel,
  resolvePreferredDenUserLabel,
  startDesktopBrowserAuth,
  subscribeDenAuthChanges,
  writeDenAuth,
} from "../lib/den-auth";
import type { OnboardingStep, View } from "../types";

const DESKTOP_AUTH_POLL_INTERVAL_MS = 1_250;
const POST_AUTH_BOOTSTRAP_TIMEOUT_MS = 15_000;

const isAbortSignalAborted = (signal: AbortSignal) => signal.aborted;

type AuthDeps = {
  clearDenAuth: () => void;
  readDenAuth: () => DenAuthState | null;
  writeDenAuth: (state: DenAuthState) => void;
  flushPendingDesktopSnapshotWrite: () => Promise<void>;
  subscribeDenAuthChanges: (listener: () => void) => () => void;
};

type DesktopAuthDeps = {
  parseAuthCompleteDeepLink: (rawUrl: string) => AuthCompleteDeepLinkPayload | null;
  readDesktopAuthExchangeProof: (sessionId?: string | null) => DesktopAuthExchangeProof | null;
  clearDesktopAuthExchangeProof: (sessionId?: string | null) => void;
  exchangeHandoffCode: (
    code: string,
    exchangeProof?: DesktopAuthExchangeProof | null,
  ) => Promise<{ ok: true; state: DenAuthState } | { ok: false; error: string }>;
  readPendingDesktopAuthSession: (sessionId?: string | null) => PendingDesktopAuthSession | null;
  startDesktopBrowserAuth: (intent?: "signin" | "signup") => Promise<DesktopAuthStartResult>;
  getDesktopBrowserAuthStatus: (
    sessionId: string,
    signal?: AbortSignal,
  ) => Promise<DesktopAuthStatusResult>;
  getDenApiBase: () => string;
};

type UiDeps = {
  setError: (message: string | null) => void;
  setOnboardingStep: (step: OnboardingStep) => void;
  setView: (view: View) => void;
  setBooting: (booting: boolean) => void;
};

type DiagnosticsDeps = {
  setBootstrapDiagnosticsCloudContext: (context: {
    denApiBase: string;
    token: string;
    userId: string;
    orgId: string;
    workspaceId: string;
  }) => Promise<void> | void;
  clearBootstrapDiagnosticsCloudContext: () => Promise<void> | void;
  recordBootstrapDiagnostic: (event: string, payload?: Record<string, unknown>) => Promise<void> | void;
};

type ProfileDeps = {
  resolveAuthenticatedDenUserLabel: (auth: DenAuthState | null) => string | null;
  resolvePreferredDenUserLabel: (
    user?: Partial<DenAuthState["user"]> | null,
  ) => string | null;
  fetchUserProfile: (
    denApiBase: string,
    token: string,
  ) => Promise<{ id: string; name?: string; email?: string } | null>;
};

type TimerDeps = {
  setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timeoutId: ReturnType<typeof setTimeout>) => void;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export type DenDesktopAuthWorkflowOptions = {
  isTauriRuntime: () => boolean;
  workspace: {
    activeWorkspaceId: () => string;
    bootstrapOnboarding: () => Promise<unknown>;
  };
  auth?: Partial<AuthDeps>;
  desktopAuth?: Partial<DesktopAuthDeps>;
  ui: UiDeps;
  managedAi: {
    clearManagedAiAccessCache: () => void;
    clearRuntimeAuthorization?: () => Promise<unknown> | unknown;
    requestManagedAiAccessRefresh: () => void;
  };
  account?: {
    setAuthenticatedAccountId?: (accountId: string | null) => void;
  };
  diagnostics: DiagnosticsDeps;
  profile?: Partial<ProfileDeps>;
  browser?: {
    openDesktopAuthUrl?: (url: string) => Promise<void>;
  };
  timers?: Partial<TimerDeps>;
  safeStringify: (value: unknown) => string;
};

export type DenDesktopAuthWorkflow = {
  denAuthRevision: () => number;
  authCompleteExchangeBusy: () => boolean;
  authenticatedUser: () => string | null;
  authenticatedAccountId: () => string | null;
  logout: () => Promise<void>;
  startDesktopBrowserSignIn: () => Promise<void>;
  resumeDesktopBrowserSignIn: () => Promise<void>;
  queueAuthCompleteDeepLink: (rawUrl: string) => boolean;
  cancelDesktopAuthStatusPolling: () => void;
};

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);
    };

    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

async function defaultOpenDesktopAuthUrl(
  url: string,
  isTauriRuntime: () => boolean,
): Promise<void> {
  if (isTauriRuntime()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

async function defaultFetchUserProfile(
  denApiBase: string,
  token: string,
): Promise<{ id: string; name?: string; email?: string } | null> {
  const response = await fetch(`${denApiBase.replace(/\/+$/, "")}/v1/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as {
    user?: { id?: unknown; name?: unknown; email?: unknown };
  };
  const userId = typeof payload?.user?.id === "string" ? payload.user.id.trim() : "";
  if (!userId) return null;
  const userName = typeof payload?.user?.name === "string" ? payload.user.name.trim() : "";
  const userEmail = typeof payload?.user?.email === "string" ? payload.user.email.trim() : "";
  return {
    id: userId,
    name: userName || undefined,
    email: userEmail || undefined,
  };
}

export function createDenDesktopAuthWorkflow(
  options: DenDesktopAuthWorkflowOptions,
): DenDesktopAuthWorkflow {
  const auth: AuthDeps = {
    clearDenAuth: options.auth?.clearDenAuth ?? clearDenAuth,
    readDenAuth: options.auth?.readDenAuth ?? readDenAuth,
    writeDenAuth: options.auth?.writeDenAuth ?? writeDenAuth,
    flushPendingDesktopSnapshotWrite:
      options.auth?.flushPendingDesktopSnapshotWrite ?? flushPendingDesktopSnapshotWrite,
    subscribeDenAuthChanges: options.auth?.subscribeDenAuthChanges ?? subscribeDenAuthChanges,
  };
  const desktopAuth: DesktopAuthDeps = {
    parseAuthCompleteDeepLink:
      options.desktopAuth?.parseAuthCompleteDeepLink ?? parseAuthCompleteDeepLink,
    readDesktopAuthExchangeProof:
      options.desktopAuth?.readDesktopAuthExchangeProof ?? readDesktopAuthExchangeProof,
    clearDesktopAuthExchangeProof:
      options.desktopAuth?.clearDesktopAuthExchangeProof ?? clearDesktopAuthExchangeProof,
    exchangeHandoffCode: options.desktopAuth?.exchangeHandoffCode ?? exchangeHandoffCode,
    readPendingDesktopAuthSession:
      options.desktopAuth?.readPendingDesktopAuthSession ?? readPendingDesktopAuthSession,
    startDesktopBrowserAuth:
      options.desktopAuth?.startDesktopBrowserAuth ?? startDesktopBrowserAuth,
    getDesktopBrowserAuthStatus:
      options.desktopAuth?.getDesktopBrowserAuthStatus ?? getDesktopBrowserAuthStatus,
    getDenApiBase: options.desktopAuth?.getDenApiBase ?? getDenApiBase,
  };
  const profile: ProfileDeps = {
    resolveAuthenticatedDenUserLabel:
      options.profile?.resolveAuthenticatedDenUserLabel ?? resolveAuthenticatedDenUserLabel,
    resolvePreferredDenUserLabel:
      options.profile?.resolvePreferredDenUserLabel ?? resolvePreferredDenUserLabel,
    fetchUserProfile: options.profile?.fetchUserProfile ?? defaultFetchUserProfile,
  };
  const timers: TimerDeps = {
    setTimeout: options.timers?.setTimeout ?? ((callback, ms) => setTimeout(callback, ms)),
    clearTimeout: options.timers?.clearTimeout ?? ((timeoutId) => clearTimeout(timeoutId)),
    sleep: options.timers?.sleep ?? defaultSleep,
  };
  const openDesktopAuthUrl = options.browser?.openDesktopAuthUrl ??
    ((url: string) => defaultOpenDesktopAuthUrl(url, options.isTauriRuntime));

  const [denAuthRevision, setDenAuthRevision] = createSignal(0);
  const [authCompleteExchangeBusy, setAuthCompleteExchangeBusy] = createSignal(false);
  const [authenticatedUser, setAuthenticatedUser] = createSignal<string | null>(null);
  const [authenticatedAccountId, setAuthenticatedAccountId] = createSignal<string | null>(null);
  let desktopAuthStatusPollController: AbortController | null = null;
  const exchangedCodes = new Set<string>();
  let lastBootstrapDiagnosticsCloudContextKey = "";

  const cancelDesktopAuthStatusPolling = () => {
    if (!desktopAuthStatusPollController) return;
    try {
      desktopAuthStatusPollController.abort();
    } catch {
      // ignore
    }
    desktopAuthStatusPollController = null;
  };

  const bumpDenAuthRevision = () => {
    setDenAuthRevision((value) => value + 1);
  };

  const applyAuthenticatedAccountId = (accountId: string | null) => {
    setAuthenticatedAccountId(accountId);
    options.account?.setAuthenticatedAccountId?.(accountId);
  };

  const recordRuntimeAuthorizationClearFailure = (error: unknown) => {
    if (!options.isTauriRuntime()) return;
    const message = error instanceof Error ? error.message : options.safeStringify(error);
    void options.diagnostics.recordBootstrapDiagnostic("desktop-auth:ai-gateway-runtime-auth-clear-failed", {
      message,
    });
  };

  const clearManagedAiRuntimeAuthorizationForLogout = () => {
    const clearRuntimeAuthorization = options.managedAi.clearRuntimeAuthorization;
    if (!clearRuntimeAuthorization) return;
    try {
      const result = clearRuntimeAuthorization();
      void Promise.resolve(result).catch(recordRuntimeAuthorizationClearFailure);
    } catch (error) {
      recordRuntimeAuthorizationClearFailure(error);
    }
  };

  const logout = async () => {
    auth.clearDenAuth();
    if (options.isTauriRuntime()) {
      lastBootstrapDiagnosticsCloudContextKey = "";
      await options.diagnostics.clearBootstrapDiagnosticsCloudContext();
    }
    options.managedAi.clearManagedAiAccessCache();
    clearManagedAiRuntimeAuthorizationForLogout();
    options.ui.setOnboardingStep("auth");
    options.ui.setView("onboarding");
    await auth.flushPendingDesktopSnapshotWrite();
    options.managedAi.requestManagedAiAccessRefresh();
  };

  const finishDesktopBrowserAuth = (
    code: string,
    exchangeProof?: DesktopAuthExchangeProof | null,
  ) => {
    if (authCompleteExchangeBusy()) return;
    if (exchangedCodes.has(code)) return;

    cancelDesktopAuthStatusPolling();
    setAuthCompleteExchangeBusy(true);
    options.ui.setError(null);
    void desktopAuth.exchangeHandoffCode(code, exchangeProof)
      .then(async (result) => {
        if (result.ok) {
          exchangedCodes.add(code);
          auth.writeDenAuth(result.state);
          if (options.isTauriRuntime()) {
            const activeWorkspaceId = options.workspace.activeWorkspaceId().trim();
            await options.diagnostics.setBootstrapDiagnosticsCloudContext({
              denApiBase: result.state.denApiBase,
              token: result.state.token,
              userId: result.state.user.id,
              orgId: result.state.orgId || result.state.org.id,
              workspaceId: activeWorkspaceId,
            });
            void options.diagnostics.recordBootstrapDiagnostic("desktop-auth:exchange-success", {
              denApiBase: result.state.denApiBase,
              userId: result.state.user.id,
              orgId: result.state.orgId || result.state.org.id,
              workspaceId: activeWorkspaceId || null,
            });
            void options.diagnostics.recordBootstrapDiagnostic("desktop-auth:post-auth-bootstrap-start", {
              userId: result.state.user.id,
              orgId: result.state.orgId || result.state.org.id,
              workspaceId: activeWorkspaceId || null,
            });
          }
          await auth.flushPendingDesktopSnapshotWrite();
          desktopAuth.clearDesktopAuthExchangeProof(exchangeProof?.sessionId);
          options.managedAi.requestManagedAiAccessRefresh();
          options.ui.setError(null);
          options.ui.setOnboardingStep("connecting");
          options.ui.setView("onboarding");
          options.ui.setBooting(true);
          const rebootstrapTimeout = timers.setTimeout(() => {
            console.warn("[boot] post-auth bootstrap timed out after 15s - forcing boot complete");
            if (options.isTauriRuntime()) {
              void options.diagnostics.recordBootstrapDiagnostic("desktop-auth:post-auth-bootstrap-timeout", {
                userId: result.state.user.id,
                orgId: result.state.orgId || result.state.org.id,
                workspaceId: options.workspace.activeWorkspaceId().trim() || null,
                timeoutMs: POST_AUTH_BOOTSTRAP_TIMEOUT_MS,
              });
            }
            options.ui.setBooting(false);
          }, POST_AUTH_BOOTSTRAP_TIMEOUT_MS);
          void options.workspace.bootstrapOnboarding()
            .catch((error) => {
              if (options.isTauriRuntime()) {
                void options.diagnostics.recordBootstrapDiagnostic("desktop-auth:post-auth-bootstrap-failed", {
                  userId: result.state.user.id,
                  orgId: result.state.orgId || result.state.org.id,
                  workspaceId: options.workspace.activeWorkspaceId().trim() || null,
                  message: error instanceof Error ? error.message : options.safeStringify(error),
                });
              }
            })
            .finally(() => {
              timers.clearTimeout(rebootstrapTimeout);
              options.ui.setBooting(false);
            });
          return;
        }

        console.error("[den-auth] exchange failed:", result.error);
        if (exchangeProof) {
          desktopAuth.clearDesktopAuthExchangeProof(exchangeProof.sessionId);
        }
        options.ui.setError(`Sign in failed: ${result.error}`);
        options.ui.setOnboardingStep("auth");
        options.ui.setView("onboarding");
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : options.safeStringify(error);
        console.error("[den-auth] exchange failed:", message);
        if (exchangeProof) {
          desktopAuth.clearDesktopAuthExchangeProof(exchangeProof.sessionId);
        }
        options.ui.setError(`Sign in failed: ${message}`);
        options.ui.setOnboardingStep("auth");
        options.ui.setView("onboarding");
      })
      .finally(() => {
        setAuthCompleteExchangeBusy(false);
      });
  };

  const startDesktopAuthStatusPolling = (sessionId: string) => {
    const initialProof = desktopAuth.readDesktopAuthExchangeProof(sessionId);
    if (!initialProof) return;

    cancelDesktopAuthStatusPolling();
    const controller = new AbortController();
    desktopAuthStatusPollController = controller;

    void (async () => {
      let consecutiveFailures = 0;

      while (!controller.signal.aborted) {
        const latestProof = desktopAuth.readDesktopAuthExchangeProof(sessionId);
        if (!latestProof) return;
        if (authCompleteExchangeBusy()) return;

        const statusResult = await desktopAuth.getDesktopBrowserAuthStatus(sessionId, controller.signal);
        if (isAbortSignalAborted(controller.signal)) return;

        if (!statusResult.ok) {
          if (statusResult.statusCode === 404) return;
          consecutiveFailures += 1;
          if (consecutiveFailures >= 3) {
            console.warn("[den-auth] desktop auth polling stopped after repeated failures:", statusResult.error);
            return;
          }
        } else {
          consecutiveFailures = 0;
          if (statusResult.status === "authorized" && statusResult.code) {
            finishDesktopBrowserAuth(statusResult.code, latestProof);
            return;
          }

          if (
            statusResult.status === "expired" ||
            statusResult.status === "cancelled" ||
            statusResult.status === "exchanged"
          ) {
            return;
          }
        }

        try {
          await timers.sleep(DESKTOP_AUTH_POLL_INTERVAL_MS, controller.signal);
        } catch (error) {
          const name = error instanceof DOMException ? error.name : "";
          if (name === "AbortError") return;
          throw error;
        }
      }
    })().catch((error) => {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[den-auth] desktop auth polling failed:", message);
    });
  };

  const resumePendingDesktopBrowserAuth = async (reopenBrowser: boolean): Promise<boolean> => {
    const pending = desktopAuth.readPendingDesktopAuthSession();
    if (!pending) return false;

    options.ui.setError(null);
    startDesktopAuthStatusPolling(pending.sessionId);
    if (reopenBrowser && pending.authorizeUrl) {
      await openDesktopAuthUrl(pending.authorizeUrl);
    }
    return true;
  };

  const startDesktopBrowserSignIn = async () => {
    options.ui.setError(null);
    if (await resumePendingDesktopBrowserAuth(true)) return;

    let url = `${desktopAuth.getDenApiBase()}/?desktopOnboarding=1`;
    const startResult = await desktopAuth.startDesktopBrowserAuth("signin");
    if (startResult.ok) {
      url = startResult.authorizeUrl;
      startDesktopAuthStatusPolling(startResult.sessionId);
    } else {
      console.warn("[den-auth] /start failed, falling back to legacy onboarding URL:", startResult.error);
    }
    await openDesktopAuthUrl(url);
  };

  const resumeDesktopBrowserSignIn = async () => {
    if (await resumePendingDesktopBrowserAuth(false)) return;
    await startDesktopBrowserSignIn();
  };

  const queueAuthCompleteDeepLink = (rawUrl: string): boolean => {
    const payload = desktopAuth.parseAuthCompleteDeepLink(rawUrl);
    if (!payload) return false;
    if (authCompleteExchangeBusy()) return true;

    const exchangeProof = desktopAuth.readDesktopAuthExchangeProof(payload.sessionId);
    finishDesktopBrowserAuth(payload.code, exchangeProof);
    return true;
  };

  onCleanup(() => {
    cancelDesktopAuthStatusPolling();
  });

  const unsubscribeAuthChanges = auth.subscribeDenAuthChanges(bumpDenAuthRevision);
  onCleanup(unsubscribeAuthChanges);

  createEffect(() => {
    if (!options.isTauriRuntime()) return;

    denAuthRevision();
    const currentAuth = auth.readDenAuth();
    const denApiBase = currentAuth?.denApiBase?.trim() ?? "";
    const token = currentAuth?.token?.trim() ?? "";
    const userId = currentAuth?.user?.id?.trim() ?? "";
    const orgId = currentAuth?.orgId?.trim() || currentAuth?.org?.id?.trim() || "";
    const workspaceId = options.workspace.activeWorkspaceId().trim();
    const nextKey = [denApiBase, token, userId, orgId, workspaceId].join("\u0000");

    if (nextKey === lastBootstrapDiagnosticsCloudContextKey) return;
    lastBootstrapDiagnosticsCloudContextKey = nextKey;

    if (!denApiBase || !token || !userId || !orgId) {
      void options.diagnostics.clearBootstrapDiagnosticsCloudContext();
      return;
    }

    void options.diagnostics.setBootstrapDiagnosticsCloudContext({
      denApiBase,
      token,
      userId,
      orgId,
      workspaceId,
    });
  });

  createEffect(() => {
    denAuthRevision();

    const currentAuth = auth.readDenAuth();
    setAuthenticatedUser(profile.resolveAuthenticatedDenUserLabel(currentAuth));
    applyAuthenticatedAccountId(currentAuth?.user?.id?.trim() || null);
    if (!currentAuth) return;

    const token = currentAuth.token?.trim() ?? "";
    const denApiBase = currentAuth.denApiBase?.trim() ?? "";
    if (!token || !denApiBase) return;
    if ((currentAuth.user?.name?.trim() ?? "") || (currentAuth.user?.email?.trim() ?? "")) return;

    let canceled = false;
    void profile.fetchUserProfile(denApiBase, token)
      .then((user) => {
        if (canceled || !user?.id) return;
        setAuthenticatedUser(profile.resolvePreferredDenUserLabel(user));
        applyAuthenticatedAccountId(user.id);
        auth.writeDenAuth({
          ...currentAuth,
          user,
        });
      })
      .catch(() => {
        // keep local value
      });

    onCleanup(() => {
      canceled = true;
    });
  });

  return {
    denAuthRevision,
    authCompleteExchangeBusy,
    authenticatedUser,
    authenticatedAccountId,
    logout,
    startDesktopBrowserSignIn,
    resumeDesktopBrowserSignIn,
    queueAuthCompleteDeepLink,
    cancelDesktopAuthStatusPolling,
  };
}
