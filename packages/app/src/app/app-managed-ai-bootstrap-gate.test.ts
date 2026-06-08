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
    gateSource,
    /await waitForManagedAiBootstrapReady\([\s\S]*?return true;[\s\S]*?catch \(error\) \{[\s\S]*?setError\(error instanceof Error \? error\.message : safeStringify\(error\)\);[\s\S]*?return false;/s,
    "managed AI bootstrap readiness should report false after surfacing a setup error instead of letting sends continue",
  );
});

test("sendPrompt blocks when managed bootstrap readiness is unavailable before reading client", () => {
  const sendStart = source.indexOf("async function sendPrompt(");
  const sendEnd = source.indexOf("async function abortSession", sendStart);
  assert.ok(sendStart >= 0 && sendEnd > sendStart, "sendPrompt source should be present");
  const sendBlock = source.slice(sendStart, sendEnd);
  const ensureIndex = sendBlock.indexOf("if (!(await ensureManagedAiBootstrapReady()))");
  const runtimeFreshIndex = sendBlock.indexOf("if (!(await ensureManagedAiRuntimeFreshForSend()))");
  const localRuntimeIndex = sendBlock.indexOf('if (!(await ensureLocalRuntimeReachableForSend("sendPrompt")))');
  const clientIndex = sendBlock.indexOf("const resolveLegacyClient = () =>");
  assert.ok(ensureIndex >= 0, "sendPrompt should block when managed bootstrap readiness fails");
  assert.ok(runtimeFreshIndex >= 0, "sendPrompt should refresh stale managed provider runtime before using the client");
  assert.ok(localRuntimeIndex >= 0, "sendPrompt should check local runtime reachability before using the client");
  assert.ok(clientIndex >= 0, "sendPrompt routed client resolver should be present");
  assert.ok(ensureIndex < runtimeFreshIndex, "sendPrompt should check bootstrap readiness before refreshing runtime");
  assert.ok(runtimeFreshIndex < localRuntimeIndex, "sendPrompt should refresh stale runtime before local runtime reachability is checked");
  assert.ok(localRuntimeIndex < clientIndex, "sendPrompt should check local runtime reachability before grabbing the routed client");
});

test("sendPrompt waits for managed config before starting a cold local engine", () => {
  const start = source.indexOf("async function sendPrompt(");
  const end = source.indexOf("async function abortSession", start);
  assert.ok(start >= 0 && end > start, "sendPrompt source should be present");
  const block = source.slice(start, end);
  const accessReadyIndex = block.indexOf("ensureManagedAiAccessReadyForEngineStart");
  const configReadyIndex = block.indexOf("ensureManagedAiConfigReadyForEngineStart");
  const engineStartIndex = block.indexOf("workspaceStore.ensureEngineForWorkspace({ activeRun: true })");
  assert.ok(accessReadyIndex >= 0, "sendPrompt should wait for managed access readiness before cold engine start");
  assert.ok(configReadyIndex >= 0, "sendPrompt should wait for managed config readiness before cold engine start");
  assert.ok(engineStartIndex >= 0, "sendPrompt cold engine start should be present");
  assert.ok(accessReadyIndex < configReadyIndex, "managed AI access readiness must run before managed config readiness");
  assert.ok(configReadyIndex < engineStartIndex, "managed config readiness must run before cold local engine start");
});

test("managed AI cold-start config gate actively applies provider routing before waiting", () => {
  const start = source.indexOf("const ensureManagedAiConfigReadyForEngineStart = async");
  const end = source.indexOf("const ensureManagedAiRuntimeFreshForSend = async", start);
  assert.ok(start >= 0 && end > start, "ensureManagedAiConfigReadyForEngineStart source should be present");
  const block = source.slice(start, end);
  const applyIndex = block.indexOf("applyManagedAiConfigForEngineStart()");
  const waitIndex = block.indexOf("await waitForManagedAiBootstrapReady");
  assert.ok(applyIndex >= 0, "managed config gate should actively apply provider routing during cold send");
  assert.ok(waitIndex >= 0, "managed config gate should still keep the readiness fallback");
  assert.ok(applyIndex < waitIndex, "provider routing must be applied before the passive readiness wait");
});

