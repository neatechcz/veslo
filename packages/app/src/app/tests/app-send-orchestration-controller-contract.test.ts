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

function appSourceBetween(startNeedle: string, endNeedle: string, label: string): string {
  const start = appSource.indexOf(startNeedle);
  assert.ok(start >= 0, `${label} start should be present`);
  const end = appSource.indexOf(endNeedle, start);
  assert.ok(end > start, `${label} end should be present`);
  return appSource.slice(start, end);
}

function sessionSendWorkflowWiringSource(): string {
  return appSourceBetween(
    "const sessionSendWorkflow = createSessionSendWorkflow({",
    "  const sendPrompt = sessionSendWorkflow.sendPrompt;",
    "session send workflow wiring",
  );
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

test("app wires prompt send in-flight tracking into the send workflow", () => {
  const trackerStart = appSource.indexOf("const startSendPromptInFlight = () => {");
  const workflowStart = appSource.indexOf("const sessionSendWorkflow = createSessionSendWorkflow({");
  assert.ok(trackerStart >= 0, "app.tsx should declare startSendPromptInFlight");
  assert.ok(workflowStart > trackerStart, "app.tsx should declare the in-flight tracker before wiring send workflow deps");

  const trackerSource = appSourceBetween(
    "const startSendPromptInFlight = () => {",
    "  const sessionSendWorkflow = createSessionSendWorkflow({",
    "prompt send in-flight tracker",
  );
  const wiringSource = sessionSendWorkflowWiringSource();

  assert.match(
    trackerSource,
    /const startSendPromptInFlight = \(\) => \{[\s\S]*setSendPromptInFlightCount\(\(count\) => count \+ 1\);[\s\S]*setSendPromptInFlightCount\(\(count\) => Math\.max\(0, count - 1\)\);[\s\S]*\};/,
    "app.tsx should expose an idempotent prompt send in-flight tracker",
  );
  assert.match(
    wiringSource,
    /\bstartSendPromptInFlight,/,
    "session send workflow deps should include the in-flight tracker used by managed AI reload guards",
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
