import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const soulDataStoreSource = readFileSync(new URL("./pages/soul-data-store.ts", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("./pages/dashboard.tsx", import.meta.url), "utf8");

function extractFunctionBody(source: string, name: string): string {
  const marker = `const ${name} = async`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} should be declared`);

  const arrowBodyStart = source.indexOf("=> {", start);
  assert.notEqual(arrowBodyStart, -1, `${name} should have a function body`);
  const bodyStart = arrowBodyStart + 3;

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(bodyStart + 1, index);
      }
    }
  }

  assert.fail(`${name} body should be balanced`);
}

test("Soul overview refresh is started before workspace source mapping", () => {
  const refreshBody = extractFunctionBody(soulDataStoreSource, "refreshSoulData");

  assert.equal(
    refreshBody.includes("await client.getSoulOverview"),
    false,
    "refreshSoulData should keep the Den-backed overview refresh non-blocking",
  );

  const overviewKickoff = refreshBody.indexOf("void refreshSoulOverview(client);");
  const workspaceMapWork = refreshBody.indexOf("const workspaceMap = await resolveSoulWorkspaceMap();");

  assert.ok(overviewKickoff >= 0, "refreshSoulData should kick off Soul overview refresh");
  assert.ok(workspaceMapWork >= 0, "refreshSoulData should still map app workspaces to Soul source owners");
  assert.ok(
    overviewKickoff < workspaceMapWork,
    "overview refresh should be launched before workspace mapping, but without awaiting it",
  );
  assert.doesNotMatch(refreshBody, /getSoulStatus|listSoulHeartbeats|soulStatusBusy|soulHeartbeatsBusy/);
});

test("Soul refresh clears source state when the server is disconnected", () => {
  const refreshBody = extractFunctionBody(soulDataStoreSource, "refreshSoulData");

  const clientRead = refreshBody.indexOf("const client = deps.vesloServerClient();");
  const disconnectedGuard = refreshBody.indexOf('if (!client || deps.vesloServerStatus() !== "connected")');
  const overviewKickoff = refreshBody.indexOf("void refreshSoulOverview(client);");

  assert.ok(clientRead >= 0, "refreshSoulData should read the current Veslo client");
  assert.ok(disconnectedGuard >= 0, "refreshSoulData should still clear Soul state when disconnected");
  assert.ok(overviewKickoff >= 0, "refreshSoulData should kick off the overview refresh");
  assert.ok(clientRead < disconnectedGuard, "client state should be checked before any refresh work");
  assert.ok(disconnectedGuard < overviewKickoff, "overview should only start for a connected client");
  assert.doesNotMatch(refreshBody, /setSoulStatusBusy|setSoulHeartbeatsBusy|setActiveSoulHeartbeats/);
});

test("Dashboard props explicitly type current Soul overview state", () => {
  assert.doesNotMatch(dashboardSource, /VesloSoulStatus|VesloSoulHeartbeatEntry/);
  assert.match(
    dashboardSource,
    /soulOverview:\s*VesloSoulOverviewResponse\s*\|\s*null;/,
    "DashboardViewProps should include soulOverview",
  );
  assert.match(
    dashboardSource,
    /soulOverviewError:\s*string\s*\|\s*null;/,
    "DashboardViewProps should include soulOverviewError",
  );
});