test("managed AI cold-start access gate refreshes the app-side access bundle before engine start", () => {
  const start = source.indexOf("const ensureManagedAiAccessReadyForEngineStart = async");
  const end = source.indexOf("const currentManagedAiProviderRoutingReloadKey", start);
  assert.ok(start >= 0 && end > start, "ensureManagedAiAccessReadyForEngineStart source should be present");
  const block = source.slice(start, end);
  assert.match(
    block,
    /await ensureLocalVesloServerRunning\(\{ ignoreStartupPreference: true \}\);/,
    "local managed AI sends should start the local Veslo server before refreshing access",
  );
  assert.match(
    block,
    /requestManagedAiAccessRefresh\(\);/,
    "cold-start send should force a fresh managed AI access load instead of relying on a later effect",
  );
  assert.match(
    block,
    /hasClient: \(\) => Boolean\(managedAiAccess\(\)\) \|\| Boolean\(managedAiAccessError\(\)\),/,
    "the access gate should wait until the app has either loaded a managed profile or received a concrete access result",
  );
  assert.match(
    block,
    /setError\(managedAiAccessError\(\) \?\? AI_ACCESS_NOT_CONFIGURED_MESSAGE\);[\s\S]*?return false;/s,
    "missing managed AI access should block the send with the concrete access error before engine startup",
  );
});

test("sendPrompt reloads a stale managed provider runtime before creating a new session", () => {
  const start = source.indexOf("async function sendPrompt(");
  const end = source.indexOf("async function abortSession", start);
  assert.ok(start >= 0 && end > start, "sendPrompt source should be present");
  const block = source.slice(start, end);
  const runtimeFreshIndex = block.indexOf("ensureManagedAiRuntimeFreshForSend");
  const createSessionIndex = block.indexOf("createSessionAndOpen(initialSessionTitle");
  assert.ok(runtimeFreshIndex >= 0, "sendPrompt should check managed provider runtime freshness");
  assert.ok(createSessionIndex >= 0, "sendPrompt session creation should be present");
  assert.ok(runtimeFreshIndex < createSessionIndex, "stale managed provider runtime must be handled before session creation");
});

test("sendPrompt tells createSessionAndOpen that managed runtime freshness was already prepared", () => {
  const start = source.indexOf("async function sendPrompt(");
  const end = source.indexOf("async function abortSession", start);
  assert.ok(start >= 0 && end > start, "sendPrompt source should be present");
  const block = source.slice(start, end);
  assert.match(
    block,
    /createSessionAndOpen\(initialSessionTitle,\s*\{\s*blockAppDuringCreate: blockAppDuringPromptSend,\s*managedAiRuntimeAlreadyPrepared: true,\s*\}\)/s,
    "sendPrompt should not let first-session creation perform a duplicate managed runtime reload after send preflight",
  );
});

test("sendPrompt treats managed config reload as satisfied after a cold engine start", () => {
  const start = source.indexOf("async function sendPrompt(");
  const end = source.indexOf("async function abortSession", start);
  assert.ok(start >= 0 && end > start, "sendPrompt source should be present");
  const block = source.slice(start, end);
  assert.match(
    block,
    /if \(managedAiConfigRuntimeReloadKey\(\)\) \{\s*recordSendTrace\("sendPrompt:managed-ai-runtime-fresh-after-cold-start"\);[\s\S]*?setManagedAiConfigRuntimeReloadKey\(""\);[\s\S]*?\}/s,
    "a cold engine start after managed config readiness should clear the managed reload marker instead of immediately reloading again",
  );
});

test("sendPrompt treats post-start managed bootstrap reload as satisfied after a cold engine start", () => {
  const start = source.indexOf("async function sendPrompt(");
  const end = source.indexOf("async function abortSession", start);
  assert.ok(start >= 0 && end > start, "sendPrompt source should be present");
  const block = source.slice(start, end);
  const coldStartFlagIndex = block.indexOf("let managedAiColdEngineStarted = false;");
  const flagSetIndex = block.indexOf("managedAiColdEngineStarted = true;");
  const bootstrapIndex = block.indexOf("if (!(await ensureManagedAiBootstrapReady()))");
  const runtimeFreshIndex = block.indexOf("if (!(await ensureManagedAiRuntimeFreshForSend()))");
  assert.ok(coldStartFlagIndex >= 0, "sendPrompt should track cold engine starts");
  assert.ok(flagSetIndex >= 0, "sendPrompt should mark when a cold engine start succeeded");
  assert.ok(bootstrapIndex >= 0 && runtimeFreshIndex > bootstrapIndex, "sendPrompt bootstrap/runtime freshness gates should be present");
  assert.ok(coldStartFlagIndex < flagSetIndex, "cold start flag should be declared before it is set");
  assert.ok(flagSetIndex < bootstrapIndex, "cold start should be marked before post-start bootstrap runs");
  assert.match(
    block.slice(bootstrapIndex, runtimeFreshIndex),
    /if \(managedAiColdEngineStarted && managedAiConfigRuntimeReloadKey\(\)\) \{[\s\S]*?recordSendTrace\("sendPrompt:managed-ai-runtime-fresh-after-post-start-bootstrap"\);[\s\S]*?setManagedAiConfigRuntimeReloadKey\(""\);[\s\S]*?\}/s,
    "a reload marker created during post-start managed bootstrap should be cleared before the send tries to reload the runtime it just started",
  );
});

