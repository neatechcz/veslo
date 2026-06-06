import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const appSource = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
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
  const refreshBody = extractFunctionBody(appSource, "refreshSoulData");

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
