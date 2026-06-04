import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

test("managed AI bootstrap readiness returns a blocking result when setup is not ready", () => {
  const start = source.indexOf("const ensureManagedAiBootstrapReady = async");
  const end = source.indexOf("const localRuntimeHealthTimeoutMessage", start);
  assert.ok(start >= 0 && end > start, "ensureManagedAiBootstrapReady source should be present");
  const gateSource = source.slice(start, end);
  assert.match(
    source,
    /async function sendPrompt\([\s\S]*?\)[\s\S]*?await ensureManagedAiBootstrapReady\(\);\s*const c = routedClient\(\);/s,
    "sendPrompt should wait for managed bootstrap readiness before grabbing the routed client",
  );
});

test("sendPrompt blocks when managed bootstrap readiness is unavailable before reading client", () => {
  const start = source.indexOf("async function sendPrompt(");
  const end = source.indexOf("async function abortSession", start);
  assert.ok(start >= 0 && end > start, "sendPrompt source should be present");
  const sendPromptSource = source.slice(start, end);
  assert.match(
    source,
    /async function createSessionAndOpen\(\)[\s\S]*?await ensureManagedAiBootstrapReady\(\);\s*const c = routedClient\(\);/s,
    "createSessionAndOpen should wait for managed bootstrap readiness before grabbing the routed client",
  );
});

test("managed AI bootstrap writes config with the managed gateway token when present and otherwise falls back to the DEN auth token", () => {
  assert.match(
    source,
    /const managedProfile = managedAiAccess\(\);[\s\S]*?const gatewayClient = gatewayVesloServerClient\(\);[\s\S]*?const providerRoutingTarget = resolveManagedAiProviderRoutingTarget\(\{[\s\S]*?\}\);\s*const gatewayAccessToken = managedAiGatewayAccessToken\(\) \|\| denGatewayAccessToken\(\);/s,
    "managed AI config writes should prefer the managed gateway token and fall back to the DEN auth token when no separate token is provided",
  );
});

test("managed AI bootstrap routes desktop local providers through the local Veslo server target", () => {
  assert.match(
    source,
    /const providerRoutingLocalHost = activeVesloServerHostInfo\(\);[\s\S]*?const providerRoutingLocalBaseUrl =[\s\S]*?providerRoutingLocalHost\?\.baseUrl \?\? deriveLocalVesloServerUrlFromOpencodeBaseUrl\(baseUrl\(\)\) \?\? "";[\s\S]*?const providerRoutingEngineBaseUrl =[\s\S]*?providerRoutingLocalHost\?\.engineUrl \?\? providerRoutingLocalBaseUrl;[\s\S]*?resolveManagedAiProviderRoutingTarget\(\{[\s\S]*?workspaceType: workspace\.workspaceType,[\s\S]*?activeBaseUrl: providerRoutingLocalBaseUrl,[\s\S]*?engineBaseUrl: providerRoutingEngineBaseUrl,[\s\S]*?activeToken: providerRoutingLocalHost\?\.clientToken \?\? "",[\s\S]*?gatewayBaseUrl: gatewayClient\?\.baseUrl \?\? "",[\s\S]*?\}\)/s,
    "managed AI config writes should resolve provider routing from the local host snapshot instead of the remote access gateway client",
  );
  assert.match(
    source,
    /serverBaseUrl: providerRoutingTarget\.baseUrl,[\s\S]*?engineBaseUrl: providerRoutingTarget\.engineBaseUrl,[\s\S]*?serverClientToken: providerRoutingTarget\.serverClientToken/s,
    "managed AI provider config should use the resolved engine routing target URL and local server token",
  );
});

test("managed AI bootstrap preserves existing managed routing instead of downgrading to model-only config on transient access gaps", () => {
  assert.match(
    source,
    /shouldPreserveManagedAiConfig\(\{\s*content: configFile\.content,[\s\S]*?const content = formatConfigWithDefaultModel\(configFile\.content, nextModel\);/s,
    "managed AI config writes should preserve existing gateway routing before falling back to a model-only config",
  );
});

test("managed AI access refresh keeps the proxied gateway access token when using the local Veslo server client", () => {
  assert.doesNotMatch(
    source,
    /gatewayClient!\.getMyAiAccess\(userToken\)\.then\(\(response\) => \(\{\s*aiAccess: response\.aiAccess,\s*accessToken: null,\s*\}\)\)/s,
    "managed AI refresh should not discard the access token returned by the local Veslo server proxy",
  );
});

test("managed AI bootstrap skips veslo-server config patches when the computed managed config is unchanged", () => {
  assert.match(
    source,
    /const currentOpencodeContent = JSON\.stringify\(config\.opencode \?\? \{\}, null, 2\);[\s\S]*?const content = formatManagedAiAccessConfig\([\s\S]*?const desiredSnapshot = getConfigSnapshot\(content\);[\s\S]*?if \(lastKnownConfigSnapshotByWs\.get\(wsKey\) === desiredSnapshot\) \{\s*return;\s*\}[\s\S]*?if \(managedConfigContentsMatchForServerPatch\(currentOpencodeContent, content\)\) \{\s*lastKnownConfigSnapshotByWs\.set\(wsKey, desiredSnapshot\);\s*return;\s*\}[\s\S]*?await vesloClient\.patchConfig/s,
    "managed AI config writes through veslo-server should no-op when the generated config only differs by server-redacted secrets, while still tracking the real secret-bearing snapshot",
  );
});

test("managed AI reload coalescing records the server token only after a successful reload", () => {
  const reloadBlocks = source.match(
    /if \(\s*shouldAutoReloadManagedAiConfig\(\{[\s\S]*?\}\) &&\s*lastReloadedForServerToken\(\) !== providerRoutingReloadKey\s*\) \{\s*const managedAiReloaded = await reloadWorkspaceEngine\(\);\s*if \(managedAiReloaded\) \{\s*setLastReloadedForServerToken\(providerRoutingReloadKey\);\s*\}\s*\}/g,
  );

  assert.equal(
    reloadBlocks?.length,
    2,
    "both managed AI reload branches should mark the server token only after reloadWorkspaceEngine reports success",
  );
});