test("createSessionAndOpen checks managed bootstrap readiness before reading workspace state", () => {
  const start = source.indexOf("async function createSessionAndOpen(");
  const end = source.indexOf("async function persistFeedback", start);
  assert.ok(start >= 0 && end > start, "createSessionAndOpen source should be present");
  const block = source.slice(start, end);
  const ensureIndex = block.indexOf("if (!(await ensureManagedAiBootstrapReady()))");
  const runtimeFreshIndex = block.indexOf("if (!(await ensureManagedAiRuntimeFreshForSend()))");
  const localRuntimeIndex = block.indexOf('if (!(await ensureLocalRuntimeReachableForSend("createSessionAndOpen")))');
  const clientIndex = block.indexOf("const c = routedClient();");
  const directoryIndex = block.indexOf("const sessionDirectory = workspaceStore.activeWorkspaceRoot().trim();");
  assert.ok(ensureIndex >= 0, "createSessionAndOpen should check managed bootstrap readiness");
  assert.ok(runtimeFreshIndex >= 0, "createSessionAndOpen should refresh stale managed provider runtime");
  assert.ok(localRuntimeIndex >= 0, "createSessionAndOpen should check local runtime reachability");
  assert.ok(clientIndex >= 0, "createSessionAndOpen routed client read should be present");
  assert.ok(directoryIndex >= 0, "createSessionAndOpen workspace directory guard should be present");
  assert.ok(ensureIndex < runtimeFreshIndex, "createSessionAndOpen should check bootstrap readiness before refreshing runtime");
  assert.ok(runtimeFreshIndex < localRuntimeIndex, "createSessionAndOpen should refresh stale runtime before local runtime reachability is checked");
  assert.ok(localRuntimeIndex < clientIndex, "createSessionAndOpen should check local runtime reachability before grabbing the client");
  assert.ok(clientIndex < directoryIndex, "createSessionAndOpen should read workspace state only after runtime gates");
});

test("createSessionAndOpen can skip duplicate managed runtime freshness when sendPrompt already prepared it", () => {
  const start = source.indexOf("async function createSessionAndOpen(");
  const end = source.indexOf("async function persistFeedback", start);
  assert.ok(start >= 0 && end > start, "createSessionAndOpen source should be present");
  const block = source.slice(start, end);
  assert.match(
    block,
    /options:\s*\{[^}]*managedAiRuntimeAlreadyPrepared\?: boolean[^}]*\}/s,
    "createSessionAndOpen options should expose a managed runtime freshness preflight flag",
  );
  assert.match(
    block,
    /if \(!options\.managedAiRuntimeAlreadyPrepared\) \{\s*if \(!\(await ensureManagedAiBootstrapReady\(\)\)\) \{[\s\S]*?if \(!\(await ensureManagedAiRuntimeFreshForSend\(\)\)\) \{[\s\S]*?\}\s*\} else \{\s*recordSendTrace\("createSessionAndOpen:managed-ai-runtime-prepared"\);[\s\S]*?\}/s,
    "createSessionAndOpen should skip the duplicate managed bootstrap/runtime reload gates only when sendPrompt already prepared them",
  );
});

