import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

test("passive conversation read recovers existing server workspace after duplicate registration", () => {
  assert.match(
    source,
    /const duplicateWorkspaceIdFromError = \(error: unknown\) => \{[\s\S]*error instanceof VesloServerError[\s\S]*error\.status !== 409[\s\S]*error\.code !== "workspace_exists"[\s\S]*return detailId;/,
    "passive workspace registration should extract the existing workspace id from workspace_exists errors",
  );

  assert.match(
    source,
    /const relisted = error instanceof VesloServerError && error\.status === 409[\s\S]*await listRegisteredWorkspaceId\("after-duplicate"\)/,
    "passive workspace registration should re-list workspaces after duplicate registration errors",
  );
});

test("local Veslo server connection retries passive local sidebar refresh", () => {
  assert.match(
    source,
    /const passiveSidebarServerRefreshKey = createMemo\(\(\) => \{[\s\S]*vesloServerStatus\(\)[\s\S]*vesloServerBaseUrl\(\)[\s\S]*workspaceStore[\s\S]*workspaces\(\)/,
    "app should derive a retry key from local server readiness and local workspace paths",
  );

  assert.match(
    source,
    /createEffect\(\(\) => \{[\s\S]*passiveSidebarServerRefreshKey\(\)[\s\S]*refreshLocalSidebarWorkspaceSessions\(workspaceStore\.activeWorkspaceId\(\)\)/,
    "app should retry passive sidebar loading once the local Veslo server is connected",
  );
});
