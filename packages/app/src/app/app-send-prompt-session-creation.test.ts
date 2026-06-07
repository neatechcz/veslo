import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

test("sendPrompt keeps the session id returned by createSessionAndOpen before prompting", () => {
  assert.match(
    source,
    /let sessionID = options\.targetSessionId\?\.trim\(\) \|\| selectedSessionId\(\);\s*[\s\S]*?const initialSessionTitle = resolvedDraft\.text\.trim\(\);\s*const initialContent = \(resolvedDraft\.resolvedText \?\? resolvedDraft\.text\)\.trim\(\);[\s\S]*?if \(!sessionID\) \{\s*recordSendTrace\("sendPrompt:create-session-needed"\);\s*sessionID = \(await createSessionAndOpen\(initialSessionTitle, \{ blockAppDuringCreate: blockAppDuringPromptSend \}\)\) \?\? selectedSessionId\(\);\s*\}\s*if \(!sessionID\) \{\s*recordSendTrace\("sendPrompt:blocked-no-session"\);\s*stopSendPromptBusy\(\);\s*return false;\s*\}/s,
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
