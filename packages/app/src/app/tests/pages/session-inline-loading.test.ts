import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");
const sessionSource = readFileSync(new URL("../../pages/session.tsx", import.meta.url), "utf8");
const pendingDraftControllerSource = readFileSync(
  new URL("../../context/pending-session-draft-controller.ts", import.meta.url),
  "utf8",
);

test("session loading stays route-owned without a pending preloader", () => {
  assert.match(
    sessionSource,
    /const showSessionLoadingState = createMemo\(\(\) =>[\s\S]*shouldShowSessionLoadingState\(\{[\s\S]*selectedSessionId: props\.selectedSessionId,[\s\S]*messageCount: effectiveRenderedMessages\(\)\.length,[\s\S]*loadingEarlierMessages: props\.loadingEarlierMessages,[\s\S]*\}\)[\s\S]*\);/,
    "session page should derive inline loading from the effectively rendered conversation, not raw backend messages only",
  );

  assert.match(
    sessionSource,
    /<Show when=\{showSessionLoadingState\(\)\}>/,
    "session page should render a dedicated inline loading state in the center pane",
  );

  assert.doesNotMatch(
    sessionSource,
    /pendingSessionLoad|setPendingSessionLoad|hasPendingSessionLoad/,
    "SessionView should not carry a separate pending-session preloader state",
  );

  assert.doesNotMatch(
    appSource,
    /pendingSessionLoad|setPendingSessionLoad/,
    "app shell should not own a separate pending-session preloader state",
  );
});

test("workspace setup empty state waits for hydrated workspace metadata", () => {
  assert.match(
    sessionSource,
    /const showWorkspaceSetupEmptyState = createMemo\(\s*\(\) =>\s*props\.workspacesHydrated === true &&\s*!hasWorkspaceConfigured\(\) &&\s*!props\.selectedSessionId &&\s*props\.messages\.length === 0,\s*\);/s,
    "the workspace setup empty state must not flash before bootstrap hydrates the workspace list",
  );
});

