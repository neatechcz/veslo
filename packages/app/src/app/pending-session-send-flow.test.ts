import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
const sessionViewSource = readFileSync(new URL("./pages/session.tsx", import.meta.url), "utf8");

test("successful pending draft sends delete the pending draft only after the prompt handoff succeeds", () => {
  assert.match(
    appSource,
    /await runConversationOrLegacy\(\s*\{[\s\S]*kind: "prompt_async",[\s\S]*\},[\s\S]*\);\s*\}\s*await sessionStore\.refreshSessionMessages\(sessionID, \{ reason: "prompt-complete" \}\);[\s\S]*if \(pendingDraftSendState\) \{[\s\S]*const pendingDraftStorageKey = pendingDraftSendState\.key;[\s\S]*const pendingDraftId = pendingDraftSendState\.draftId;[\s\S]*if \(pendingDraftId && isTauriRuntime\(\)\) \{[\s\S]*await pendingSessionDraftsDelete\(pendingDraftId\);[\s\S]*\}[\s\S]*clearActivePendingDraftState\(\);[\s\S]*setComposerDraftBySessionId\(\(current\) => deleteSessionComposerDraft\(current, \{ storageKey: pendingDraftStorageKey \}\)\);[\s\S]*\}\s*finishPerf\(perfEnabled, "session\.prompt", "done", startedAt, \{[\s\S]*\}\);\s*return true;/s,
    "pending drafts should be deleted and cleared only after the conversation prompt handoff succeeds",
  );
});

