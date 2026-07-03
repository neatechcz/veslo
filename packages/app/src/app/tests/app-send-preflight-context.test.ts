import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const sendWorkflowSource = readFileSync(
  new URL("../pages/session-send-workflow.ts", import.meta.url),
  "utf8",
);
const createWorkflowSource = readFileSync(
  new URL("../pages/session-creation-workflow.ts", import.meta.url),
  "utf8",
);
const runtimeReadinessSource = readFileSync(
  new URL("../context/send-runtime-readiness.ts", import.meta.url),
  "utf8",
);
const managedRuntimeConfigSource = readFileSync(
  new URL("../context/managed-ai-runtime-config.ts", import.meta.url),
  "utf8",
);

function sendPromptSource(): string {
  const start = sendWorkflowSource.indexOf("async function sendPrompt(");
  const end = sendWorkflowSource.indexOf("async function abortSession", start);
  assert.ok(start >= 0 && end > start, "sendPrompt source should be present");
  return sendWorkflowSource.slice(start, end);
}

function createSessionAndOpenSource(): string {
  const start = createWorkflowSource.indexOf("const createSessionAndOpen = async (");
  const end = createWorkflowSource.indexOf("return {", start);
  assert.ok(start >= 0 && end > start, "createSessionAndOpen source should be present");
  return createWorkflowSource.slice(start, end);
}

