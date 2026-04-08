import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { deriveVisibleSessionPrefetchIds } from "./workspace-session-list-prefetch.js";

test("deriveVisibleSessionPrefetchIds keeps viewport order and selected session first", () => {
  const result = deriveVisibleSessionPrefetchIds({
    selectedSessionId: "sess-selected",
    visibleSessionIds: ["sess-b", "sess-c", "sess-b"],
  });

  assert.deepEqual(result, ["sess-selected", "sess-b", "sess-c"]);
});

test("sidebar session surfaces expose the visible-session prefetch callback", () => {
  const listSource = readFileSync(new URL("./workspace-session-list.tsx", import.meta.url), "utf8");
  const sessionPageSource = readFileSync(new URL("../../pages/session.tsx", import.meta.url), "utf8");
  const dashboardPageSource = readFileSync(new URL("../../pages/dashboard.tsx", import.meta.url), "utf8");

  assert.match(
    listSource,
    /onVisibleSessionIdsChange\?:\s*(VisibleSessionIdsChangeHandler|\(workspaceId: string, visibleSessionIds: string\[\]\) => void);/,
  );
  assert.match(listSource, /props\.onVisibleSessionIdsChange\?\.\(/);
  assert.match(sessionPageSource, /onVisibleSessionIdsChange=\{/);
  assert.match(dashboardPageSource, /onVisibleSessionIdsChange=\{/);
  assert.match(sessionPageSource, /visibleSessionIds\.length > 0[\s\S]*workspaceId === props\.activeWorkspaceId/);
  assert.match(dashboardPageSource, /visibleSessionIds\.length > 0[\s\S]*workspaceId === props\.activeWorkspaceId/);
  assert.match(sessionPageSource, /parseVesloWorkspaceIdFromUrl\(workspace\.vesloHostUrl \?\? ""\)/);
  assert.match(dashboardPageSource, /parseVesloWorkspaceIdFromUrl\(workspace\.vesloHostUrl \?\? ""\)/);
  assert.match(listSource, /const rawVisibleSessionIds = visibleIdsByWorkspace\.get\(workspaceId\) \?\? \[\];/);
  assert.match(
    listSource,
    /selectedSessionId:\s*rawVisibleSessionIds\.length > 0 && workspaceId === selectedWorkspaceId \?\s*selectedSessionId : null,/,
  );
  assert.match(listSource, /if \(!visibleSessionIds\.length\) \{/);
  assert.match(listSource, /props\.onVisibleSessionIdsChange\?\.\(workspaceId, \[\]\);/);
  assert.match(listSource, /for \(const workspaceId of Array\.from\(lastReportedVisibleSessionIdsByWorkspace\.keys\(\)\)\)/);
});
