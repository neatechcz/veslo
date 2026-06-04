import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const sessionSource = readFileSync(new URL("./session.tsx", import.meta.url), "utf8");

test("session loading moves from fullscreen app overlay into the center pane", () => {
  assert.ok(
    sessionSource.includes(
      "pendingSessionLoad: { sessionId: string; workspaceId: string; sessionTitle: string; workspaceName: string } | null;",
    ),
    "session view props should receive the pending session load metadata",
  );

  assert.match(
    sessionSource,
    /const showSessionLoadingState = createMemo\(\(\) =>[\s\S]*shouldShowSessionLoadingState\(\{[\s\S]*hasPendingSessionLoad: Boolean\(props\.pendingSessionLoad\),[\s\S]*selectedSessionId: props\.selectedSessionId,[\s\S]*messageCount: props\.messages\.length,[\s\S]*loadingEarlierMessages: props\.loadingEarlierMessages,[\s\S]*\}\)[\s\S]*\);/,
    "session page should derive an inline loading state from pending switch metadata or the active message fetch",
  );

  assert.match(
    sessionSource,
    /<Show when=\{showSessionLoadingState\(\)\}>/,
    "session page should render a dedicated inline loading state in the center pane",
  );

  assert.match(
    appSource,
    /const workspaceSwitchOpen = createMemo\(\(\) => \{[\s\S]*if \(pendingSessionLoad\(\)\) return false;/,
    "workspace switch overlay should stay closed while a sidebar session switch is already rendering inline loading",
  );

  assert.doesNotMatch(
    appSource,
    /<Show when=\{pendingSessionLoad\(\)\}>/,
    "app shell should not render a separate fullscreen session loading overlay anymore",
  );
});

test("session switch keeps inline loading until transcript hydration completes", () => {
  const openSessionStart = sessionSource.indexOf("  const openSessionFromList = (workspaceId: string, sessionId: string) => {");
  const openSessionEnd = sessionSource.indexOf("  const resolveVesloWorkspaceId = (workspaceId: string) => {", openSessionStart);
  assert.notEqual(openSessionStart, -1, "openSessionFromList should exist");
  assert.notEqual(openSessionEnd, -1, "openSessionFromList block end should exist");
  const openSessionSource = sessionSource.slice(openSessionStart, openSessionEnd);

  assert.match(
    openSessionSource,
    /if \(result === "blocked" \|\| result === "superseded"\) \{\s*props\.setPendingSessionLoad\(null\);\s*\}/s,
    "session click navigation should only clear the inline loading state for terminal non-open results",
  );
  assert.doesNotMatch(
    openSessionSource,
    /result === "opened"[\s\S]*props\.setPendingSessionLoad\(null\)/s,
    "opened navigation must keep pendingSessionLoad alive until onSessionLoadComplete fires after transcript hydration",
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
    /const pendingKey = !previousSessionId \? pendingQueueKeyAwaitingSessionId\(\) : null;[\s\S]*if \(!pendingKey\) \{\s*resetRunState\(\);\s*\}/s,
    "selecting the real session created for a pending submit should remap the optimistic draft without resetting the active run indicator",
  );
});

test("optimistic submitted drafts show the responding label before assistant parts arrive", () => {
  assert.match(
    sessionSource,
    /if \(status === "idle"\) \{\s*if \(!started\) return "idle";\s*if \(optimisticSubmittedDraft\(\)\) return "responding";/s,
    "a first optimistic submit should read as Responding/Odpovídám, not as a workspace-loading or thinking-only state",
  );
});

test("optimistic responding state renders as an assistant message instead of footer text", () => {
  assert.match(
    sessionSource,
    /pendingSubmittedDraftToAssistantPlaceholderMessage/,
    "session view should use a synthetic assistant placeholder while a pending submit is waiting for backend assistant output",
  );

  assert.match(
    sessionSource,
    /const optimisticAssistantRespondingMessage = createMemo<MessageWithParts \| null>\(\(\) => \{[\s\S]*if \(responseStarted\(\)\) return null;[\s\S]*return pendingSubmittedDraftToAssistantPlaceholderMessage\(/s,
    "the placeholder should disappear as soon as the real backend assistant response starts",
  );

  assert.match(
    sessionSource,
    /const sourceMessages = optimisticAssistantMessage\s*\?\s*\[\.\.\.messagesWithOptimisticUser, optimisticAssistantMessage\]\s*:\s*messagesWithOptimisticUser;/,
    "rendered messages should append the responding assistant placeholder after the optimistic user message",
  );

  assert.match(
    sessionSource,
    /const showFooterRunIndicator = createMemo\(\(\) => showRunIndicator\(\) && !optimisticAssistantRespondingMessage\(\)\);[\s\S]*footer=\{\s*showFooterRunIndicator\(\) \?/s,
    "the footer run indicator should be suppressed while the responding placeholder is rendered as an assistant message",
  );
});
