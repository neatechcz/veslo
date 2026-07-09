import assert from "node:assert/strict";
import test from "node:test";

import { createRoot } from "solid-js";

import {
  createAppRouteHashChangeListener,
  createAppRouteSync,
  type AppRouteNavigateOptions,
  type AppStartupRouteSyncDeps,
} from "../../context/app-route-sync.js";
import { createUiConversationKey } from "../../lib/ui-conversation-scope.js";
import type { OnboardingStep } from "../../types.js";

type Navigation = {
  to: string;
  options?: AppRouteNavigateOptions;
};

test("app route sync exposes view and navigation helpers without owning session selection", () => {
  createRoot((dispose) => {
    let creatingSession = false;
    const navigations: Navigation[] = [];

    const sessionRouteSync = createAppRouteSync({
      pathname: () => "/session/sess-a",
      navigate: (to, options) => navigations.push({ to, options }),
      isTauriRuntime: () => true,
      creatingSession: () => creatingSession,
    });

    assert.equal(sessionRouteSync.currentView(), "session");
    sessionRouteSync.goToSession(" sess-b ");
    assert.deepEqual(navigations.at(-1), { to: "/session/sess-b", options: undefined });

    const scopedPendingKey = createUiConversationKey({
      workspaceId: "ws-a",
      kind: "pending-session",
      id: "pending-session:abc",
    });
    sessionRouteSync.goToSession(scopedPendingKey);
    assert.deepEqual(navigations.at(-1), {
      to: `/session/${encodeURIComponent(scopedPendingKey)}`,
      options: undefined,
    });

    const dashboardRouteSync = createAppRouteSync({
      pathname: () => "/dashboard/scheduled",
      navigate: (to, options) => navigations.push({ to, options }),
      isTauriRuntime: () => true,
      creatingSession: () => creatingSession,
    });

    assert.equal(dashboardRouteSync.currentView(), "dashboard");
    dashboardRouteSync.setTab("skills");
    assert.equal(dashboardRouteSync.tab(), "skills");
    assert.deepEqual(navigations.at(-1), { to: "/dashboard/skills", options: undefined });

    const nonDashboardRouteSync = createAppRouteSync({
      pathname: () => "/session",
      navigate: (to, options) => navigations.push({ to, options }),
      isTauriRuntime: () => true,
      creatingSession: () => creatingSession,
    });

    const navigationCountBeforeTabChange = navigations.length;
    nonDashboardRouteSync.setTab("plugins");
    assert.equal(nonDashboardRouteSync.tab(), "plugins");
    assert.equal(
      navigations.length,
      navigationCountBeforeTabChange,
      "non-dashboard tab changes should only update local dashboard state",
    );

    creatingSession = true;
    nonDashboardRouteSync.setView("dashboard");
    creatingSession = false;
    assert.equal(navigations.length, navigationCountBeforeTabChange, "session creation guard should block dashboard navigation");

    nonDashboardRouteSync.setView("dashboard");
    assert.deepEqual(navigations.at(-1), { to: "/dashboard/plugins", options: undefined });

    dispose();
  });
});

test("desktop hash sync consumes absolute Tauri routes and mirrors dashboard tab aliases", () => {
  createRoot((dispose) => {
    const navigations: Navigation[] = [];
    const routeSync = createAppRouteSync({
      pathname: () => "/session",
      navigate: (to, options) => navigations.push({ to, options }),
      isTauriRuntime: () => true,
      creatingSession: () => false,
    });
    const windowTarget = {
      location: { hash: "#/dashboard/mcp?panel=runtime" },
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    routeSync.syncExternalHashRoute(windowTarget);

    assert.equal(routeSync.tab(), "mcp");
    assert.deepEqual(navigations, [{ to: "/dashboard/mcp?panel=runtime", options: { replace: true } }]);

    windowTarget.location.hash = "#not-a-route";
    routeSync.syncExternalHashRoute(windowTarget);
    assert.equal(navigations.length, 1, "non-path hashes should stay untouched");

    dispose();
  });
});

test("desktop hash sync listener ignores hashchange event arguments", () => {
  createRoot((dispose) => {
    const navigations: Navigation[] = [];
    const routeSync = createAppRouteSync({
      pathname: () => "/session",
      navigate: (to, options) => navigations.push({ to, options }),
      isTauriRuntime: () => true,
      creatingSession: () => false,
    });
    const windowTarget = {
      location: { hash: "#/dashboard/settings" },
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const onHashChange = createAppRouteHashChangeListener(() => windowTarget, routeSync.syncExternalHashRoute);

    assert.doesNotThrow(() => {
      onHashChange({ type: "hashchange" });
    });
    assert.deepEqual(navigations, [{ to: "/dashboard/settings", options: { replace: true } }]);

    dispose();
  });
});

test("startup route sync executes top-level route decisions and delegates session routes", () => {
  createRoot((dispose) => {
    let pathname = "/dashboard/unknown";
    let onboardingStep: OnboardingStep = "welcome";
    const navigations: Navigation[] = [];
    const sessionRoutes: string[] = [];

    const routeSync = createAppRouteSync({
      pathname: () => pathname,
      navigate: (to, options) => navigations.push({ to, options }),
      isTauriRuntime: () => true,
      creatingSession: () => false,
    });

    const startupDeps: AppStartupRouteSyncDeps = {
      onboardingStep: () => onboardingStep,
      activeSessionId: () => "sess-a",
      onSessionRoute: ({ rawPath }) => sessionRoutes.push(rawPath),
    };

    routeSync.syncStartupRouteOnce(startupDeps);
    assert.equal(routeSync.tab(), "scheduled");
    assert.deepEqual(navigations, [{ to: "/dashboard/scheduled", options: { replace: true } }]);

    pathname = "/session/sess-a";
    routeSync.syncStartupRouteOnce(startupDeps);
    assert.deepEqual(sessionRoutes, ["/session/sess-a"]);

    onboardingStep = "language";
    routeSync.syncStartupRouteOnce(startupDeps);
    assert.deepEqual(navigations.at(-1), { to: "/onboarding", options: { replace: true } });

    dispose();
  });
});
