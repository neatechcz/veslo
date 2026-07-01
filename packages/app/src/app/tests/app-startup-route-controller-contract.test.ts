import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const appRouteSyncSource = readFileSync(new URL("../context/app-route-sync.ts", import.meta.url), "utf8");

function sourceBetween(haystack: string, startNeedle: string, endNeedle: string, label: string): string {
  const start = haystack.indexOf(startNeedle);
  assert.ok(start >= 0, `${label} start should be present`);
  const end = haystack.indexOf(endNeedle, start);
  assert.ok(end > start, `${label} end should be present`);
  return haystack.slice(start, end);
}

function startupRouteSyncSource(): string {
  const decisionStart = appRouteSyncSource.indexOf("const startupRouteDecision = resolveAppStartupRouteDecision(");
  assert.ok(decisionStart >= 0, "startup route decision should be present");
  const start = appRouteSyncSource.lastIndexOf("const syncStartupRouteOnce =", decisionStart);
  const end = appRouteSyncSource.indexOf("const startStartupRouteSync =", decisionStart);
  assert.ok(start >= 0 && end > start, "startup route sync should be present");
  return appRouteSyncSource.slice(start, end);
}

test("app delegates top-level startup route decisions to the startup controller", () => {
  assert.match(
    source,
    /import \{ createAppRouteSync \} from "\.\/context\/app-route-sync";/,
    "app.tsx should import the route sync context instead of owning startup route policy",
  );
  assert.match(
    source,
    /appRouteSync\.startStartupRouteSync\(\{[\s\S]*onboardingStep,[\s\S]*activeSessionId,[\s\S]*onSessionRoute: sessionRouteSync\.handleSessionRoute/,
    "app.tsx should delegate top-level startup route execution while keeping session-route wiring local",
  );
  assert.match(
    appRouteSyncSource,
    /import \{[\s\S]*resolveAppStartupRouteDecision,[\s\S]*resolveDashboardRouteTab,[\s\S]*\} from "\.\.\/controllers\/app-startup-controller";/s,
    "the route sync module should import startup route helpers from controllers",
  );
});

test("startup route effect executes controller decisions instead of owning startup policy inline", () => {
  const routeSource = startupRouteSyncSource();
  const executorSource = sourceBetween(
    appRouteSyncSource,
    "function executeStartupRouteDecision(",
    "export function createAppRouteSync",
    "startup route decision executor",
  );

  assert.match(
    routeSource,
    /const startupRouteDecision = resolveAppStartupRouteDecision\(\{[\s\S]*rawPath,[\s\S]*onboardingStep: startupDeps\.onboardingStep\(\),[\s\S]*isTauriRuntime: deps\.isTauriRuntime\(\),[\s\S]*activeSessionId: startupDeps\.activeSessionId\(\),[\s\S]*\}\);/,
    "startup route effect should pass its reactive snapshot into the controller",
  );
  assert.match(
    executorSource,
    /switch \(decision\.type\) \{[\s\S]*case "navigate":[\s\S]*case "dashboard-route":[\s\S]*case "ignore":[\s\S]*case "session-route":/s,
    "startup route effect should only execute the controller's returned action",
  );
  assert.doesNotMatch(
    appRouteSyncSource,
    /onboardingStep\(\) === "language" \|\| onboardingStep\(\) === "auth"/,
    "startup route policy should not be duplicated inline outside the startup controller",
  );
});
