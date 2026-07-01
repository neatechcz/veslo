import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
} from "solid-js";

import {
  resolveAppStartupRouteDecision,
  resolveDashboardRouteTab,
  type AppStartupRouteDecision,
} from "../controllers/app-startup-controller";
import type { DashboardTab, OnboardingStep, View } from "../types";

export type AppRouteNavigateOptions = {
  replace?: boolean;
};

export type AppRouteNavigate = (to: string, options?: AppRouteNavigateOptions) => void;

export type AppRouteHashWindowTarget = {
  location: {
    hash: string;
  };
  addEventListener: (type: "hashchange", listener: () => void) => void;
  removeEventListener: (type: "hashchange", listener: () => void) => void;
};

export type AppRouteSyncDeps = {
  pathname: Accessor<string>;
  navigate: AppRouteNavigate;
  isTauriRuntime: Accessor<boolean>;
  creatingSession: Accessor<boolean>;
  sessionViewLockUntil: Accessor<number>;
  now?: Accessor<number>;
};

export type AppSessionRouteContext = {
  rawPath: string;
};

export type AppStartupRouteSyncDeps = {
  onboardingStep: Accessor<OnboardingStep>;
  activeSessionId: Accessor<string | null | undefined>;
  onSessionRoute: (context: AppSessionRouteContext) => void;
};

export type AppRouteSyncController = {
  currentView: Accessor<View>;
  isProtoV1Ux: Accessor<boolean>;
  tab: Accessor<DashboardTab>;
  setTabState: (nextTab: DashboardTab) => void;
  goToDashboard: (nextTab: DashboardTab, options?: AppRouteNavigateOptions) => void;
  setTab: (nextTab: DashboardTab) => void;
  setView: (next: View, sessionId?: string) => void;
  goToSession: (sessionId: string, options?: AppRouteNavigateOptions) => void;
  syncExternalHashRoute: (windowTarget?: AppRouteHashWindowTarget | null) => void;
  startHashRouteSync: (windowTarget?: AppRouteHashWindowTarget | null) => void;
  syncStartupRouteOnce: (startupDeps: AppStartupRouteSyncDeps) => void;
  startStartupRouteSync: (startupDeps: AppStartupRouteSyncDeps) => void;
};

function normalizePath(value: string): string {
  return value.trim().toLowerCase();
}

function routePathFromHash(hashPath: string): string {
  return hashPath.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
}

function resolveCurrentView(pathname: string): View {
  const path = normalizePath(pathname);

  if (path.startsWith("/onboarding")) {
    return "onboarding";
  }
  if (path.startsWith("/session")) {
    return "session";
  }
  if (path.startsWith("/proto")) {
    return "proto";
  }
  return "dashboard";
}

function resolveDefaultHashWindowTarget(): AppRouteHashWindowTarget | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window as unknown as AppRouteHashWindowTarget;
}

function resolveHashWindowTarget(
  windowTarget: AppRouteHashWindowTarget | null | undefined,
): AppRouteHashWindowTarget | null {
  return windowTarget ?? resolveDefaultHashWindowTarget();
}

function isDashboardHashPath(pathname: string): boolean {
  return pathname.startsWith("/dashboard");
}

function shouldNavigateFromHash(currentPathname: string, hashPathname: string): boolean {
  return normalizePath(currentPathname) !== hashPathname;
}

function executeDashboardRouteDecision(
  decision: Extract<AppStartupRouteDecision, { type: "dashboard-route" }>,
  tab: Accessor<DashboardTab>,
  setTabState: (nextTab: DashboardTab) => void,
  goToDashboard: (nextTab: DashboardTab, options?: AppRouteNavigateOptions) => void,
) {
  if (decision.tab !== tab()) {
    setTabState(decision.tab);
  }
  if (decision.canonicalize) {
    goToDashboard(decision.tab, { replace: true });
  }
}

function executeStartupRouteDecision(
  decision: AppStartupRouteDecision,
  rawPath: string,
  startupDeps: AppStartupRouteSyncDeps,
  routeActions: {
    navigate: AppRouteNavigate;
    tab: Accessor<DashboardTab>;
    setTabState: (nextTab: DashboardTab) => void;
    goToDashboard: (nextTab: DashboardTab, options?: AppRouteNavigateOptions) => void;
  },
) {
  switch (decision.type) {
    case "navigate":
      routeActions.navigate(decision.to, { replace: decision.replace });
      return;
    case "dashboard-route":
      executeDashboardRouteDecision(decision, routeActions.tab, routeActions.setTabState, routeActions.goToDashboard);
      return;
    case "ignore":
      return;
    case "session-route":
      startupDeps.onSessionRoute({ rawPath });
      return;
  }
}

