import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

function startupRouteEffectSource(): string {
  const decisionStart = source.indexOf("const startupRouteDecision = resolveAppStartupRouteDecision(");
  assert.ok(decisionStart >= 0, "startup route decision should be present");
  const start = source.lastIndexOf("  createEffect(() => {", decisionStart);
  const end = source.indexOf("  return (", decisionStart);
  assert.ok(start >= 0 && end > start, "startup route effect should be present");
  return source.slice(start, end);
}

test("app delegates top-level startup route decisions to the startup controller", () => {
  assert.match(
    source,
    /import \{\s*resolveAppStartupRouteDecision,\s*resolveDashboardRouteTab,\s*\} from "\.\/controllers\/app-startup-controller";/,
    "app.tsx should import startup route helpers from controllers",
  );
});

test("startup route effect executes controller decisions instead of owning startup policy inline", () => {
  const routeSource = startupRouteEffectSource();

  assert.match(
    routeSource,
    /const startupRouteDecision = resolveAppStartupRouteDecision\(\{[\s\S]*rawPath,[\s\S]*onboardingStep: onboardingStep\(\),[\s\S]*isTauriRuntime: isTauriRuntime\(\),[\s\S]*activeSessionId: activeSessionId\(\),[\s\S]*\}\);/,
    "startup route effect should pass its reactive snapshot into the controller",
  );
  assert.match(
    routeSource,
    /switch \(startupRouteDecision\.type\) \{[\s\S]*case "navigate":[\s\S]*case "dashboard-route":[\s\S]*case "session-route":[\s\S]*case "ignore":/s,
    "startup route effect should only execute the controller's returned action",
  );
  assert.doesNotMatch(
    routeSource,
    /onboardingStep\(\) === "language" \|\| onboardingStep\(\) === "auth"/,
    "startup route policy should not be duplicated inline in app.tsx",
  );
});