test("createSessionAndOpen stops when managed bootstrap readiness is unavailable", () => {
  const start = source.indexOf("async function createSessionAndOpen(");
  const end = source.indexOf("async function persistFeedback", start);
  assert.ok(start >= 0 && end > start, "createSessionAndOpen source should be present");
  const block = source.slice(start, end);
  assert.match(
    block,
    /if \(!\(await ensureManagedAiBootstrapReady\(\)\)\) \{\s*recordSendTrace\("createSessionAndOpen:blocked-managed-ai-bootstrap"\);[\s\S]*?return undefined;\s*\}/s,
    "session creation must not continue after managed bootstrap readiness fails",
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

test("managed AI bootstrap compares current veslo-server config before trusting the snapshot cache", () => {
  const start = source.indexOf("const currentOpencodeContent = JSON.stringify(config.opencode ?? {}, null, 2);");
  const end = source.indexOf("await vesloClient.patchConfig", start);
  assert.ok(start >= 0 && end > start, "managed AI veslo-server patch branch should be present");
  const block = source.slice(start, end);
  const compareIndex = block.indexOf("managedConfigContentsMatchForServerPatch(currentOpencodeContent, content)");
  const cacheIndex = block.indexOf("lastKnownConfigSnapshotByWs.get(wsKey) === desiredSnapshot");
  assert.ok(compareIndex >= 0, "managed config comparison should be present");
  assert.ok(cacheIndex < 0 || compareIndex < cacheIndex, "current config must be compared before cached snapshots can skip a patch");
});

test("managed AI config patching schedules a nonblocking runtime reload when idle", () => {
  const autoApplyBlocks = source.match(
    /const managedAiConfigAlreadyApplied =\s*lastManagedAiConfigAppliedForServerToken\(\) === providerRoutingReloadKey;\s*markManagedAiConfigApplied\(providerRoutingReloadKey\);[\s\S]*?if \(\s*shouldAutoReloadManagedAiConfig\(\{[\s\S]*?\}\) &&\s*!managedAiConfigAlreadyApplied\s*\) \{\s*applyManagedAiRuntimeReloadIfIdle\(providerRoutingReloadKey\);\s*\}/g,
  );

  assert.equal(
    autoApplyBlocks?.length,
    2,
    "both managed AI config branches should record the applied token and schedule the guarded background reload",
  );

  const helperStart = source.indexOf("const markManagedAiConfigApplied =");
  const helperEnd = source.indexOf("const markManagedAiRuntimeReloadRequired =", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "managed AI config apply helper should be present");
  const helperSource = source.slice(helperStart, helperEnd);
  assert.doesNotMatch(
    helperSource,
    /reloadWorkspaceEngine\(/,
    "managed AI config apply helper must only record state; reload scheduling is a separate guarded step",
  );
});

test("managed AI background auto-reload waits for an attached ready runtime", () => {
  const helperStart = source.indexOf("const applyManagedAiRuntimeReloadIfIdle =");
  const helperEnd = source.indexOf("markReloadRequiredHandler =", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "managed AI background reload helper should be present");
  const helperSource = source.slice(helperStart, helperEnd);
  assert.match(
    helperSource,
    /if \(!engineReady\(\) \|\| !routedClient\(\)\) return;/,
    "background reload must not cold-start or restart a runtime before the app has attached a client",
  );
  assert.match(
    helperSource,
    /if \(!canReloadWorkspace\(\) \|\| anyActiveRuns\(\) \|\| sendPromptInFlight\(\)\) return;/,
    "background reload should remain blocked while a no-session prompt send is already in flight",
  );
});

test("managed AI runtime reload marker works before the routed client is attached", () => {
  const helperStart = source.indexOf("const markManagedAiRuntimeReloadRequired =");
  const helperEnd = source.indexOf("const applyManagedAiRuntimeReloadIfIdle =", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "managed AI runtime reload helper should be present");
  const helperSource = source.slice(helperStart, helperEnd);
  assert.doesNotMatch(
    helperSource,
    /routedClient\(\)/,
    "managed AI runtime reload marker must not depend on an attached routed client",
  );
  assert.match(
    helperSource,
    /canReloadWorkspace\(\)/,
    "managed AI runtime reload marker should use the active local workspace reload capability",
  );
});

test("managed AI auto-reload is blocked while a prompt send is in flight", () => {
  assert.match(
    source,
    /const \[sendPromptInFlightCount, setSendPromptInFlightCount\] = createSignal\(0\);[\s\S]*?const sendPromptInFlight = createMemo\(\(\) => sendPromptInFlightCount\(\) > 0\);/s,
    "app should track prompt sends before a session has materialized as running",
  );
  assert.match(
    source,
    /releaseSendPromptInFlight = beginSendPromptInFlight\(\);[\s\S]*?finally \{[\s\S]*?releasePromptSendInFlight\(\);[\s\S]*?stopSendPromptBusy\(\);/s,
    "sendPrompt should keep the prompt-send guard active until all send cleanup finishes",
  );
  assert.match(
    source,
    /hasActiveRuns: anyActiveRuns\(\) \|\| sendPromptInFlight\(\),/g,
    "managed AI config reload should not restart the runtime while the first prompt send is still in flight",
  );
});
