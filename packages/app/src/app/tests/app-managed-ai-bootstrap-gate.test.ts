import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const readinessSource = readFileSync(new URL("../context/send-runtime-readiness.ts", import.meta.url), "utf8");

test("managed AI bootstrap readiness returns a blocking result when setup is not ready", () => {
  const start = readinessSource.indexOf("const ensureManagedAiBootstrapReady = async");
  const end = readinessSource.indexOf("async function ensureLocalRuntimeReachableForSend", start);
  assert.ok(start >= 0 && end > start, "ensureManagedAiBootstrapReady source should be present");
  const sendStart = source.indexOf("async function sendPrompt(");
  const sendEnd = source.indexOf("async function abortSession", sendStart);
  assert.ok(sendStart >= 0 && sendEnd > sendStart, "sendPrompt source should be present");
  const sendSource = source.slice(sendStart, sendEnd);
  const gateIndex = sendSource.indexOf('"sendPrompt:ensure-managed-ai-bootstrap-ready"');
  const clientIndex = sendSource.indexOf("const c = routedClientForSendTarget(sendTargetWorkspace);");
  assert.ok(gateIndex >= 0, "sendPrompt should trace the managed bootstrap gate");
  assert.ok(clientIndex >= 0, "sendPrompt should read the routed client");
  assert.ok(
    gateIndex < clientIndex,
    "sendPrompt should wait for managed bootstrap readiness before grabbing the routed client",
  );
});

test("sendPrompt blocks when managed bootstrap readiness is unavailable before reading client", () => {
  const start = source.indexOf("async function sendPrompt(");
  const end = source.indexOf("async function abortSession", start);
  assert.ok(start >= 0 && end > start, "sendPrompt source should be present");
  const createStart = source.indexOf("async function createSessionAndOpen(");
  const createEnd = source.indexOf("const openNewSessionWithDirectory = async () =>", createStart);
  assert.ok(createStart >= 0 && createEnd > createStart, "createSessionAndOpen source should be present");
  const createSource = source.slice(createStart, createEnd);
  const skipIndex = createSource.indexOf("createSessionAndOpen:managed-ai-bootstrap-skip");
  const gateIndex = createSource.indexOf('"createSessionAndOpen:ensure-managed-ai-bootstrap-ready"');
  const clientIndex = createSource.indexOf("const c = routedClientForSendTarget(targetWorkspace);");
  assert.ok(skipIndex >= 0, "createSessionAndOpen should skip the gate when send preflight already passed it");
  assert.ok(gateIndex >= 0, "createSessionAndOpen should still trace the direct-create managed bootstrap gate");
  assert.ok(clientIndex >= 0, "createSessionAndOpen should read the routed client");
  assert.ok(
    gateIndex < clientIndex,
    "createSessionAndOpen should wait for managed bootstrap readiness before grabbing the routed client when not skipped",
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

test("managed AI config patching does not auto-dispose the engine before Send", () => {
  const autoApplyBlocks = source.match(
    /if \(\s*shouldAutoReloadManagedAiConfig\(\{[\s\S]*?\}\) &&\s*lastManagedAiConfigAppliedForServerToken\(\) !== providerRoutingReloadKey\s*\) \{\s*markManagedAiConfigApplied\(providerRoutingReloadKey\);\s*\}/g,
  );

  assert.equal(
    autoApplyBlocks?.length,
    2,
    "both managed AI config branches should record the applied token without calling the destructive reload path",
  );

  const helperStart = source.indexOf("const markManagedAiConfigApplied =");
  const helperEnd = source.indexOf("markReloadRequiredHandler =", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "managed AI config apply helper should be present");
  const helperSource = source.slice(helperStart, helperEnd);
  assert.doesNotMatch(
    helperSource,
    /reloadWorkspaceEngine\(/,
    "managed AI config apply helper must not call reloadWorkspaceEngine",
  );
});

test("managed AI bootstrap can use a validated current runtime config while access refresh is busy", () => {
  const start = readinessSource.indexOf("const ensureManagedAiBootstrapReady = async");
  const end = readinessSource.indexOf("async function ensureLocalRuntimeReachableForSend", start);
  assert.ok(start >= 0 && end > start, "ensureManagedAiBootstrapReady source should be present");
  const ensureSource = readinessSource.slice(start, end);

  assert.match(
    ensureSource,
    /const canUseCurrentManagedConfig =[\s\S]*deps\.managedAiAccessBusy\(\)[\s\S]*deps\.hasUsableManagedAiRuntimeConfigForSend\(\)/,
    "managed bootstrap should validate current runtime config before bypassing a busy access refresh",
  );
  assert.match(
    ensureSource,
    /hasManagedProfile:\s*\(Boolean\(deps\.managedAiAccess\(\)\) \|\| deps\.managedAiBootstrapBusy\(\)\) && !canUseCurrentManagedConfig/,
    "managed bootstrap should only skip waiting when the current runtime config is usable",
  );
});

test("managed AI access cache has a bounded TTL and hydrates before background refresh", () => {
  assert.match(
    source,
    /const MANAGED_AI_ACCESS_CACHE_TTL_MS = 30 \* 60 \* 1000;/,
    "managed AI access cache should have a bounded lifetime",
  );
  assert.match(
    source,
    /const cachedAccess = readManagedAiAccessCache\(managedAiCacheKey\);[\s\S]*setManagedAiAccess\(cachedAccess\.profile\);[\s\S]*setManagedAiGatewayAccessToken\(cachedAccess\.gatewayAccessToken\);[\s\S]*setManagedAiAccessBusy\(true\);/,
    "managed AI access cache should hydrate usable state before the refresh request marks access busy",
  );
});

test("managed AI access refresh uses single-flight per cache key", () => {
  assert.match(
    source,
    /let managedAiAccessRefreshInFlight:/,
    "managed AI refresh should keep an in-flight request slot",
  );
  assert.match(
    source,
    /managedAiAccessRefreshInFlight\?\.cacheKey === cacheKey[\s\S]*return managedAiAccessRefreshInFlight\.promise;/,
    "managed AI refresh should reuse the in-flight promise for the same cache key",
  );
  assert.match(
    source,
    /const loadManagedAiAccess = loadManagedAiAccessSingleFlight\(\s*managedAiCacheKey,/,
    "managed AI refresh effect should run through the single-flight helper",
  );
});

test("managed config write effect does not subscribe to access busy state when a profile is present", () => {
  assert.match(
    source,
    /const managedProfile = managedAiAccess\(\);[\s\S]*?const managedAccessBusy = managedProfile \? false : managedAiAccessBusy\(\);[\s\S]*?const managedAccessError = managedProfile \? null : managedAiAccessError\(\);/,
    "managed config writes should only track busy/error for transient no-profile preservation, not for normal cached profile refreshes",
  );
});