test("sendPrompt carries a preflight context into first-session creation", () => {
  const source = sendPromptSource();

  assert.match(
    source,
    /const sendPreflight = deps\.createSendPreflightContext\(options\.sendTraceId\);/,
    "sendPrompt should create one preflight context for the whole send flow",
  );
  assert.match(
    source,
    /const sendRuntimePreparation = await deps\.prepareSendRuntimeForSend\("sendPrompt", sendPreflight\);[\s\S]*if \(!sendRuntimePreparation\.ok\) \{/,
    "sendPrompt should delegate runtime and managed AI readiness to the send readiness owner and consume its typed result",
  );
  const prepareStart = runtimeReadinessSource.indexOf("async function prepareSendRuntimeForSend(");
  const prepareEnd = runtimeReadinessSource.indexOf("async function connectLocalRuntimeClientFromEngineInfo", prepareStart);
  assert.ok(prepareStart >= 0 && prepareEnd > prepareStart, "prepareSendRuntimeForSend source should be present");
  const prepareSource = runtimeReadinessSource.slice(prepareStart, prepareEnd);
  assert.ok(
    prepareSource.indexOf("${reason}:ensure-local-runtime-reachable") <
      prepareSource.indexOf("${reason}:ensure-managed-ai-bootstrap-ready"),
    "send readiness owner should refresh runtime state before validating managed AI routing",
  );
  assert.doesNotMatch(
    source,
    /sendPreflight\.runtimeHealthOk = true;/,
    "sendPrompt should not treat a completed workspace engine ensure as a health probe",
  );
  assert.doesNotMatch(
    source,
    /sendPreflight\.(enginePrepared|managedAiReady) = true;/,
    "sendPrompt should not manually mark readiness flags owned by the readiness service",
  );
  assert.doesNotMatch(
    source,
    /managedAiRuntimeAlreadyPrepared: true,/,
    "sendPrompt should not pass a parallel managed-AI readiness flag beside the prepared preflight",
  );
  assert.match(
    source,
    /deps\.createSessionAndOpen\(initialSessionTitle, \{[\s\S]*preflight: sendPreflight,[\s\S]*\}\)/,
    "sendPrompt should pass the same preflight context into createSessionAndOpen",
  );
});

test("createSessionAndOpen skips duplicate preflight gates when sendPrompt already passed them", () => {
  const createSource = createSessionAndOpenSource();

  assert.match(
    createSource,
    /const managedAiPreflightDecision = resolveCreateSessionManagedAiPreflightDecision\(\{[\s\S]*preflightManagedAiReady: Boolean\(createPreflight\.managedAiReady\),[\s\S]*\}\);[\s\S]*if \(managedAiPreflightDecision\.type === "skip"\) \{[\s\S]*deps\.recordSendTrace\("createSessionAndOpen:managed-ai-bootstrap-skip"/,
    "createSessionAndOpen should log and skip the duplicate managed AI gate",
  );
  assert.match(
    createSource,
    /const runtimeHealthPreflightDecision = resolveCreateSessionRuntimeHealthPreflightDecision\(\{[\s\S]*preflightEnginePrepared: Boolean\(createPreflight\.enginePrepared\),[\s\S]*preflightRuntimeHealthOk: Boolean\(createPreflight\.runtimeHealthOk\),[\s\S]*\}\);[\s\S]*if \(runtimeHealthPreflightDecision\.type === "skip"\) \{[\s\S]*deps\.recordSendTrace\("createSessionAndOpen:health-skip"/,
    "createSessionAndOpen should log and skip the duplicate runtime preparation step",
  );
  assert.ok(
    createSource.indexOf("const runtimeHealthPreflightDecision = resolveCreateSessionRuntimeHealthPreflightDecision") <
      createSource.indexOf("const managedAiPreflightDecision = resolveCreateSessionManagedAiPreflightDecision"),
    "createSessionAndOpen should prepare runtime before managed AI routing",
  );
});

test("send runtime preflight skips duplicate health only for an explicitly healthy preflight", () => {
  const resultStart = runtimeReadinessSource.indexOf("async function ensureLocalRuntimeReachableForSendResult(");
  const wrapperStart = runtimeReadinessSource.indexOf("async function ensureLocalRuntimeReachableForSend(", resultStart);
  const prepareStart = runtimeReadinessSource.indexOf("async function prepareSendRuntimeForSend(", wrapperStart);
  const connectStart = runtimeReadinessSource.indexOf("async function connectLocalRuntimeClientFromEngineInfo", prepareStart);
  assert.ok(resultStart >= 0 && wrapperStart > resultStart, "typed runtime readiness result source should be present");
  assert.ok(prepareStart > wrapperStart && connectStart > prepareStart, "runtime readiness wrapper and prepare source should be present");
  const resultSource = runtimeReadinessSource.slice(resultStart, wrapperStart);
  const wrapperSource = runtimeReadinessSource.slice(wrapperStart, prepareStart);
  const prepareSource = runtimeReadinessSource.slice(prepareStart, connectStart);

  assert.match(
    resultSource,
    /Promise<SendRuntimePreparationResult>[\s\S]*if \(preflight\?\.runtimeHealthOk\) \{[\s\S]*recordSendTrace\(`\$\{reason\}:runtime-health-skip`,[\s\S]*reason: "send-preflight-already-healthy"[\s\S]*return \{[\s\S]*ok: true,[\s\S]*runtimeReady: true,[\s\S]*reason: "runtime-health-skip",[\s\S]*\};[\s\S]*\}[\s\S]*if \(currentClient\) \{/s,
    "send runtime health should skip only when an earlier health probe marked the preflight healthy",
  );
  assert.match(
    wrapperSource,
    /return \(await ensureLocalRuntimeReachableForSendResult\(reason, preflightOrTraceId\)\)\.ok;/,
    "the public boolean helper should delegate to the typed runtime readiness result",
  );
  assert.match(
    prepareSource,
    /const runtimeResult = await deps\.sendTraceStep\([\s\S]*ensureLocalRuntimeReachableForSendResult\(reason, preflight\)[\s\S]*if \(!runtimeResult\.ok\) \{[\s\S]*runtimeReason: runtimeResult\.reason,[\s\S]*runtimeRecoveryAttempted: runtimeResult\.recoveryAttempted,[\s\S]*targetWorkspaceId: runtimeResult\.workspaceId,/s,
    "prepareSendRuntimeForSend should report typed runtime failure details",
  );
});

test("managed AI send config preflight retries only local transient transport failures", () => {
  const retryStart = appSource.indexOf("shouldRetryManagedAiConfigReadForSend: (error, retryBaseUrl) =>");
  const retryEnd = appSource.indexOf("delay: (ms) =>", retryStart);
  assert.ok(retryStart >= 0 && retryEnd > retryStart, "managed AI config retry guard should be present");
  const retrySource = appSource.slice(retryStart, retryEnd);

  assert.match(
    retrySource,
    /isLoopbackVesloServerConnectionUrl\(retryBaseUrl\)[\s\S]*!\(error instanceof VesloServerError\)[\s\S]*isLocalVesloTransportError\(error\)[\s\S]*vesloServerRecentlyReachable\(\)/,
    "send config retry should be limited to local transport/socket failures after recent server reachability",
  );
  assert.doesNotMatch(
    retrySource,
    /isLoopbackUrl\(/,
    "send config retry should use the Veslo server connection URL guard instead of a generic loopback check",
  );

  const configCheckStart = managedRuntimeConfigSource.indexOf("const hasUsableManagedAiRuntimeConfigForSend = async");
  const configCheckEnd = managedRuntimeConfigSource.indexOf("const ensureManagedAiRuntimeAuthorizationForSend = async", configCheckStart);
  assert.ok(configCheckStart >= 0 && configCheckEnd > configCheckStart, "managed AI config check should be present");
  const configCheckSource = managedRuntimeConfigSource.slice(configCheckStart, configCheckEnd);

  assert.match(
    configCheckSource,
    /readManagedAiRuntimeConfigForSend\(\s*vesloClient,\s*vesloWorkspaceId,\s*vesloClient\.baseUrl,\s*routing\.tracePayload,\s*\)/,
    "send config preflight should use the narrow retry wrapper instead of a bare getConfig call",
  );
});

