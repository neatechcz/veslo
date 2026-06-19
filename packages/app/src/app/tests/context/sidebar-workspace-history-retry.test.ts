import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { mergeSidebarSessionItemsByActivity } from "../../context/sidebar-workspace-sessions.js";

const sidebarWorkspaceSessionsSource = readFileSync(
  new URL("../../context/sidebar-workspace-sessions.ts", import.meta.url),
  "utf8",
);

test("active workspace history retries after an empty ready fallback once the engine is ready", () => {
  const activeRefreshEffectMatch = sidebarWorkspaceSessionsSource.match(
    /createEffect\(\(\) => \{\s*const id = options\.workspaceStore\.activeWorkspaceId\(\)\.trim\(\);[\s\S]*?refreshSidebarWorkspaceSessions\(id\)\.catch\(e => options\.reportError\(e, "sidebar\.refreshSessions"\)\);\s*\}\);/,
  );
  assert.ok(activeRefreshEffectMatch, "active workspace refresh effect should exist");
  const activeRefreshEffect = activeRefreshEffectMatch[0];

  assert.match(
    activeRefreshEffect,
    /options\.activeWorkspaceRuntimeReady\(\)/,
    "active workspace sidebar retry should be gated by scoped runtime readiness",
  );
  assert.doesNotMatch(
    activeRefreshEffect,
    /if \(status !== "idle"\) return;/,
    "active workspace refresh must not treat ready+empty fallback state as final once engineReady becomes true",
  );
  assert.match(
    activeRefreshEffect,
    /sidebarSessionsByWorkspaceId\(\)\[id\]/,
    "active workspace refresh should inspect whether ready state actually has sidebar rows before skipping retry",
  );
});

test("sidebar controller does not accept the old global engineReady option", () => {
  assert.match(
    sidebarWorkspaceSessionsSource,
    /activeWorkspaceRuntimeReady: \(\) => boolean;/,
    "sidebar controller should name its readiness dependency as active workspace scoped",
  );
  assert.doesNotMatch(
    sidebarWorkspaceSessionsSource,
    /engineReady: \(\) => boolean;/,
    "sidebar controller must not expose a generic engineReady option that can be wired to the global app signal",
  );
  assert.doesNotMatch(
    sidebarWorkspaceSessionsSource,
    /options\.engineReady\(\)/,
    "sidebar controller must not read the old global-ready option name",
  );
});

test("live sidebar refresh unions OpenCode rows with Veslo read API history", () => {
  const refreshStart = sidebarWorkspaceSessionsSource.indexOf("  const refreshSidebarWorkspaceSessions = async ");
  const refreshEnd = sidebarWorkspaceSessionsSource.indexOf("  const loadMoreWorkspaceSidebarSessions = async ", refreshStart);
  assert.notEqual(refreshStart, -1, "refreshSidebarWorkspaceSessions should exist");
  assert.notEqual(refreshEnd, -1, "refreshSidebarWorkspaceSessions block should end before loadMore");
  const refreshBlock = sidebarWorkspaceSessionsSource.slice(refreshStart, refreshEnd);

  assert.match(
    refreshBlock,
    /const readResult = await listSidebarWorkspaceSessionsFromReadApi\(id, readDirectory\);/,
    "live OpenCode refresh should ask the Veslo read API for owned history",
  );
  assert.match(
    refreshBlock,
    /nextItems = mergeSidebarSessionItemsByActivity\(items, readResult\.items\);/,
    "live OpenCode refresh should merge live rows with DB-backed history",
  );
  assert.match(
    refreshBlock,
    /reason: items\.length === 0 \? "live-empty-union" : "live-union"/,
    "merged live/read refresh should be debuggable by reason",
  );
});

test("merged sidebar history keeps live display fields and DB conversation identifiers", () => {
  const merged = mergeSidebarSessionItemsByActivity(
    [
      {
        id: "sess-shared",
        title: "Live title",
        directory: "/workspace",
        time: { created: 10, updated: 30 },
      },
      {
        id: "sess-live",
        title: "Live only",
        directory: "/workspace",
        time: { created: 5, updated: 20 },
      },
    ],
    [
      {
        id: "sess-db",
        title: "DB only",
        directory: "C:/repo",
        conversationId: "conv-db",
        opencodeSessionId: "sess-db",
        time: { created: 1, updated: 10 },
      },
      {
        id: "sess-shared",
        title: "DB title",
        directory: "C:/repo",
        conversationId: "conv-shared",
        opencodeSessionId: "sess-shared",
        time: { created: 8, updated: 25 },
      },
    ],
  );

  assert.deepEqual(merged.map((item) => item.id), ["sess-shared", "sess-live", "sess-db"]);
  assert.equal(merged[0]?.title, "Live title");
  assert.equal(merged[0]?.conversationId, "conv-shared");
  assert.equal(merged[0]?.opencodeSessionId, "sess-shared");
});
