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
  const start = createWorkflowSource.indexOf("const runCreateSessionFlow = async (");
  const end = createWorkflowSource.indexOf("\n  const createSession = (", start);
  assert.ok(start >= 0 && end > start, "runCreateSessionFlow source should be present");
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
    "  const sessionFlowFacade = createSessionFlowFacade({",
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
    /const sendPromptBusyOwnership = deps\.resolveSendPromptBusyOwnership\(\{\s*sessionId: sessionID,?\s*\}\);[\s\S]*const blockAppDuringPromptSend = sendPromptBusyOwnership\.ownsBusy;/,
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
    /const managedAiPreflightDecision =\s*resolveCreateSessionManagedAiPreflightDecision\(\{[\s\S]*preflightManagedAiReady: Boolean\(createPreflight\.managedAiReady\),/,
    "createSessionAndOpen should delegate the managed-AI preflight decision",
  );
  assert.match(
    createSource,
    /if \(serverSubmitOwnsManagedAiAdmission\) \{[\s\S]*createSessionAndOpen:server-submit-managed-ai-admission-skip/,
    "createSessionAndOpen should leave managed-AI admission to the server for server-owned writes",
  );
  assert.match(
    createSource,
    /else if \(managedAiPreflightDecision\.type === "skip"\)/,
    "createSessionAndOpen should retain the legacy managed-AI skip branch",
  );

  assert.match(
    createSource,
    /const runtimeHealthPreflightDecision =\s*resolveCreateSessionRuntimeHealthPreflightDecision\(\{[\s\S]*preflightEnginePrepared: Boolean\(createPreflight\.enginePrepared\),[\s\S]*preflightRuntimeHealthOk: Boolean\(createPreflight\.runtimeHealthOk\),/,
    "createSessionAndOpen should delegate the runtime-health preflight decision",
  );
  assert.match(
    createSource,
    /if \(serverSubmitOwnsFirstMessageAdmission\) \{[\s\S]*deps\.ensureServerOwnedSubmitTransportReady\(/,
    "createSessionAndOpen should use server admission for server-owned writes",
  );
  assert.match(
    createSource,
    /else if \(runtimeHealthPreflightDecision\.type === "skip"\)/,
    "createSessionAndOpen should retain the legacy runtime-health branch",
  );
});
