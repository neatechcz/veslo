import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

test("sendPrompt keeps the session id returned by createSessionAndOpen before prompting", () => {
  assert.match(
    source,
    /let sessionID = options\.targetSessionId\?\.trim\(\) \|\| selectedSessionId\(\);\s*[\s\S]*?const initialSessionTitle = resolvedDraft\.text\.trim\(\);\s*const initialContent = \(resolvedDraft\.resolvedText \?\? resolvedDraft\.text\)\.trim\(\);[\s\S]*?if \(!sessionID\) \{\s*recordSendTrace\("sendPrompt:create-session-needed"\);\s*sessionID = \(await createSessionAndOpen\(initialSessionTitle, \{\s*blockAppDuringCreate: blockAppDuringPromptSend,\s*managedAiRuntimeAlreadyPrepared: true,\s*\}\)\) \?\? selectedSessionId\(\);\s*\}\s*if \(!sessionID\) \{\s*recordSendTrace\("sendPrompt:blocked-no-session"\);\s*stopSendPromptBusy\(\);\s*return false;\s*\}/s,
    "sendPrompt should use the session id returned by createSessionAndOpen so the first prompt is not dropped while selection state catches up",
  );
});

test("createSessionAndOpen persists the first composer text as the initial backend title", () => {
  const start = source.indexOf("async function createSessionAndOpen(");
  const end = source.indexOf("const openNewSessionWithDirectory = async () =>");
  assert.ok(start >= 0 && end > start, "createSessionAndOpen source should be present");

  const createSessionAndOpenSource = source.slice(start, end);
  assert.match(
    createSessionAndOpenSource,
    /const initialSessionTitle = initialTitle\.trim\(\);/,
    "createSessionAndOpen should trim the prompt before using it as the local temporary title",
  );
  assert.match(
    createSessionAndOpenSource,
    /createConversationFromVesloWriteApi\(\s*activeWorkspaceId,\s*initialSessionTitle \|\| undefined,\s*\);/s,
    "createSessionAndOpen should persist the first composer text as the backend session title until an explicit rename/title update happens",
  );
  assert.doesNotMatch(
    createSessionAndOpenSource,
    /c\.session\.create\(/,
    "createSessionAndOpen must not directly create OpenCode sessions from the UI",
  );
  assert.match(
    createSessionAndOpenSource,
    /registerPendingInitialSessionTitle\(session\.id, initialSessionTitle\);[\s\S]*const displaySession = applyPendingInitialSessionTitle\(session\);/,
    "createSessionAndOpen should register the prompt title locally and render it optimistically",
  );
});

test("createConversationFromVesloWriteApi synchronizes runtime route before creating the server conversation", () => {
  const helperStart = source.indexOf("  const syncConversationWorkspaceRuntimeRoute = async (");
  const helperEnd = source.indexOf("  const createConversationFromVesloWriteApi = async (", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "runtime route sync helper should be present before conversation creation");
  const helperSource = source.slice(helperStart, helperEnd);
  assert.match(
    helperSource,
    /await serverClient\.updateWorkspace\(normalizedWorkspaceId,\s*\{[\s\S]*baseUrl: runtimeBaseUrl,[\s\S]*directory: runtimeDirectory,[\s\S]*\}\);/s,
    "the server workspace registry should receive the scoped OpenCode baseUrl and active directory before session creation",
  );

  const createStart = source.indexOf("  const createConversationFromVesloWriteApi = async (");
  const createEnd = source.indexOf("  const runConversationFromVesloWriteApi = async (", createStart);
  assert.ok(createStart >= 0 && createEnd > createStart, "createConversationFromVesloWriteApi source should be present");
  const createSource = source.slice(createStart, createEnd);
  const syncIndex = createSource.indexOf("await syncConversationWorkspaceRuntimeRoute(");
  const createIndex = createSource.indexOf("serverClient.createConversation(");
  assert.ok(
    syncIndex >= 0 && createIndex > syncIndex,
    "the workspace route must be synchronized before the server tries to proxy OpenCode session creation",
  );
  assert.match(
    createSource,
    /serverClient\.createConversation\(serverWorkspaceId,\s*\{\s*directory: workspaceRoot \|\| undefined,\s*title,\s*\}\);/s,
    "conversation creation should carry the active workspace directory explicitly",
  );
});
