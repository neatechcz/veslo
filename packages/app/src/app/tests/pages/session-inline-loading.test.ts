import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");
const sessionSource = readFileSync(new URL("../../pages/session.tsx", import.meta.url), "utf8");

test("session loading stays route-owned without a pending preloader", () => {
  assert.match(
    sessionSource,
    /const showSessionLoadingState = createMemo\(\(\) =>[\s\S]*shouldShowSessionLoadingState\(\{[\s\S]*selectedSessionId: props\.selectedSessionId,[\s\S]*messageCount: props\.messages\.length,[\s\S]*loadingEarlierMessages: props\.loadingEarlierMessages,[\s\S]*\}\)[\s\S]*\);/,
    "session page should derive inline loading from the selected session fetch state, not from a pre-route pending switch",
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
    appSource,
    /createEffect\(\(\) => \{[\s\S]*if \(!isTauriRuntime\(\)\) return;[\s\S]*if \(!activePendingDraftStorageReady\(\)\) return;[\s\S]*const pendingDraftKey = activePendingDraftKey\(\);[\s\S]*const pendingDraftMetaValue = activePendingDraftMeta\(\);[\s\S]*if \(!pendingDraftKey \|\| !pendingDraftMetaValue\) return;[\s\S]*if \(selectedSessionId\(\)\) return;/s,
    "pending-draft persistence should stop once a real session is selected so a failed send cannot overwrite the pending draft with the real-session composer bucket",
  );
});

test("optimistic first submit replaces the quickstart empty state immediately", () => {
  assert.match(
    sessionSource,
    /const showQuickstartEmptyState = createMemo\(\(\) =>\s*effectiveRenderedMessages\(\)\.length === 0 &&\s*!showWorkspaceSetupEmptyState\(\) &&\s*!showSessionLoadingState\(\),\s*\);/s,
    "quickstart visibility should use rendered messages so an optimistic submitted draft hides the starter templates before backend messages exist",
  );

  assert.match(
    sessionSource,
    /<Show when=\{showQuickstartEmptyState\(\)\}>/,
    "the quickstart starter templates should be controlled by the derived quickstart empty-state memo",
  );

  assert.doesNotMatch(
    sessionSource,
    /<Show when=\{props\.messages\.length === 0 && !showWorkspaceSetupEmptyState\(\) && !showSessionLoadingState\(\)\}>/,
    "quickstart visibility must not depend only on backend props.messages length",
  );
});

test("materializing a pending submitted draft preserves the visible run indicator", () => {
  assert.match(
    sessionSource,
    /const pendingBaseKey = pendingSessionQueueKey\(\);[\s\S]*const pendingKey = !previousSessionId[\s\S]*pendingQueueKeyAwaitingSessionIdByBaseKey\(\)\[pendingBaseKey\] \?\? null[\s\S]*const previousSessionKey = previousSessionId \? sessionQueueKeyForSessionId\(previousSessionId\) : null;[\s\S]*if \(!pendingKey && previousSessionKey\) \{\s*resetRunState\(previousSessionKey\);\s*\}/s,
    "selecting the real session created for a pending submit should remap the optimistic draft without resetting the active run indicator",
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
