import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

test("session route re-selects once when a client becomes available after bootstrap", () => {
  const routeStart = source.indexOf('let lastRouteClientResumeKey = "";');
  const routeEnd = source.indexOf("  createEffect(() => {\n    const active = workspaceStore.activeWorkspaceDisplay();", routeStart);
  assert.notStrictEqual(routeStart, -1, "route resume block should exist");
  assert.notStrictEqual(routeEnd, -1, "route resume block end should exist");
  const routeSource = source.slice(routeStart, routeEnd);

  assert.match(routeSource, /let lastRouteClientResumeKey = "";/);
  assert.doesNotMatch(
    routeSource,
    /if \(!client\(\)\) return;/,
    "route selection should keep working when the app has to fall back to the offline transcript loader",
  );
  assert.match(
    routeSource,
    /const connectionKey = \[\s*id,\s*client\(\) \? "live" : "offline",\s*clientDirectory\(\) \|\| workspaceStore\.activeWorkspaceRoot\(\)\.trim\(\),\s*connectedVersion\(\) \?\? "",\s*\]\.join\("::"\);/s,
    "route resume key should distinguish live vs offline selection and retry once the workspace root becomes available",
  );
  assert.match(routeSource, /if \(connectionKey === lastRouteClientResumeKey\) return;/);
  assert.match(
    routeSource,
    /const alreadyLoaded = selectedSessionId\(\) === id && visibleMessages\(\)\.length > 0;/,
    "route resume guard should skip re-select when the transcript is already present",
  );
  assert.match(
    routeSource,
    /lastRouteClientResumeKey = connectionKey;[\s\S]*void selectSession\(id\);/s,
    "route session should be re-selected once after the client reconnects so deep links survive bootstrap/startHost races",
  );
});