export function createAppRouteSync(deps: AppRouteSyncDeps): AppRouteSyncController {
  const now = deps.now ?? (() => Date.now());
  const currentView = createMemo<View>(() => resolveCurrentView(deps.pathname()));
  const isProtoV1Ux = createMemo(() => normalizePath(deps.pathname()).startsWith("/proto-v1-ux"));
  const [tab, writeTabState] = createSignal<DashboardTab>("scheduled");

  const setTabState = (nextTab: DashboardTab) => {
    writeTabState(nextTab);
  };

  const goToDashboard = (nextTab: DashboardTab, options?: AppRouteNavigateOptions) => {
    setTabState(nextTab);
    deps.navigate(`/dashboard/${nextTab}`, options);
  };

  const goToSession = (sessionId: string, options?: AppRouteNavigateOptions) => {
    const trimmed = sessionId.trim();
    if (!trimmed) {
      deps.navigate("/session", options);
      return;
    }
    deps.navigate(`/session/${trimmed}`, options);
  };

  const setTab = (nextTab: DashboardTab) => {
    if (currentView() === "dashboard") {
      goToDashboard(nextTab);
      return;
    }
    setTabState(nextTab);
  };

  const setView = (next: View, sessionId?: string) => {
    if (next === "dashboard" && deps.creatingSession()) {
      return;
    }
    if (next === "dashboard" && now() < deps.sessionViewLockUntil()) {
      return;
    }
    if (next === "proto") {
      deps.navigate("/proto/workspaces");
      return;
    }
    if (next === "onboarding") {
      deps.navigate("/onboarding");
      return;
    }
    if (next === "session") {
      if (sessionId) {
        goToSession(sessionId);
        return;
      }
      deps.navigate("/session");
      return;
    }
    goToDashboard(tab());
  };

  const syncDashboardHashTab = (pathname: string) => {
    if (!isDashboardHashPath(pathname)) {
      return;
    }
    const [, , tabSegment] = pathname.split("/");
    const resolvedTab = resolveDashboardRouteTab(tabSegment);
    if (resolvedTab !== tab()) {
      setTabState(resolvedTab);
    }
  };

  const syncExternalHashRoute = (windowTarget?: AppRouteHashWindowTarget | null) => {
    if (!deps.isTauriRuntime()) {
      return;
    }
    const target = resolveHashWindowTarget(windowTarget);
    if (!target) {
      return;
    }

    const hashPath = target.location.hash.replace(/^#/, "").trim();
    if (!hashPath.startsWith("/")) {
      return;
    }

    const pathname = routePathFromHash(hashPath);
    syncDashboardHashTab(pathname);

    if (shouldNavigateFromHash(deps.pathname(), pathname)) {
      deps.navigate(hashPath, { replace: true });
    }
  };

  const startHashRouteSync = (windowTarget?: AppRouteHashWindowTarget | null) => {
    let mountedWindowTarget: AppRouteHashWindowTarget | null = null;

    onMount(() => {
      if (!deps.isTauriRuntime()) {
        return;
      }
      mountedWindowTarget = resolveHashWindowTarget(windowTarget);
      mountedWindowTarget?.addEventListener("hashchange", syncExternalHashRoute);
    });

    onCleanup(() => {
      if (!mountedWindowTarget) {
        return;
      }
      mountedWindowTarget.removeEventListener("hashchange", syncExternalHashRoute);
      mountedWindowTarget = null;
    });
  };

  const syncStartupRouteOnce = (startupDeps: AppStartupRouteSyncDeps) => {
    const rawPath = deps.pathname().trim();
    const startupRouteDecision = resolveAppStartupRouteDecision({
      rawPath,
      onboardingStep: startupDeps.onboardingStep(),
      isTauriRuntime: deps.isTauriRuntime(),
      activeSessionId: startupDeps.activeSessionId(),
    });

    executeStartupRouteDecision(startupRouteDecision, rawPath, startupDeps, {
      navigate: deps.navigate,
      tab,
      setTabState,
      goToDashboard,
    });
  };

  const startStartupRouteSync = (startupDeps: AppStartupRouteSyncDeps) => {
    createEffect(() => {
      syncStartupRouteOnce(startupDeps);
    });
  };

  return {
    currentView,
    isProtoV1Ux,
    tab,
    setTabState,
    goToDashboard,
    setTab,
    setView,
    goToSession,
    syncExternalHashRoute,
    startHashRouteSync,
    syncStartupRouteOnce,
    startStartupRouteSync,
  };
}
