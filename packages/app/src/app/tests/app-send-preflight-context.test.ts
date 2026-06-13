import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

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
    /sendPreflight\.runtimeHealthOk = true;/,
    "sendPrompt should treat a successful workspace engine ensure as runtime health for this send flow",
  );
  assert.match(
    sendPromptSource,
    /createSessionAndOpen\(initialSessionTitle, \{[\s\S]*preflight: sendPreflight,[\s\S]*\}\)/,
    "sendPrompt should pass the same preflight context into createSessionAndOpen",
  );
});

test("createSessionAndOpen skips duplicate preflight gates when sendPrompt already passed them", () => {
  const start = source.indexOf("async function createSessionAndOpen(");
  const end = source.indexOf("const openNewSessionWithDirectory = async () =>", start);
  assert.ok(start >= 0 && end > start, "createSessionAndOpen source should be present");
  const createSource = source.slice(start, end);

  assert.match(
    createSource,
    /if \(preflight\?\.managedAiReady \|\| options\.managedAiRuntimeAlreadyPrepared\) \{[\s\S]*recordSendTrace\("createSessionAndOpen:managed-ai-bootstrap-skip"/,
    "createSessionAndOpen should log and skip the duplicate managed AI gate",
  );
  assert.match(
    createSource,
    /if \(preflight\?\.runtimeHealthOk\) \{[\s\S]*recordSendTrace\("createSessionAndOpen:health-skip"/,
    "createSessionAndOpen should log and skip the duplicate runtime health probe",
  );
});

test("send runtime preflight skips duplicate health after workspace engine ensure", () => {
  const start = source.indexOf("async function ensureLocalRuntimeReachableForSend(");
  const end = source.indexOf("async function connectLocalRuntimeClientFromEngineInfo", start);
  assert.ok(start >= 0 && end > start, "ensureLocalRuntimeReachableForSend source should be present");
  const ensureSource = source.slice(start, end);

  assert.match(
    ensureSource,
    /if \(preflight\?\.runtimeHealthOk\) \{[\s\S]*recordSendTrace\(`\$\{reason\}:runtime-health-skip`,[\s\S]*reason: "send-preflight-already-healthy"[\s\S]*return true;[\s\S]*\}[\s\S]*if \(currentClient\) \{/s,
    "send runtime health should not probe a workspace proxy that was just ensured healthy",
  );
});

