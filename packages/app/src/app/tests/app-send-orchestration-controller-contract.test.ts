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

test("app delegates send orchestration decisions to the send orchestration controller", () => {
  assert.match(
    appSource,
    /createSessionSendWorkflow\(\{/,
    "app.tsx should wire send orchestration through the AM11 workflow module",
  );
  assert.match(
    createWorkflowSource,
    /resolveCreateSessionManagedAiPreflightDecision,[\s\S]*resolveCreateSessionRuntimeHealthPreflightDecision,/,
    "session creation workflow should import create-session orchestration decisions",
  );
});

test("sendPrompt uses the controller to decide busy ownership", () => {
  assert.match(
    sendPromptSource(),
    /const sendPromptBusyOwnership = deps\.resolveSendPromptBusyOwnership\(\{ sessionId: sessionID \}\);[\s\S]*const blockAppDuringPromptSend = sendPromptBusyOwnership\.ownsBusy;/,
    "sendPrompt busy ownership should be delegated",
  );
});

test("createSessionAndOpen uses the controller to skip duplicate send preflight gates", () => {
  const createSource = createSessionAndOpenSource();

  assert.match(
    createSource,
    /const managedAiPreflightDecision = resolveCreateSessionManagedAiPreflightDecision\(\{[\s\S]*preflightManagedAiReady: Boolean\(createPreflight\.managedAiReady\),[\s\S]*runtimeAlreadyPrepared: Boolean\(options\.managedAiRuntimeAlreadyPrepared\),[\s\S]*\}\);[\s\S]*if \(managedAiPreflightDecision\.type === "skip"\)/,
    "createSessionAndOpen managed AI preflight decision should be delegated",
  );

  assert.match(
    createSource,
    /const runtimeHealthPreflightDecision = resolveCreateSessionRuntimeHealthPreflightDecision\(\{[\s\S]*preflightRuntimeHealthOk: Boolean\(createPreflight\.runtimeHealthOk\),[\s\S]*\}\);[\s\S]*if \(runtimeHealthPreflightDecision\.type === "skip"\)/,
    "createSessionAndOpen runtime health preflight decision should be delegated",
  );
});
