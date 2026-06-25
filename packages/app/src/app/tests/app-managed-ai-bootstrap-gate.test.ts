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
  const gateIndex = sendSource.indexOf('prepareSendRuntimeForSend("sendPrompt", sendPreflight)');
  const clientIndex = sendSource.indexOf("const c = routedClientForSendTarget(sendTargetWorkspace);");
  assert.ok(gateIndex >= 0, "sendPrompt should call the runtime readiness owner");
  assert.ok(clientIndex >= 0, "sendPrompt should read the routed client");
  assert.ok(
    gateIndex < clientIndex,
    "sendPrompt should wait for managed bootstrap readiness before grabbing the routed client",
  );
  assert.match(
    readinessSource,
    /deps\.sendTraceStep\(\s*`\$\{reason\}:ensure-managed-ai-bootstrap-ready`/,
    "send runtime readiness owner should trace the managed bootstrap gate",
  );
});

test("sendPrompt blocks when managed bootstrap readiness is unavailable before reading client", () => {
  const start = source.indexOf("async function sendPrompt(");
  const end = source.indexOf("async function abortSession", start);
  assert.ok(start >= 0 && end > start, "sendPrompt source should be present");
  const createStart = source.indexOf("async function createSessionAndOpen(");
  const createEnd = source.indexOf("const chooseFolderForCurrentSession = async () =>", createStart);
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

test("managed AI bootstrap waits for runtime gateway authorization before writing managed config", () => {
  assert.match(
    source,
    /const managedProfile = managedAiAccess\(\);[\s\S]*?const gatewayClient = gatewayVesloServerClient\(\);[\s\S]*?const providerRoutingTarget = resolveManagedAiProviderRoutingTarget\(\{[\s\S]*?\}\);\s*const gatewayAccessToken = managedAiGatewayAccessToken\(\) \|\| denGatewayAccessToken\(\);/s,
    "managed AI config writes should wait for the managed gateway token or DEN fallback before treating provider routing as ready",
  );
});

test("managed AI bootstrap routes desktop local providers through the local Veslo server target", () => {
  assert.match(
    source,
    /const providerRoutingLocalHost = activeVesloServerRoutingInfo\(\);[\s\S]*?const providerRoutingLocalBaseUrl =[\s\S]*?providerRoutingLocalHost\?\.baseUrl \?\? deriveLocalVesloServerUrlFromOpencodeBaseUrl\(baseUrl\(\)\) \?\? "";[\s\S]*?const providerRoutingEngineBaseUrl = providerRoutingLocalHost\?\.engineUrl \?\? "";/s,
    "managed AI config writes should resolve provider routing from the local host snapshot instead of the remote access gateway client",
  );
  assert.match(
    source,
    /requiresManagedAiEngineBaseUrl\(\{[\s\S]*?requiresEngineBridgeUrl: runtimeSandboxState\.requiresEngineBridgeUrl,[\s\S]*?configuredSandboxEnabled: runtimeSandboxState\.configuredEnabled,[\s\S]*?configuredSandboxBackend: runtimeSandboxState\.configuredBackend,[\s\S]*?effectiveSandboxBackend: runtimeSandboxState\.effectiveBackend,[\s\S]*?childKind: runtimeSandboxState\.childKind,[\s\S]*?\}\)/s,
    "managed AI routing should require a bridge URL from the runtime sandbox verdict instead of inferring it from an existing URL",
  );
  assert.match(
    source,
    /resolveManagedAiProviderRoutingTarget\(\{[\s\S]*?workspaceType: workspace\.workspaceType,[\s\S]*?activeBaseUrl: providerRoutingLocalBaseUrl,[\s\S]*?engineBaseUrl: providerRoutingEngineBaseUrl,[\s\S]*?requireEngineBaseUrl: providerRoutingRequiresEngineBaseUrl,[\s\S]*?activeToken: providerRoutingLocalHost\?\.clientToken \?\? "",[\s\S]*?gatewayBaseUrl: gatewayClient\?\.baseUrl \?\? "",[\s\S]*?\}\)/s,
    "managed AI config writes should pass the local routing target into provider config resolution",
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
    /const currentOpencodeContent = JSON\.stringify\(config\.opencode \?\? \{\}, null, 2\);[\s\S]*?const content = formatManagedAiAccessConfig\([\s\S]*?const desiredSnapshot = getConfigSnapshot\(content\);[\s\S]*?const cachedSnapshotMatches = lastKnownConfigSnapshotByWs\.get\(wsKey\) === desiredSnapshot;[\s\S]*?const redactedServerConfigMatches = managedConfigContentsMatchForServerPatch\([\s\S]*?const managedDecision = resolveManagedAiConfigWriteDecision\(\{[\s\S]*?managedConfigAlreadyCurrent: cachedSnapshotMatches \|\| redactedServerConfigMatches,[\s\S]*?\}\);[\s\S]*?if \(managedDecision\.type === "skip"\) \{\s*if \(!cachedSnapshotMatches && redactedServerConfigMatches\) \{\s*lastKnownConfigSnapshotByWs\.set\(wsKey, desiredSnapshot\);\s*\}\s*return;\s*\}[\s\S]*?await vesloClient\.patchConfig/s,
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
    /const currentConfigCheck = resolveManagedAiBootstrapCurrentConfigCheck\(\{[\s\S]*accessBusy: deps\.managedAiAccessBusy\(\),[\s\S]*bootstrapPendingCount: deps\.managedAiBootstrapPendingCount\(\),[\s\S]*reloadBusy: deps\.reloadBusy\(\),[\s\S]*\}\);[\s\S]*const canUseCurrentManagedConfig =[\s\S]*currentConfigCheck\.type === "check-current-config"[\s\S]*deps\.hasUsableManagedAiRuntimeConfigForSend\(targetWorkspace\)/,
    "managed bootstrap should validate current runtime config before bypassing a busy access refresh",
  );
  assert.match(
    ensureSource,
    /const waitDecision = resolveManagedAiBootstrapWaitDecision\(\{[\s\S]*managedProfilePresent: hasManagedProfile,[\s\S]*bootstrapBusy: deps\.managedAiBootstrapBusy\(\),[\s\S]*canUseCurrentManagedConfig,[\s\S]*\}\);[\s\S]*hasManagedProfile: waitDecision\.hasManagedProfile,/,
    "managed bootstrap should only skip waiting when the current runtime config is usable",
  );
});

test("managed AI runtime config validation is workspace-scoped", () => {
  const start = source.indexOf("const hasUsableManagedAiRuntimeConfigForSend = async");
  const end = source.indexOf("const sendRuntimeReadiness = createSendRuntimeReadiness", start);
  assert.ok(start >= 0 && end > start, "managed AI runtime config validation source should be present");
  const validationSource = source.slice(start, end);

  assert.match(
    validationSource,
    /hasUsableManagedAiRuntimeConfig\(\{[\s\S]*content: JSON\.stringify\(config\.opencode \?\? \{\}, null, 2\),[\s\S]*workspaceId: vesloWorkspaceId,[\s\S]*\}\)/,
    "server-backed config validation should require the current Veslo workspace id",
  );
  assert.match(
    validationSource,
    /hasUsableManagedAiRuntimeConfig\(\{[\s\S]*content: configFile\.content,[\s\S]*workspaceId: vesloWorkspaceId,[\s\S]*\}\)/,
    "project config validation should require the current Veslo workspace id when it is known",
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
    /const proofCachedAccess =[\s\S]*proofCacheState\.record[\s\S]*const cachedAccess = proofCachedAccess \?\? readManagedAiAccessCache\(managedAiCacheKey\);[\s\S]*if \(refreshPreflight\.applyCachedAccessFirst && cachedAccess\) \{[\s\S]*setManagedAiAccess\(cachedAccess\.profile\);[\s\S]*setManagedAiGatewayAccessToken\(cachedAccess\.gatewayAccessToken\);[\s\S]*setManagedAiAccessBusy\(true\);/,
    "managed AI access cache should hydrate usable proof or local state before the refresh request marks access busy",
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
