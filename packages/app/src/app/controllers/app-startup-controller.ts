import type { DashboardTab, OnboardingStep } from "../types";

const dashboardTabs = new Set<DashboardTab>([
  "scheduled",
  "soul",
  "skills",
  "plugins",
  "mcp",
  "config",
  "settings",
]);

const trim = (value: string | null | undefined) => value?.trim() ?? "";

export function resolveDashboardRouteTab(value?: string | null): DashboardTab {
  const normalized = trim(value).toLowerCase();
  if (dashboardTabs.has(normalized as DashboardTab)) {
    return normalized as DashboardTab;
  }
  return "scheduled";
}

export type AppStartupRouteDecision =
  | { type: "navigate"; to: string; replace: true; reason: "onboarding-required" | "root" | "proto-tauri" | "proto-index" | "onboarding-complete" | "fallback-session" }
  | { type: "dashboard-route"; tab: DashboardTab; canonicalize: boolean }
  | { type: "session-route" }
  | { type: "ignore"; reason: "proto-web" | "onboarding-active" };

export type ResolveAppStartupRouteDecisionInput = {
  rawPath: string;
  onboardingStep: OnboardingStep;
  isTauriRuntime: boolean;
  activeSessionId?: string | null;
};

export function resolveAppStartupRouteDecision(
  input: ResolveAppStartupRouteDecisionInput,
): AppStartupRouteDecision {
  const rawPath = trim(input.rawPath);
  const path = rawPath.toLowerCase();
  const onboardingActive = input.onboardingStep === "language" || input.onboardingStep === "auth";

  if (onboardingActive && !path.startsWith("/onboarding")) {
    return { type: "navigate", to: "/onboarding", replace: true, reason: "onboarding-required" };
  }

  if (path === "" || path === "/") {
    return { type: "navigate", to: "/session", replace: true, reason: "root" };
  }

  if (path.startsWith("/dashboard")) {
    const [, , tabSegment] = path.split("/");
    const tab = resolveDashboardRouteTab(tabSegment);
    return { type: "dashboard-route", tab, canonicalize: !tabSegment || tabSegment !== tab };
  }

  if (path.startsWith("/session")) {
    return { type: "session-route" };
  }

  if (path.startsWith("/proto-v1-ux")) {
    if (input.isTauriRuntime) {
      return { type: "navigate", to: "/dashboard/scheduled", replace: true, reason: "proto-tauri" };
    }
    return { type: "ignore", reason: "proto-web" };
  }

  if (path.startsWith("/proto")) {
    if (input.isTauriRuntime) {
      return { type: "navigate", to: "/dashboard/scheduled", replace: true, reason: "proto-tauri" };
    }

    const [, , protoSegment] = rawPath.split("/");
    if (!protoSegment) {
      return { type: "navigate", to: "/proto/workspaces", replace: true, reason: "proto-index" };
    }
    return { type: "ignore", reason: "proto-web" };
  }

  if (path.startsWith("/onboarding")) {
    if (onboardingActive) {
      return { type: "ignore", reason: "onboarding-active" };
    }
    return { type: "navigate", to: "/session", replace: true, reason: "onboarding-complete" };
  }

  const fallback = trim(input.activeSessionId);
  if (fallback) {
    return { type: "navigate", to: `/session/${fallback}`, replace: true, reason: "fallback-session" };
  }
  return { type: "navigate", to: "/session", replace: true, reason: "fallback-session" };
}
