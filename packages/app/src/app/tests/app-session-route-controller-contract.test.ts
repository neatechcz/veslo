import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

function sectionBetween(startNeedle: string, endNeedle: string, label: string): string {
  const start = source.indexOf(startNeedle);
  assert.ok(start >= 0, `${label} start should be present`);
  const end = source.indexOf(endNeedle, start);
  assert.ok(end > start, `${label} end should be present`);
  return source.slice(start, end);
}

test("app delegates session route decisions to the session route controller", () => {
  assert.match(
    source,
    /import \{\s*resolveRouteResumeDecision,\s*resolveSessionPathDecision,\s*\} from "\.\/controllers\/session-route-controller";/,
    "app.tsx should import the route decision helpers from controllers",
  );
});

test("route resume effect executes controller decisions instead of owning route policy inline", () => {
  const routeSource = sectionBetween(
    'let lastRouteClientResumeKey = "";',
    '  createEffect(() => {\r\n    const active = workspaceStore.activeWorkspaceDisplay();',
    "route resume effect",
  );

  assert.match(
    routeSource,
    /const routeResumeDecision = resolveRouteResumeDecision\(\{[\s\S]*?path: rawPath,[\s\S]*?routeSessionId: id,[\s\S]*?ownNavigationSessionId: routeResumeSelectionAlreadyHandledForSession,[\s\S]*?\}\);/s,
    "route resume effect should pass its reactive snapshot into the pure controller",
  );
  assert.match(
    routeSource,
    /switch \(routeResumeDecision\.type\) \{[\s\S]*case "ignore":[\s\S]*case "consume-own-navigation":[\s\S]*case "select-session":/s,
    "route resume effect should only execute the controller's returned action",
  );
  assert.doesNotMatch(
    routeSource,
    /routeResumeSelectionAlreadyHandledForSession === id[\s\S]*setSelectedSessionId\(id\);/s,
    "own-navigation consumption must not write selectedSessionId",
  );
});

test("top-level session route effect executes controller decisions instead of owning fallback policy inline", () => {
  const sessionRouteSource = sectionBetween(
    '      case "session-route": {',
    "  return (",
    "top-level session route effect",
  );

  assert.match(
    sessionRouteSource,
    /const sessionPathDecision = resolveSessionPathDecision\(\{[\s\S]*?path: rawPath,[\s\S]*?routeSessionId: id,[\s\S]*?ownNavigationSessionId: routeResumeSelectionAlreadyHandledForSession,[\s\S]*?\}\);/s,
    "top-level session route effect should pass its reactive snapshot into the pure controller",
  );
  assert.match(
    sessionRouteSource,
    /switch \(sessionPathDecision\.type\) \{[\s\S]*case "clear-session-view":[\s\S]*case "select-pending-session":[\s\S]*case "fallback-to-session-list":[\s\S]*case "consume-own-navigation":[\s\S]*case "select-session":/s,
    "top-level session route effect should only execute the controller's returned action",
  );
});
