import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("sidebar session surfaces expose the loaded-interest prefetch callback", () => {
  const listSource = readFileSync(new URL("../../../components/session/workspace-session-list.tsx", import.meta.url), "utf8");
  const sessionPageSource = readFileSync(new URL("../../../pages/session.tsx", import.meta.url), "utf8");
  const dashboardPageSource = readFileSync(new URL("../../../pages/dashboard.tsx", import.meta.url), "utf8");

  assert.match(
    listSource,
    /onLoadedSessionPrefetchInterestChange\?:\s*(LoadedSessionPrefetchInterestChangeHandler|\(workspaceId: string, interest: LoadedSidebarPrefetchInterest\) => void);/,
  );
  assert.match(listSource, /deriveLoadedSidebarPrefetchInterest\(/);
  assert.match(listSource, /props\.onLoadedSessionPrefetchInterestChange\?\.\(/);
  assert.match(sessionPageSource, /onLoadedSessionPrefetchInterestChange:\s*reportLoadedSessionPrefetchInterest/);
  assert.match(dashboardPageSource, /onLoadedSessionPrefetchInterestChange=\{reportLoadedSessionPrefetchInterest\}/);
  assert.match(sessionPageSource, /prefetchSessionTranscripts\(serverWorkspaceId,\s*interest,\s*\{ appWorkspaceId: workspaceId \}\)/);
  assert.match(dashboardPageSource, /prefetchSessionTranscripts\(serverWorkspaceId,\s*interest,\s*\{ appWorkspaceId: workspaceId \}\)/);
  assert.doesNotMatch(listSource, /onVisibleSessionIdsChange/);
  assert.doesNotMatch(sessionPageSource, /onVisibleSessionIdsChange/);
  assert.doesNotMatch(dashboardPageSource, /onVisibleSessionIdsChange/);
  assert.doesNotMatch(sessionPageSource, /visibleSessionIds/);
  assert.doesNotMatch(dashboardPageSource, /visibleSessionIds/);
  assert.match(sessionPageSource, /parseVesloWorkspaceIdFromUrl\(workspace\.vesloHostUrl \?\? ""\)/);
  assert.match(dashboardPageSource, /parseVesloWorkspaceIdFromUrl\(workspace\.vesloHostUrl \?\? ""\)/);
  assert.doesNotMatch(listSource, /deriveVisibleSessionPrefetchIds\(/);
  assert.doesNotMatch(listSource, /lastReportedVisibleSessionIdsByWorkspace/);
  assert.match(
    listSource,
    /const currentRows = sidebarMode\(\) === "by-project" \? visibleProjectRows\(\) : recentRowsVisible\(\);/,
  );
  assert.match(listSource, /allProjectModeGroups/);
  assert.match(
    listSource,
    /const visibleProjectRows = createMemo<FlatSessionRow\[]>\(\(\) =>\s*allProjectModeGroups\(\)\.flatMap\(\(group\) => visibleProjectRowsForGroup\(group\)\),\s*\);/s,
  );
  assert.match(listSource, /const chatRows = \(\) => visibleProjectRowsForGroup\(chatGroup\(\)\);/);
});
