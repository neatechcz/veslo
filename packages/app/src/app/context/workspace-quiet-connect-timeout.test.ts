import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const runtimeControllerSource = readFileSync(
  new URL("./workspace-runtime-controller.ts", import.meta.url),
  "utf8",
);
const routingSource = readFileSync(new URL("./workspace-routing.ts", import.meta.url), "utf8");

test("quiet engine reconnect keeps workspace routing health checks enabled", () => {
  const connectQuietStart = runtimeControllerSource.indexOf("async function connectToEngineQuiet(");
  assert.notEqual(connectQuietStart, -1, "connectToEngineQuiet should exist in workspace runtime controller");

  const refreshStart = runtimeControllerSource.indexOf("async function refreshActiveClient", connectQuietStart);
  const connectQuietSource = runtimeControllerSource.slice(connectQuietStart, refreshStart);

  assert.match(
    connectQuietSource,
    /reason: context\?\.reason/,
    "quiet reconnect should forward the lifecycle reason into workspace routing diagnostics",
  );
  assert.match(
    connectQuietSource,
    /deps\.routing\.ensure\(workspaceId, baseUrl, ensureOptions\)/,
    "quiet reconnect should go through the workspace routing owner",
  );
  assert.doesNotMatch(
    connectQuietSource,
    /skipHealth/,
    "quiet reconnect should not bypass route health checks",
  );

  assert.match(
    routingSource,
    /opts\.waitForHealthy\(client, \{ timeoutMs: 10_000 \}\)/,
    "workspace routing should own the route health timeout",
  );
});
