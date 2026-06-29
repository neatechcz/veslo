import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveAppStartupRouteDecision,
  resolveDashboardRouteTab,
} from "../../controllers/app-startup-controller.js";

test("dashboard route tabs preserve valid tabs and canonicalize missing tabs", () => {
  assert.equal(resolveDashboardRouteTab("skills"), "skills");
  assert.equal(resolveDashboardRouteTab("plugins"), "plugins");
  assert.equal(resolveDashboardRouteTab("mcp"), "mcp");
  assert.equal(resolveDashboardRouteTab("missing"), "scheduled");

  assert.deepEqual(
    resolveAppStartupRouteDecision({
      rawPath: "/dashboard/plugins",
      onboardingStep: "welcome",
      isTauriRuntime: true,
    }),
    { type: "dashboard-route", tab: "plugins", canonicalize: false },
  );
  assert.deepEqual(
    resolveAppStartupRouteDecision({
      rawPath: "/dashboard/mcp",
      onboardingStep: "welcome",
      isTauriRuntime: true,
    }),
    { type: "dashboard-route", tab: "mcp", canonicalize: false },
  );
});

test("language and auth onboarding own startup routing without clearing loaded sessions", () => {
  assert.deepEqual(
    resolveAppStartupRouteDecision({
      rawPath: "/session/sess-a",
      onboardingStep: "language",
      isTauriRuntime: true,
      activeSessionId: "sess-a",
    }),
    { type: "navigate", to: "/onboarding", replace: true, reason: "onboarding-required" },
  );
  assert.deepEqual(
    resolveAppStartupRouteDecision({
      rawPath: "/onboarding",
      onboardingStep: "auth",
      isTauriRuntime: true,
      activeSessionId: "sess-a",
    }),
    { type: "ignore", reason: "onboarding-active" },
  );
});

test("root, onboarding-complete, and unknown routes fallback without choosing old chats on bare session", () => {
  assert.deepEqual(
    resolveAppStartupRouteDecision({
      rawPath: "/",
      onboardingStep: "welcome",
      isTauriRuntime: true,
      activeSessionId: "sess-a",
    }),
    { type: "navigate", to: "/session", replace: true, reason: "root" },
  );
  assert.deepEqual(
    resolveAppStartupRouteDecision({
      rawPath: "/onboarding",
      onboardingStep: "welcome",
      isTauriRuntime: true,
      activeSessionId: "sess-a",
    }),
    { type: "navigate", to: "/session", replace: true, reason: "onboarding-complete" },
  );
  assert.deepEqual(
    resolveAppStartupRouteDecision({
      rawPath: "/unknown",
      onboardingStep: "welcome",
      isTauriRuntime: true,
      activeSessionId: "sess-a",
    }),
    { type: "navigate", to: "/session/sess-a", replace: true, reason: "fallback-session" },
  );
});

test("session and proto route decisions stay explicit", () => {
  assert.deepEqual(
    resolveAppStartupRouteDecision({
      rawPath: "/session/sess-a",
      onboardingStep: "welcome",
      isTauriRuntime: true,
    }),
    { type: "session-route" },
  );
  assert.deepEqual(
    resolveAppStartupRouteDecision({
      rawPath: "/proto",
      onboardingStep: "welcome",
      isTauriRuntime: false,
    }),
    { type: "navigate", to: "/proto/workspaces", replace: true, reason: "proto-index" },
  );
  assert.deepEqual(
    resolveAppStartupRouteDecision({
      rawPath: "/proto/workspaces",
      onboardingStep: "welcome",
      isTauriRuntime: false,
    }),
    { type: "ignore", reason: "proto-web" },
  );
  assert.deepEqual(
    resolveAppStartupRouteDecision({
      rawPath: "/proto/workspaces",
      onboardingStep: "welcome",
      isTauriRuntime: true,
    }),
    { type: "navigate", to: "/dashboard/scheduled", replace: true, reason: "proto-tauri" },
  );
});
