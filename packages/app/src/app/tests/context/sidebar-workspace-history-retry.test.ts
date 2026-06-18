import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
