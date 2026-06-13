import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

test("successful pending draft sends consume the pending draft only after the prompt handoff succeeds", () => {
  assert.match(
    appSource,
    /await runConversationOrLegacy\(\s*\{[\s\S]*kind: "prompt_async",[\s\S]*\},[\s\S]*\);\s*\}\s*if \(pendingDraftSendState\) \{[\s\S]*const pendingDraftStorageKey = pendingDraftSendState\.key;[\s\S]*const pendingDraftId = pendingDraftSendState\.draftId;[\s\S]*if \(pendingDraftId && isTauriRuntime\(\)\) \{[\s\S]*await pendingSessionDraftsDelete\(pendingDraftId\);[\s\S]*\}[\s\S]*clearActivePendingDraftState\(\);[\s\S]*setComposerDraftBySessionId\(\(current\) => deleteSessionComposerDraft\(current, \{ storageKey: pendingDraftStorageKey \}\)\);[\s\S]*\}\s*finishPerf\(perfEnabled, "session\.prompt", "done", startedAt, \{[\s\S]*\}\);\s*return true;/s,
    "pending drafts should be deleted and cleared only after the conversation prompt handoff succeeds",
  );
});

test("failed sends do not consume pending draft state", () => {
  const catchStart = appSource.indexOf("    } catch (e) {");
  const catchEnd = appSource.indexOf("    } finally {", catchStart);
  assert.notEqual(catchStart, -1, "send failure path should exist");
  assert.notEqual(catchEnd, -1, "send failure path should end before finally");
  const catchWindow = appSource.slice(catchStart, catchEnd);

  assert.doesNotMatch(
    catchWindow,
    /pendingSessionDraftsDelete\(|clearActivePendingDraftState\(|deleteSessionComposerDraft\(/,
    "failed sends must leave the pending draft intact",
  );
});

test("failed pending draft sends restore the pending draft route instead of leaving the empty real session selected", () => {
  assert.match(
    appSource,
    /if \(pendingDraftSendState\) \{\s*setActivePendingDraftKey\(pendingDraftSendState\.key\);\s*setActivePendingDraftMeta\(pendingDraftSendState\.meta\);\s*setView\("session"\);\s*\}/s,
    "pending-draft send failures should return the UI to the pending draft route",
  );
});

test("pending draft cleanup failures are handled separately from prompt handoff success", () => {
  assert.match(
    appSource,
    /if \(pendingDraftId && isTauriRuntime\(\)\) \{\s*try \{[\s\S]*const deleted = await pendingSessionDraftsDelete\(pendingDraftId\);[\s\S]*if \(!deleted\) \{[\s\S]*markPendingDraftConsumed\(pendingDraftId\);[\s\S]*console\.warn\([\s\S]*\} else \{[\s\S]*clearConsumedPendingDraftId\(pendingDraftId\);[\s\S]*\}[\s\S]*\} catch \(error\) \{[\s\S]*markPendingDraftConsumed\(pendingDraftId\);[\s\S]*reportError\(error, "pendingDrafts\.consume"\);[\s\S]*\}\s*\}/s,
    "pending-draft cleanup should report delete errors without converting a successful prompt handoff into a send failure",
  );
});

test("slash command sends preassign the message id used for optimistic display", () => {
  const commandBranchStart = appSource.indexOf("// Slash command: route through session.command() API");
  const commandBranchEnd = appSource.indexOf("        commandMessageIDToClear = null;", commandBranchStart);
  assert.notEqual(commandBranchStart, -1, "sendPrompt should have a slash command branch");
  assert.notEqual(commandBranchEnd, -1, "slash command branch should end before promptAsync branch");

  const commandBranch = appSource.slice(commandBranchStart, commandBranchEnd);
  assert.match(commandBranch, /commandMessageIDToClear = createClientMessageID\(\);/);
  assert.match(
    commandBranch,
    /sessionStore\.setCommandDisplay\(commandMessageID,\s*command\.name,\s*command\.arguments\);/,
  );
  assert.match(commandBranch, /messageID:\s*commandMessageID/);
});

test("failed slash command sends clear the preassigned command display alias", () => {
  const catchStart = appSource.indexOf("    } catch (e) {");
  const catchEnd = appSource.indexOf("    } finally {", catchStart);
  assert.notEqual(catchStart, -1, "send failure path should exist");
  assert.notEqual(catchEnd, -1, "send failure path should end before finally");
  const catchWindow = appSource.slice(catchStart, catchEnd);

  assert.match(
    catchWindow,
    /sessionStore\.clearCommandDisplay\(/,
    "failed slash-command sends should clear optimistic command display aliases",
  );
});

test("first pending draft send materializes workspace and session without global app blocking", () => {
  const sendPromptStart = appSource.indexOf("  async function sendPrompt(");
  const sendPromptEnd = appSource.indexOf("  async function abortSession(", sendPromptStart);
  assert.notEqual(sendPromptStart, -1, "sendPrompt should exist");
  assert.notEqual(sendPromptEnd, -1, "sendPrompt block should end before abortSession");
  const sendPromptSource = appSource.slice(sendPromptStart, sendPromptEnd);

  assert.match(
    sendPromptSource,
    /const sendPromptBusyOwnership = resolveSendPromptBusyOwnership\(\{ sessionId: sessionID \}\);[\s\S]*const blockAppDuringPromptSend = sendPromptBusyOwnership\.ownsBusy;/,
    "a brand-new pending draft send should be identifiable so workspace/session materialization can stay scoped to the session view",
  );
  assert.match(
    sendPromptSource,
    /const createdSessionId = await sendTraceStep\(\s*"sendPrompt:create-session-and-open"[\s\S]*?createSessionAndOpen\(initialSessionTitle, \{[\s\S]*?blockAppDuringCreate: blockAppDuringPromptSend,[\s\S]*?pendingSession: pendingSidebarSession,[\s\S]*?preflight: sendPreflight,[\s\S]*?\}\)[\s\S]*?\);[\s\S]*const materializedSessionId = createdSessionId\?\.trim\(\);[\s\S]*if \(materializedSessionId\) \{[\s\S]*sessionID = materializedSessionId;[\s\S]*options\.onMaterializedSessionId\?\.\(materializedSessionId\);/s,
    "first prompt session creation should opt out of global app blocking while existing-session sends keep the old guarded behavior",
  );

  const createSessionStart = appSource.indexOf("  async function createSessionAndOpen(");
  const createSessionEnd = appSource.indexOf("  const openNewSessionWithDirectory = async () =>", createSessionStart);
  assert.notEqual(createSessionStart, -1, "createSessionAndOpen should exist");
  assert.notEqual(createSessionEnd, -1, "createSessionAndOpen block should end before openNewSessionWithDirectory");
  const createSessionSource = appSource.slice(createSessionStart, createSessionEnd);

  assert.match(
    createSessionSource,
    /options: \{[\s\S]*?blockAppDuringCreate\?: boolean;[\s\S]*?preflight\?: SendPreflightContext;[\s\S]*?\} = \{\}/,
    "session creation should expose a scoped option for pending first sends",
  );
  assert.match(
    createSessionSource,
    /const blockAppDuringCreate = options\.blockAppDuringCreate \?\? true;/,
    "manual session creation should keep the existing global guard by default",
  );
  assert.match(
    createSessionSource,
    /if \(blockAppDuringCreate\) \{\s*setBusy\(true\);[\s\S]*setCreatingSession\(true\);[\s\S]*\}/s,
    "global busy and navigation lock should only be used when the caller requests app-level blocking",
  );
  assert.match(
    createSessionSource,
    /if \(shouldRouteCreatedSessionAfterSelect\(\{[^}]*blockAppDuringCreate,[^}]*currentView: currentView\(\)[^}]*\}\)\) \{[\s\S]*goToSession\(session\.id\);[\s\S]*\}/s,
    "non-blocking first-send materialization should not force the user back to chat after they navigate elsewhere",
  );
});
