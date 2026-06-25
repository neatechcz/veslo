import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const runtimeReadinessSource = readFileSync(
  new URL("../context/send-runtime-readiness.ts", import.meta.url),
  "utf8",
);

test("sendPrompt carries a preflight context into first-session creation", () => {
  const start = source.indexOf("async function sendPrompt(");
  const end = source.indexOf("async function abortSession", start);
  assert.ok(start >= 0 && end > start, "sendPrompt source should be present");
  const sendPromptSource = source.slice(start, end);

  assert.match(
    sendPromptSource,
    /const sendPreflight = createSendPreflightContext\(options\.sendTraceId\);/,
    "sendPrompt should create one preflight context for the whole send flow",
  );
  assert.match(
    sendPromptSource,
    /sendPreflight\.managedAiReady = true;/,
    "sendPrompt should mark managed AI readiness after the gate passes",
  );
  assert.match(
    sendPromptSource,
    /prepareSendRuntimeForSend\("sendPrompt", sendPreflight\)/,
    "sendPrompt should delegate runtime and managed AI readiness to the send readiness owner",
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
    sendPromptSource,
    /sendPreflight\.runtimeHealthOk = true;/,
    "sendPrompt should not treat a completed workspace engine ensure as a health probe",
  );
  assert.match(
    sendPromptSource,
    /createSessionAndOpen\(initialSessionTitle, \{[\s\S]*preflight: sendPreflight,[\s\S]*\}\)/,
    "sendPrompt should pass the same preflight context into createSessionAndOpen",
  );
});

test("createSessionAndOpen skips duplicate preflight gates when sendPrompt already passed them", () => {
  const start = source.indexOf("async function createSessionAndOpen(");
  const end = source.indexOf("const chooseFolderForCurrentSession = async () =>", start);
  assert.ok(start >= 0 && end > start, "createSessionAndOpen source should be present");
  const createSource = source.slice(start, end);

  assert.match(
    createSource,
    /const managedAiPreflightDecision = resolveCreateSessionManagedAiPreflightDecision\(\{[\s\S]*preflightManagedAiReady: Boolean\(createPreflight\.managedAiReady\),[\s\S]*runtimeAlreadyPrepared: Boolean\(options\.managedAiRuntimeAlreadyPrepared\),[\s\S]*\}\);[\s\S]*if \(managedAiPreflightDecision\.type === "skip"\) \{[\s\S]*recordSendTrace\("createSessionAndOpen:managed-ai-bootstrap-skip"/,
    "createSessionAndOpen should log and skip the duplicate managed AI gate",
  );
  assert.match(
    createSource,
    /const runtimeHealthPreflightDecision = resolveCreateSessionRuntimeHealthPreflightDecision\(\{[\s\S]*preflightRuntimeHealthOk: Boolean\(createPreflight\.runtimeHealthOk\),[\s\S]*\}\);[\s\S]*if \(runtimeHealthPreflightDecision\.type === "skip"\) \{[\s\S]*recordSendTrace\("createSessionAndOpen:health-skip"/,
    "createSessionAndOpen should log and skip the duplicate runtime health probe",
  );
  assert.ok(
    createSource.indexOf("const runtimeHealthPreflightDecision = resolveCreateSessionRuntimeHealthPreflightDecision") <
      createSource.indexOf("const managedAiPreflightDecision = resolveCreateSessionManagedAiPreflightDecision"),
    "createSessionAndOpen should prepare runtime before managed AI routing",
  );
});

test("send runtime preflight skips duplicate health only for an explicitly healthy preflight", () => {
  const start = runtimeReadinessSource.indexOf("async function ensureLocalRuntimeReachableForSend(");
  const end = runtimeReadinessSource.indexOf("async function connectLocalRuntimeClientFromEngineInfo", start);
  assert.ok(start >= 0 && end > start, "ensureLocalRuntimeReachableForSend source should be present");
  const ensureSource = runtimeReadinessSource.slice(start, end);

  assert.match(
    ensureSource,
    /if \(preflight\?\.runtimeHealthOk\) \{[\s\S]*recordSendTrace\(`\$\{reason\}:runtime-health-skip`,[\s\S]*reason: "send-preflight-already-healthy"[\s\S]*return true;[\s\S]*\}[\s\S]*if \(currentClient\) \{/s,
    "send runtime health should skip only when an earlier health probe marked the preflight healthy",
  );
});

