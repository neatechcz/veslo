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

test("Soul overview refresh is started without blocking legacy status and heartbeat refresh", () => {
  const refreshBody = extractFunctionBody(soulDataStoreSource, "refreshSoulData");

  assert.equal(
    refreshBody.includes("await client.getSoulOverview"),
    false,
    "refreshSoulData must not await Den-backed overview before legacy status work",
  );

  const overviewKickoff = refreshBody.indexOf("void refreshSoulOverview(client);");
  const statusWork = refreshBody.indexOf("const workspaceMap = await resolveSoulWorkspaceMap();");

  assert.ok(overviewKickoff >= 0, "refreshSoulData should kick off Soul overview refresh");
  assert.ok(statusWork >= 0, "refreshSoulData should retain legacy workspace status refresh");
  assert.ok(
    overviewKickoff < statusWork,
    "overview refresh should be launched before status work, but without awaiting it",
  );
});

test("Soul overview refresh is not skipped by the legacy status busy guard", () => {
  const refreshBody = extractFunctionBody(soulDataStoreSource, "refreshSoulData");

  const clientRead = refreshBody.indexOf("const client = deps.vesloServerClient();");
  const disconnectedGuard = refreshBody.indexOf('if (!client || deps.vesloServerStatus() !== "connected")');
  const overviewKickoff = refreshBody.indexOf("void refreshSoulOverview(client);");
  const legacyBusyGuard = refreshBody.indexOf("if (soulStatusBusy() && !options?.force) return;");
  const legacyStatusBusySet = refreshBody.indexOf("setSoulStatusBusy(true);");

  assert.ok(clientRead >= 0, "refreshSoulData should read the current Veslo client");
  assert.ok(disconnectedGuard >= 0, "refreshSoulData should still clear Soul state when disconnected");
  assert.ok(overviewKickoff >= 0, "refreshSoulData should kick off the overview refresh");
  assert.ok(legacyBusyGuard >= 0, "refreshSoulData should keep the legacy status busy guard");
  assert.ok(legacyStatusBusySet >= 0, "refreshSoulData should still mark legacy status work busy");
  assert.ok(clientRead < disconnectedGuard, "client state should be checked before any refresh work");
  assert.ok(disconnectedGuard < overviewKickoff, "overview should only start for a connected client");
  assert.ok(
    overviewKickoff < legacyBusyGuard,
    "Den-backed overview refresh must not be skipped when legacy status work is busy",
  );
  assert.ok(
    legacyBusyGuard < legacyStatusBusySet,
    "legacy status/heartbeat work should remain single-flight after the overview kickoff",
  );
});

test("Dashboard props explicitly type retained Soul overview state", () => {
  assert.match(
    dashboardSource,
    /VesloSoulOverviewResponse,\s*VesloSoulStatus,/,
    "dashboard should import the Soul overview response type",
  );
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