test("temporary runtime UI diagnostic is developer-mode only", () => {
  assert.match(
    sessionSource,
    /const markTempRuntimeUiRenderSource =[\s\S]*if \(!props\.developerMode\) return;[\s\S]*setTempRuntimeUiRenderSource\(createTempRuntimeUiRenderSnapshot/s,
    "runtime UI diagnostic updates should not run during normal user sessions",
  );
  assert.match(
    sessionSource,
    /const tempRuntimeUiDiagnosticBadge =[\s\S]*<Show when=\{props\.developerMode\}>[\s\S]*TEMP UI render source/s,
    "the temporary runtime UI badge must be hidden outside developer mode",
  );
});

test("session switch records browse scope and routes immediately without arming a preloader", () => {
  const openSessionStart = sessionSource.indexOf("  const openSessionFromList = (workspaceId: string, sessionId: string) => {");
  const openSessionEnd = sessionSource.indexOf("  const resolveVesloWorkspaceId = (workspaceId: string) => {", openSessionStart);
  assert.notEqual(openSessionStart, -1, "openSessionFromList should exist");
  assert.notEqual(openSessionEnd, -1, "openSessionFromList block end should exist");
  const openSessionSource = sessionSource.slice(openSessionStart, openSessionEnd);

  assert.doesNotMatch(
    openSessionSource,
    /setPendingSessionLoad|pendingSessionLoad/,
    "sidebar session clicks should not arm a pending-session preloader",
  );
  assert.match(
    openSessionSource,
    /props\.setSessionBrowseScope\(\{[\s\S]*workspaceId,[\s\S]*conversationId: session\?\.conversationId \?\? null,[\s\S]*opencodeSessionId: session\?\.opencodeSessionId \?\? nextSessionId,[\s\S]*\}\);[\s\S]*props\.setView\("session", nextSessionId\);/s,
    "session click navigation should record browse scope before routing to the target session",
  );
});

test("pending draft write-back only runs while the bare pending draft route owns the composer bucket", () => {
  assert.match(
    pendingDraftControllerSource,
    /createEffect\(\(\) => \{[\s\S]*if \(!deps\.isTauriRuntime\(\)\) return;[\s\S]*if \(!activePendingDraftStorageReady\(\)\) return;[\s\S]*const pendingDraftKey = activePendingDraftKey\(\);[\s\S]*const pendingDraftMetaValue = activePendingDraftMeta\(\);[\s\S]*if \(!pendingDraftKey \|\| !pendingDraftMetaValue\) return;[\s\S]*if \(input\.selectedSessionId\(\)\) return;/s,
    "pending-draft persistence should stop once a real session is selected so a failed send cannot overwrite the pending draft with the real-session composer bucket",
  );
});

test("bare new-session screen centers the composer entry without quickstart templates", () => {
  assert.match(
    sessionSource,
    /const showComposerEntryState = createMemo\(\(\) =>[\s\S]*effectiveRenderedMessages\(\)\.length === 0[\s\S]*!showWorkspaceSetupEmptyState\(\)[\s\S]*!showSessionLoadingState\(\)[\s\S]*\);/s,
    "bare new sessions should derive a dedicated centered composer-entry state from the rendered conversation",
  );

  assert.match(
    sessionSource,
    /<Show when=\{showComposerEntryState\(\)\}>[\s\S]*entryPlacement="center"[\s\S]*<\/Show>/s,
    "the centered composer-entry state should render the composer in center placement before the first send",
  );

  assert.doesNotMatch(
    sessionSource,
    /session\.quickstart_title|session\.quickstart_description|session\.quickstart_browser_title|session\.quickstart_soul_title|showQuickstartEmptyState/,
    "bare new sessions should not render the old quickstart heading or starter action cards",
  );
});

test("first submit dismisses the centered composer entry before backend handoff resolves", () => {
  assert.match(
    sessionSource,
    /const composerEntryDismissed = createMemo\(\(\) =>\s*Boolean\(composerEntryDismissedBySessionKey\(\)\[currentSessionQueueKey\(\)\]\),\s*\);/s,
    "the centered entry state should have a local per-session dismissal flag",
  );

  assert.match(
    sessionSource,
    /const showComposerEntryState = createMemo\(\(\) =>\s*effectiveRenderedMessages\(\)\.length === 0 &&\s*!composerEntryDismissed\(\) &&\s*!showWorkspaceSetupEmptyState\(\) &&\s*!showSessionLoadingState\(\),\s*\);/s,
    "a submit attempt should hide the centered entry even before backend messages or optimistic handoff survive",
  );

  assert.match(
    sessionSource,
    /const handleSendPrompt = async \(draft: ComposerDraft, options: ComposerSendOptions = \{\}\) => \{[\s\S]*if \(showComposerEntryState\(\)\) \{[\s\S]*dismissComposerEntryForSessionKey\(\);[\s\S]*\}/s,
    "the send handler should dismiss the entry immediately when the user submits from the bare new-session state",
  );
});

test("materializing a pending submitted draft preserves the visible run indicator", () => {
  assert.match(
    sessionSource,
    /const pendingBaseKey = pendingSessionQueueKey\(\);[\s\S]*const pendingKey = !previousSessionId[\s\S]*pendingQueueKeyAwaitingSessionIdByBaseKey\(\)\[pendingBaseKey\] \?\? null[\s\S]*const previousSessionKey = previousSessionId \? sessionQueueKeyForSessionId\(previousSessionId\) : null;[\s\S]*if \(!pendingKey && previousSessionKey\) \{\s*resetRunState\(previousSessionKey\);\s*\}/s,
    "selecting the real session created for a pending submit should remap the optimistic draft without resetting the active run indicator",
  );

  assert.doesNotMatch(
    sessionSource,
    /<Show when=\{props\.selectedSessionId \?\? "__no-session"\} keyed>/,
    "the composer/runtime footer must not remount on pending-to-real session materialization",
  );

  assert.match(
    sessionSource,
    /startRun\(materializedSessionIdFromHandoff \? sessionQueueKeyForSessionId\(materializedSessionIdFromHandoff\) : sessionKey\);/,
    "accepted pending sends should continue the visible run on the materialized real session key",
  );
});

test("optimistic submitted drafts enter responding phase before assistant parts arrive", () => {
  assert.match(
    sessionSource,
    /if \(status === "idle"\) \{\s*if \(!started\) return "idle";\s*if \(optimisticSubmittedDraft\(\)\) return "responding";/s,
    "a first optimistic submit should use the responding run phase, with the label decided separately from the phase",
  );
});

test("cold workspace pending sends use loading label until backend progress starts", () => {
  assert.match(
    sessionSource,
    /const workspaceSendWarmupActive = createMemo\(\(\) => \{[\s\S]*const submitted = optimisticSubmittedDraft\(\);[\s\S]*if \(!submitted \|\| submitted\.state !== "sending"\) return false;[\s\S]*if \(props\.engineReady !== false\) return false;[\s\S]*if \(runHasBegun\(\) \|\| responseStarted\(\)\) return false;[\s\S]*return true;[\s\S]*\}\);/s,
    "pending sends in browsing mode should be labeled as loading while the workspace/runtime is starting",
  );

  assert.match(
    sessionSource,
    /case "responding":\s*return workspaceSendWarmupActive\(\) \? tr\("session\.run_loading"\) : tr\("session\.run_responding"\);/s,
    "Responding/Odpovídám should change to Loading/Nahrávám only during workspace/runtime warmup",
  );
});

test("optimistic responding state survives idle workspace preflight while send handoff is pending", () => {
  assert.match(
    sessionSource,
    /if \(props\.sessionStatus !== "idle"\) return;\s*if \(optimisticSubmittedDraft\(\)\?\.state === "sending"\) return;\s*if \(runHasBegun\(\) \|\| responseStarted\(\)\) return;/s,
    "workspace/runtime startup can keep the session idle for more than the safety grace period, so the pending submitted draft must keep the run indicator visible until handoff resolves",
  );
});

test("optimistic responding state renders as the footer run indicator, not assistant response text", () => {
  assert.doesNotMatch(
    sessionSource,
    /pendingSubmittedDraftToAssistantPlaceholderMessage/,
    "session view should not turn the Responding/Odpovídám run label into a synthetic assistant text message",
  );

  assert.match(
    sessionSource,
    /const renderedMessages = createMemo\(\(\) => \{[\s\S]*const optimisticMessage = optimisticSubmittedMessage\(\);[\s\S]*const sourceMessages = optimisticMessage \? \[\.\.\.props\.messages, optimisticMessage\] : props\.messages;/s,
    "rendered messages should append only the optimistic user message while the run indicator owns responding status",
  );

  assert.match(
    sessionSource,
    /const showFooterRunIndicator = createMemo\(\(\) => showRunIndicator\(\)\);[\s\S]*footer=\{\s*showFooterRunIndicator\(\) \?/s,
    "the standard dot run indicator should remain visible while waiting for backend assistant output",
  );
});
