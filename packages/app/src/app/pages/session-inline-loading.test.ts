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
