import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const sendWorkflowSource = readFileSync(
  new URL("../pages/session-send-workflow.ts", import.meta.url),
  "utf8",
);
const createWorkflowSource = readFileSync(
  new URL("../pages/session-creation-workflow.ts", import.meta.url),
  "utf8",
);
const storeSource = readFileSync(
  new URL("../context/managed-ai-access-store.ts", import.meta.url),
  "utf8",
);
const runtimeConfigSource = readFileSync(
  new URL("../context/managed-ai-runtime-config.ts", import.meta.url),
  "utf8",
);
const readinessSource = readFileSync(new URL("../context/send-runtime-readiness.ts", import.meta.url), "utf8");

function conversationRunCompatibilityBridgePrepareSource(): string {
  const bridgeStart = sendWorkflowSource.indexOf("export function createConversationRunCompatibilityBridge(");
  const prepareStart = sendWorkflowSource.indexOf("  const prepare = async", bridgeStart);
  const submitStart = sendWorkflowSource.indexOf("  const submit = async", prepareStart);
  assert.ok(prepareStart >= 0 && submitStart > prepareStart, "compatibility bridge prepare source should be present");
  return sendWorkflowSource.slice(prepareStart, submitStart);
}

test("managed AI bootstrap readiness returns a blocking result when setup is not ready", () => {
  const start = readinessSource.indexOf("const ensureManagedAiBootstrapReady = async");
  const end = readinessSource.indexOf("async function ensureLocalRuntimeReachableForSend", start);
  assert.ok(start >= 0 && end > start, "ensureManagedAiBootstrapReady source should be present");
  const prepareSource = conversationRunCompatibilityBridgePrepareSource();
  const gateIndex = prepareSource.indexOf('deps.prepareSendRuntimeForSend("sendPrompt", input.sendPreflight)');
  const clientIndex = prepareSource.indexOf("const c = deps.routedClientForSendTarget(input.sendTargetWorkspace);");
  assert.ok(gateIndex >= 0, "compatibility bridge prepare should call the runtime readiness owner");
  assert.ok(clientIndex >= 0, "compatibility bridge prepare should read the routed client");
  assert.ok(
    gateIndex < clientIndex,
    "compatibility bridge prepare should wait for managed bootstrap readiness before grabbing the routed client",
  );
  assert.match(
    readinessSource,
    /deps\.sendTraceStep\(\s*`\$\{reason\}:ensure-managed-ai-bootstrap-ready`/,
    "send runtime readiness owner should trace the managed bootstrap gate",
  );
});

test("sendPrompt blocks when managed bootstrap readiness is unavailable before reading client", () => {
  const start = sendWorkflowSource.indexOf("async function sendPrompt(");
  const end = sendWorkflowSource.indexOf("async function abortSession", start);
  assert.ok(start >= 0 && end > start, "sendPrompt source should be present");
  const createStart = createWorkflowSource.indexOf("const runCreateSessionFlow = async (");
  const createEnd = createWorkflowSource.indexOf("const createSession = (", createStart);
  assert.ok(createStart >= 0 && createEnd > createStart, "create session flow source should be present");
  const createSource = createWorkflowSource.slice(createStart, createEnd);
  const skipIndex = createSource.indexOf("createSessionAndOpen:managed-ai-bootstrap-skip");
  const gateIndex = createSource.indexOf('"createSessionAndOpen:ensure-managed-ai-bootstrap-ready"');
  const clientIndex = createSource.indexOf("const client = deps.routedClientForSendTarget(targetWorkspace);");
  assert.ok(skipIndex >= 0, "createSessionAndOpen should skip the gate when send preflight already passed it");
  assert.ok(gateIndex >= 0, "createSessionAndOpen should still trace the direct-create managed bootstrap gate");
  assert.ok(clientIndex >= 0, "createSessionAndOpen should read the routed client");
  assert.ok(
    gateIndex < clientIndex,
    "createSessionAndOpen should wait for managed bootstrap readiness before grabbing the routed client when not skipped",
  );
});

test("managed AI bootstrap writes config once local provider routing is available", () => {
  assert.match(
    runtimeConfigSource,
    /const managedProfile = deps\.managedAiAccess\(\);[\s\S]*?const routing = buildProviderRoutingContext\(workspace, workspaceId, root\);[\s\S]*?const gatewayAccessToken = deps\.managedAiGatewayAccessToken\(\) \|\| deps\.denGatewayAccessToken\(\);[\s\S]*?const providerRoutingReady = Boolean\(routing\.providerRoutingTarget\?\.serverClientToken\);/s,
    "managed AI config writes should require local provider routing, while runtime authorization is handled by send preflight",
  );
});

test("managed AI bootstrap routes desktop local providers through the local Veslo server target", () => {
  assert.match(
    runtimeConfigSource,
    /const providerRoutingLocalHost = deps\.activeVesloServerRoutingInfo\(\);[\s\S]*?const providerRoutingLocalBaseUrl = providerRoutingLocalHost\?\.baseUrl \?\? "";[\s\S]*?const providerRoutingEngineBaseUrl = providerRoutingLocalHost\?\.engineUrl \?\? "";/s,
    "managed AI config writes should resolve provider routing from the local host snapshot instead of guessing from the OpenCode base URL",
  );
  assert.doesNotMatch(
    runtimeConfigSource,
    /deriveLocalVesloServerUrlFromOpencodeBaseUrl|deps\.baseUrl\(\)/,
    "managed AI local provider routing should not rewrite the OpenCode data-plane URL into a Veslo control-plane URL",
  );
  assert.match(
    runtimeConfigSource,
    /requiresManagedAiEngineBaseUrl\(\{[\s\S]*?requiresEngineBridgeUrl: runtimeSandboxState\.requiresEngineBridgeUrl,[\s\S]*?configuredSandboxEnabled: runtimeSandboxState\.configuredEnabled,[\s\S]*?configuredSandboxBackend: runtimeSandboxState\.configuredBackend,[\s\S]*?effectiveSandboxBackend: runtimeSandboxState\.effectiveBackend,[\s\S]*?childKind: runtimeSandboxState\.childKind,[\s\S]*?\}\)/s,
    "managed AI routing should require a bridge URL from the runtime sandbox verdict instead of inferring it from an existing URL",
  );
  assert.match(
    runtimeConfigSource,
    /resolveManagedAiProviderRoutingTarget\(\{[\s\S]*?workspaceType: workspaceKind\(workspace\),[\s\S]*?activeBaseUrl: providerRoutingLocalBaseUrl,[\s\S]*?engineBaseUrl: providerRoutingEngineBaseUrl,[\s\S]*?requireEngineBaseUrl: providerRoutingRequiresEngineBaseUrl,[\s\S]*?activeToken: providerRoutingLocalHost\?\.clientToken \?\? "",[\s\S]*?gatewayBaseUrl: gatewayClient\?\.baseUrl \?\? "",[\s\S]*?\}\)/s,
    "managed AI config writes should pass the local routing target into provider config resolution",
  );
  assert.match(
    runtimeConfigSource,
    /serverBaseUrl: input\.providerRoutingTarget\.baseUrl,[\s\S]*?engineBaseUrl: input\.providerRoutingTarget\.engineBaseUrl,[\s\S]*?serverClientToken: input\.providerRoutingTarget\.serverClientToken/s,
    "managed AI provider config should use the resolved engine routing target URL and local server token",
  );
});

test("managed AI bootstrap preserves existing managed routing instead of downgrading to model-only config on transient access gaps", () => {
  assert.match(
    runtimeConfigSource,
    /shouldPreserveManagedAiConfig\(\{\s*content: configFile\.content,[\s\S]*?const content = formatConfigWithDefaultModel\(configFile\.content, input\.nextModel\);/s,
    "managed AI config writes should preserve existing gateway routing before falling back to a model-only config",
  );
});

test("managed AI access refresh keeps the proxied gateway access token when using the local Veslo server client", () => {
  assert.doesNotMatch(
    storeSource,
    /gatewayClient!\.getMyAiAccess\(userToken\)\.then\(\(response\) => \(\{\s*aiAccess: response\.aiAccess,\s*accessToken: null,\s*\}\)\)/s,
    "managed AI refresh should not discard the access token returned by the local Veslo server proxy",
  );
});

test("managed AI bootstrap skips veslo-server config patches when the computed managed config is unchanged", () => {
  assert.match(
    runtimeConfigSource,
    /const currentOpencodeContent = JSON\.stringify\(config\.opencode \?\? \{\}, null, 2\);[\s\S]*?const content = formatManagedAiAccessConfig\([\s\S]*?const desiredSnapshot = getConfigSnapshot\(content\);[\s\S]*?const cachedSnapshotMatches = lastKnownConfigSnapshotByWs\.get\(wsKey\) === desiredSnapshot;[\s\S]*?const redactedServerConfigMatches =[\s\S]*?cachedSnapshotMatches[\s\S]*?\? true[\s\S]*?: managedConfigContentsMatch\([\s\S]*?const managedDecision = resolveManagedAiConfigWriteDecision\(\{[\s\S]*?managedConfigAlreadyCurrent: cachedSnapshotMatches \|\| redactedServerConfigMatches,[\s\S]*?\}\);[\s\S]*?if \(managedDecision\.type === "skip"\) \{\s*if \(!cachedSnapshotMatches && redactedServerConfigMatches\) \{\s*lastKnownConfigSnapshotByWs\.set\(wsKey, desiredSnapshot\);\s*\}\s*return;\s*\}[\s\S]*?await input\.vesloClient\.patchConfig/s,
    "managed AI config writes through veslo-server should no-op when the generated config only differs by server-redacted secrets, while still tracking the real secret-bearing snapshot",
  );
});

test("managed AI config patching does not auto-dispose the engine before Send", () => {
  const autoApplyBlocks = runtimeConfigSource.match(
    /maybeMarkManagedConfigApplied\(input\.providerRoutingReloadKey, true\);/g,
  );

  assert.equal(
    autoApplyBlocks?.length,
    2,
    "both managed AI config branches should record the applied token without calling the destructive reload path",
  );

  const helperStart = runtimeConfigSource.indexOf("const markManagedAiConfigApplied =");
  const helperEnd = runtimeConfigSource.indexOf("const resolveRuntimeSandboxStateForTarget =", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "managed AI config apply helper should be present");
  const helperSource = runtimeConfigSource.slice(helperStart, helperEnd);
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
    /const currentConfigCheck = resolveManagedAiBootstrapCurrentConfigCheck\(\{[\s\S]*accessBusy: deps\.managedAiAccessBusy\(\),[\s\S]*bootstrapPendingCount: deps\.managedAiBootstrapPendingCount\(\),[\s\S]*reloadBusy: deps\.reloadBusy\(\),[\s\S]*\}\);[\s\S]*let canUseCurrentManagedConfig =[\s\S]*currentConfigCheck\.type === "check-current-config"[\s\S]*deps\.hasUsableManagedAiRuntimeConfigForSend\(targetWorkspace\)/,
    "managed bootstrap should validate current runtime config before bypassing a busy access refresh",
  );
  assert.match(
    ensureSource,
    /const waitDecision = resolveManagedAiBootstrapWaitDecision\(\{[\s\S]*managedProfilePresent: hasManagedProfile,[\s\S]*bootstrapBusy: deps\.managedAiBootstrapBusy\(\),[\s\S]*canUseCurrentManagedConfig,[\s\S]*\}\);[\s\S]*hasManagedProfile: waitDecision\.hasManagedProfile,/,
    "managed bootstrap should only skip waiting when the current runtime config is usable",
  );
});

test("managed AI bootstrap primes runtime authorization after config validation", () => {
  const start = readinessSource.indexOf("const ensureManagedAiBootstrapReady = async");
  const end = readinessSource.indexOf("async function ensureLocalRuntimeReachableForSend", start);
  assert.ok(start >= 0 && end > start, "ensureManagedAiBootstrapReady source should be present");
  const ensureSource = readinessSource.slice(start, end);

  assert.match(
    ensureSource,
    /canUseCurrentManagedConfig[\s\S]*deps\.ensureManagedAiRuntimeAuthorizationForSend[\s\S]*deps\.ensureManagedAiRuntimeAuthorizationForSend\(targetWorkspace\)[\s\S]*managedAiRuntimeAuthorizationNotReadyMessage[\s\S]*resolveManagedAiBootstrapWaitDecision/,
    "managed bootstrap should prime runtime authorization before it allows the send to continue",
  );
  assert.match(
    runtimeConfigSource,
    /const ensureManagedAiRuntimeAuthorizationForSend = async[\s\S]*const routing = buildProviderRoutingContext[\s\S]*const providerRoutingTarget = routing\.providerRoutingTarget;[\s\S]*deps\.createVesloServerClient\(\{[\s\S]*baseUrl: providerRoutingTarget\.baseUrl,[\s\S]*token: providerRoutingTarget\.serverClientToken,[\s\S]*\}\);[\s\S]*runtimeClient\.getMyAiAccess\(userToken\)/,
    "app should prime the same local Veslo server runtime used by managed provider routing",
  );
  assert.match(
    source,
    /createSendRuntimeReadiness<Client>\(\{[\s\S]*hasUsableManagedAiRuntimeConfigForSend,[\s\S]*ensureManagedAiRuntimeAuthorizationForSend,[\s\S]*waitForManagedAiBootstrapReady,/,
    "send runtime readiness should receive the runtime authorization priming dependency",
  );
});

test("managed AI runtime config validation is workspace-scoped", () => {
  const start = runtimeConfigSource.indexOf("const hasUsableManagedAiRuntimeConfigForSend = async");
  const end = runtimeConfigSource.indexOf("const ensureManagedAiRuntimeAuthorizationForSend = async", start);
  assert.ok(start >= 0 && end > start, "managed AI runtime config validation source should be present");
  const validationSource = runtimeConfigSource.slice(start, end);

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
    storeSource,
    /export const MANAGED_AI_ACCESS_CACHE_TTL_MS = 30 \* 60 \* 1000;/,
    "managed AI access cache should have a bounded lifetime",
  );
  assert.match(
    storeSource,
    /const proofCachedAccess =[\s\S]*proofCacheState\.record[\s\S]*const cachedAccess =[\s\S]*proofCachedAccess \?\? readManagedAiAccessCache\(managedAiCacheKey, cacheOptions\(\)\);[\s\S]*if \(refreshPreflight\.applyCachedAccessFirst && cachedAccess\) \{[\s\S]*setManagedAiAccess\(cachedAccess\.profile\);[\s\S]*setManagedAiGatewayAccessToken\(cachedAccess\.gatewayAccessToken\);[\s\S]*setManagedAiAccessBusy\(true\);/,
    "managed AI access cache should hydrate usable proof or local state before the refresh request marks access busy",
  );
});

test("managed AI access refresh uses single-flight per cache key", () => {
  assert.match(
    storeSource,
    /let managedAiAccessRefreshInFlight:/,
    "managed AI refresh should keep an in-flight request slot",
  );
  assert.match(
    storeSource,
    /managedAiAccessRefreshInFlight\?\.cacheKey === cacheKey[\s\S]*return managedAiAccessRefreshInFlight\.promise;/,
    "managed AI refresh should reuse the in-flight promise for the same cache key",
  );
  assert.match(
    storeSource,
    /const loadManagedAiAccess = loadManagedAiAccessSingleFlight\(\s*managedAiCacheKey,/,
    "managed AI refresh effect should run through the single-flight helper",
  );
});

test("managed config write effect does not subscribe to access busy state when a profile is present", () => {
  assert.match(
    runtimeConfigSource,
    /const managedProfile = deps\.managedAiAccess\(\);[\s\S]*?const managedAccessBusy = managedProfile \? false : deps\.managedAiAccessBusy\(\);[\s\S]*?const managedAccessError = managedProfile \? null : deps\.managedAiAccessError\(\);/,
    "managed config writes should only track busy/error for transient no-profile preservation, not for normal cached profile refreshes",
  );
});