test("submitted pending drafts are hidden from reuse until failure restores them", () => {
  const sendPromptStart = appSource.indexOf("  async function sendPrompt(");
  const sendPromptEnd = appSource.indexOf("  async function abortSession(", sendPromptStart);
  assert.notEqual(sendPromptStart, -1, "sendPrompt should exist");
  assert.notEqual(sendPromptEnd, -1, "sendPrompt block should end before abortSession");
  const sendPromptSource = appSource.slice(sendPromptStart, sendPromptEnd);

  assert.match(
    sendPromptSource,
    /const pendingDraftSendState = \(\(\) => \{[\s\S]*draftId: activePendingDraftMeta\(\)\?\.id\?\.trim\(\) \|\| null,[\s\S]*\}\;\s*\}\)\(\);\s*if \(pendingDraftSendState\?\.draftId && isTauriRuntime\(\)\) \{\s*markPendingDraftConsumed\(pendingDraftSendState\.draftId\);\s*\}/s,
    "a submitted pending draft should be excluded from future new-session draft reuse immediately",
  );
  assert.match(
    sendPromptSource,
    /const restorePendingDraftAfterSendFailure = \(\) => \{[\s\S]*if \(pendingDraftSendState\) \{\s*clearConsumedPendingDraftId\(pendingDraftSendState\.draftId\);[\s\S]*setActivePendingDraftKey\(pendingDraftSendState\.key\);/s,
    "a failed send that is still displayed should make the pending draft reusable again",
  );
});

test("pending draft sends capture their draft identity before async runtime preparation", () => {
  const sendPromptStart = appSource.indexOf("  async function sendPrompt(");
  const sendPromptEnd = appSource.indexOf("  async function abortSession(", sendPromptStart);
  assert.notEqual(sendPromptStart, -1, "sendPrompt should exist");
  assert.notEqual(sendPromptEnd, -1, "sendPrompt block should end before abortSession");
  const sendPromptSource = appSource.slice(sendPromptStart, sendPromptEnd);

  const captureIndex = sendPromptSource.indexOf("const pendingDraftSendState =");
  const consumeIndex = sendPromptSource.indexOf("markPendingDraftConsumed(pendingDraftSendState.draftId);", captureIndex);
  const runtimePrepIndex = sendPromptSource.indexOf("await ensureManagedAiAccessReadyForEngineStart()");
  assert.ok(captureIndex >= 0, "sendPrompt should capture pending draft state");
  assert.ok(consumeIndex > captureIndex, "sendPrompt should consume the captured pending draft id immediately");
  assert.ok(runtimePrepIndex > consumeIndex, "runtime preparation should happen after pending draft capture and consumption");
});

test("pending first-send materialization selects the real session only while the same draft is still active", () => {
  const sendPromptStart = appSource.indexOf("  async function sendPrompt(");
  const sendPromptEnd = appSource.indexOf("  async function abortSession(", sendPromptStart);
  assert.notEqual(sendPromptStart, -1, "sendPrompt should exist");
  assert.notEqual(sendPromptEnd, -1, "sendPrompt block should end before abortSession");
  const sendPromptSource = appSource.slice(sendPromptStart, sendPromptEnd);

  assert.match(
    sendPromptSource,
    /createSessionAndOpen\(initialSessionTitle, \{\s*blockAppDuringCreate: blockAppDuringPromptSend,\s*managedAiRuntimeAlreadyPrepared: true,\s*pendingSession: pendingSidebarSession,\s*shouldSelectCreatedSession: pendingDraftSendState\s*\? \(\) => activePendingDraftKey\(\) === pendingDraftSendState\.key\s*: undefined,\s*\}\)/s,
    "first-send materialization should not select an old pending draft after the user opens another pending draft",
  );

  const createSessionStart = appSource.indexOf("  async function createSessionAndOpen(");
  const createSessionEnd = appSource.indexOf("  const openNewSessionWithDirectory = async () =>", createSessionStart);
  assert.notEqual(createSessionStart, -1, "createSessionAndOpen should exist");
  assert.notEqual(createSessionEnd, -1, "createSessionAndOpen block should end before openNewSessionWithDirectory");
  const createSessionSource = appSource.slice(createSessionStart, createSessionEnd);

  assert.match(
    createSessionSource,
    /const shouldSelectCreatedSession = options\.shouldSelectCreatedSession \?\? \(\(\) => blockAppDuringCreate \|\| currentView\(\) === "session"\);/s,
    "manual session creation should keep selecting by default while pending first sends can guard selection",
  );
  assert.match(
    createSessionSource,
    /const shouldSelectSession = shouldSelectCreatedSession\(\);[\s\S]*if \(shouldSelectSession\) \{[\s\S]*await selectSession\(session\.id\);[\s\S]*\}[\s\S]*if \(shouldSelectSession\) \{[\s\S]*goToSession\(session\.id\);[\s\S]*\}/s,
    "selection and route navigation should both honor the guarded materialization decision",
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
    /if \(pendingDraftSendState\) \{\s*clearConsumedPendingDraftId\(pendingDraftSendState\.draftId\);\s*setActivePendingDraftKey\(pendingDraftSendState\.key\);\s*setActivePendingDraftMeta\(pendingDraftSendState\.meta\);\s*setView\("session"\);\s*\}/s,
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

test("accepted sends keep the submitted user message visible before clearing pending submit state", () => {
  const sendPromptStart = appSource.indexOf("  async function sendPrompt(");
  const sendPromptEnd = appSource.indexOf("  async function abortSession(", sendPromptStart);
  assert.notEqual(sendPromptStart, -1, "sendPrompt should exist");
  assert.notEqual(sendPromptEnd, -1, "sendPrompt block should end before abortSession");
  const sendPromptSource = appSource.slice(sendPromptStart, sendPromptEnd);

  assert.match(
    appSource,
    /const ensureAcceptedPromptVisibleInSession = \(sessionID: string, draft: ComposerDraft\) => \{[\s\S]*sessionStore\.sessionHasUserMessageText\(sessionID, text\)[\s\S]*sessionStore\.upsertLocalMessage\(sessionID, message\);[\s\S]*\};/s,
    "accepted sends should install a local submitted user message only when the transcript has not caught up",
  );
  assert.match(
    sendPromptSource,
    /await sessionStore\.refreshSessionMessages\(sessionID, \{ reason: "prompt-complete" \}\);\s*ensureAcceptedPromptVisibleInSession\(sessionID, resolvedDraft\);\s*if \(pendingDraftSendState\) \{/s,
    "the local submitted message fallback must run before pending draft cleanup clears the visible optimistic submit",
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
    /const blockAppDuringPromptSend = Boolean\(sessionID\);/,
    "a brand-new pending draft send should be identifiable so workspace/session materialization can stay scoped to the session view",
  );
  assert.match(
    sendPromptSource,
    /const createdSessionId = await createSessionAndOpen\(initialSessionTitle, \{\s*blockAppDuringCreate: blockAppDuringPromptSend,\s*managedAiRuntimeAlreadyPrepared: true,\s*pendingSession: pendingSidebarSession,\s*shouldSelectCreatedSession: pendingDraftSendState[\s\S]*\}\);[\s\S]*const materializedSessionId = createdSessionId\?\.trim\(\);[\s\S]*if \(materializedSessionId\) \{\s*sessionID = materializedSessionId;\s*options\.onMaterializedSessionId\?\.\(materializedSessionId\);[\s\S]*\} else \{\s*const selectedAfterCreate = selectedSessionId\(\);[\s\S]*sessionID = isPendingSessionInstanceId\(selectedAfterCreate\) \? null : selectedAfterCreate;[\s\S]*\}/,
    "first prompt session creation should opt out of global app blocking while existing-session sends keep the old guarded behavior",
  );

  const createSessionStart = appSource.indexOf("  async function createSessionAndOpen(");
  const createSessionEnd = appSource.indexOf("  const openNewSessionWithDirectory = async () =>", createSessionStart);
  assert.notEqual(createSessionStart, -1, "createSessionAndOpen should exist");
  assert.notEqual(createSessionEnd, -1, "createSessionAndOpen block should end before openNewSessionWithDirectory");
  const createSessionSource = appSource.slice(createSessionStart, createSessionEnd);

  assert.match(
    createSessionSource,
    /options: \{\s*blockAppDuringCreate\?: boolean;\s*managedAiRuntimeAlreadyPrepared\?: boolean;\s*pendingSession\?: PendingSidebarSessionMetadata \| null;\s*shouldSelectCreatedSession\?: \(\) => boolean;\s*\} = \{\}/,
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
    /const shouldSelectSession = shouldSelectCreatedSession\(\);[\s\S]*if \(shouldSelectSession\) \{[\s\S]*goToSession\(session\.id\);[\s\S]*\}/s,
    "non-blocking first-send materialization should not force the user back to chat after they navigate elsewhere",
  );
});

test("pending draft composer stays sendable while workspace startup is globally busy", () => {
  assert.match(
    appSource,
    /const activeComposerBusy = createMemo\(\(\) => \{\s*if \(activeConversationBusy\(\)\) return true;\s*const label = busyLabel\(\);\s*if \(label === "status\.running"\) return false;\s*if \(!activeSessionId\(\)\) return false;\s*return busy\(\);\s*\}\);/s,
    "the first no-session send should stay clickable while workspace/runtime startup is tracked by global busy state",
  );
});

test("first pending draft send goes pending before workspace activation and server conversation handoff", () => {
  const sendImmediateStart = sessionViewSource.indexOf("  const sendPromptImmediate = async (");
  const sendImmediateEnd = sessionViewSource.indexOf("  const drainNextQueuedDraft = async (", sendImmediateStart);
  assert.notEqual(sendImmediateStart, -1, "sendPromptImmediate should exist");
  assert.notEqual(sendImmediateEnd, -1, "sendPromptImmediate block should end before queue draining");
  const sendImmediateSource = sessionViewSource.slice(sendImmediateStart, sendImmediateEnd);

  const optimisticSubmitIndex = sendImmediateSource.indexOf("setOptimisticSubmittedDraft(");
  const handoffIndex = sendImmediateSource.indexOf("props.sendPromptAsync(");
  assert.ok(
    optimisticSubmitIndex >= 0 && handoffIndex > optimisticSubmitIndex,
    "the pending user message should be visible before the app send handoff starts",
  );

  const sendPromptStart = appSource.indexOf("  async function sendPrompt(");
  const sendPromptEnd = appSource.indexOf("  async function abortSession(", sendPromptStart);
  assert.notEqual(sendPromptStart, -1, "sendPrompt should exist");
  assert.notEqual(sendPromptEnd, -1, "sendPrompt block should end before abortSession");
  const sendPromptSource = appSource.slice(sendPromptStart, sendPromptEnd);

  const activationIndex = sendPromptSource.indexOf("await workspaceStore.ensureEngineForWorkspace({ activeRun: true })");
  const createConversationIndex = sendPromptSource.indexOf("await createSessionAndOpen(");
  const serverRunIndex = sendPromptSource.indexOf('kind: "prompt_async"', createConversationIndex);
  assert.ok(
    activationIndex >= 0 && createConversationIndex > activationIndex && serverRunIndex > createConversationIndex,
    "first send should activate the workspace, create/bind the server conversation, then submit the prompt run",
  );

  const createSessionStart = appSource.indexOf("  async function createSessionAndOpen(");
  const createSessionEnd = appSource.indexOf("  const openNewSessionWithDirectory = async () =>", createSessionStart);
  assert.notEqual(createSessionStart, -1, "createSessionAndOpen should exist");
  assert.notEqual(createSessionEnd, -1, "createSessionAndOpen block should end before openNewSessionWithDirectory");
  const createSessionSource = appSource.slice(createSessionStart, createSessionEnd);
  assert.match(
    createSessionSource,
    /await createConversationFromVesloWriteApi\(/,
    "new sessions should be created through the Veslo conversation API",
  );
  assert.doesNotMatch(
    createSessionSource,
    /c\.session\.create\(/,
    "new-session handoff must not directly create an OpenCode session from the UI",
  );
});
