import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

function sendPromptSource(): string {
  const start = source.indexOf("async function sendPrompt(");
  const end = source.indexOf("async function abortSession", start);
  assert.ok(start >= 0 && end > start, "sendPrompt source should be present");
  return source.slice(start, end);
}

function createSessionAndOpenSource(): string {
  const start = source.indexOf("async function createSessionAndOpen(");
  const end = source.indexOf("const chooseFolderForCurrentSession", start);
  assert.ok(start >= 0 && end > start, "createSessionAndOpen source should be present");
  return source.slice(start, end);
}

test("app delegates send orchestration decisions to the send orchestration controller", () => {
  assert.match(
    source,
    /import \{\s*resolveCreateSessionManagedAiPreflightDecision,\s*resolveCreateSessionRuntimeHealthPreflightDecision,\s*resolveSendPromptBusyOwnership,\s*\} from "\.\/controllers\/send-orchestration-controller";/,
    "app.tsx should import send orchestration controller helpers",
  );
});

test("sendPrompt uses the controller to decide busy ownership", () => {
  assert.match(
    sendPromptSource(),
    /const sendPromptBusyOwnership = resolveSendPromptBusyOwnership\(\{ sessionId: sessionID \}\);[\s\S]*const blockAppDuringPromptSend = sendPromptBusyOwnership\.ownsBusy;/,
    "sendPrompt busy ownership should be delegated",
  );
});

test("createSessionAndOpen uses the controller to skip duplicate send preflight gates", () => {
  const createSource = createSessionAndOpenSource();

  assert.match(
    createSource,
    /const managedAiPreflightDecision = resolveCreateSessionManagedAiPreflightDecision\(\{[\s\S]*preflightManagedAiReady: Boolean\(preflight\?\.managedAiReady\),[\s\S]*runtimeAlreadyPrepared: Boolean\(options\.managedAiRuntimeAlreadyPrepared\),[\s\S]*\}\);[\s\S]*if \(managedAiPreflightDecision\.type === "skip"\)/,
    "createSessionAndOpen managed AI preflight decision should be delegated",
  );

  assert.match(
    createSource,
    /const runtimeHealthPreflightDecision = resolveCreateSessionRuntimeHealthPreflightDecision\(\{[\s\S]*preflightRuntimeHealthOk: Boolean\(preflight\?\.runtimeHealthOk\),[\s\S]*\}\);[\s\S]*if \(runtimeHealthPreflightDecision\.type === "skip"\)/,
    "createSessionAndOpen runtime health preflight decision should be delegated",
  );
});
