import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  resolveWorkspaceSessionSnapshotAction,
} from "../../context/workspace-session-snapshots.js";
import { readWorkspaceBehaviorSources } from "./workspace-source";

const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");
const snapshotSource = readFileSync(
  new URL("../../context/workspace-session-snapshots.ts", import.meta.url),
  "utf8",
);
const sessionSource = readFileSync(new URL("../../context/session.ts", import.meta.url), "utf8");
const workspaceSource = readWorkspaceBehaviorSources();
const snapshotWiringStart = appSource.indexOf("createWorkspaceSessionSnapshots({");
const snapshotWiringEnd = appSource.indexOf("  type PendingSkillRegistryReplay", snapshotWiringStart);
const snapshotWiringSource = appSource.slice(snapshotWiringStart, snapshotWiringEnd);

test("switching workspaces saves outgoing and loads incoming when selected session is unscoped", () => {
  assert.deepEqual(
    resolveWorkspaceSessionSnapshotAction({
      previousWorkspaceId: "ws-a",
      activeWorkspaceId: "ws-b",
      selectedScopeWorkspaceId: null,
    }),
    {
      saveWorkspaceId: "ws-a",
      loadWorkspaceId: "ws-b",
      nextPreviousWorkspaceId: "ws-b",
    },
  );
});

test("send-time activation does not overwrite outgoing snapshot with a browsed session from incoming workspace", () => {
  assert.deepEqual(
    resolveWorkspaceSessionSnapshotAction({
      previousWorkspaceId: "ws-a",
      activeWorkspaceId: "ws-b",
      selectedScopeWorkspaceId: "ws-b",
    }),
    {
      saveWorkspaceId: null,
      loadWorkspaceId: null,
      nextPreviousWorkspaceId: "ws-b",
    },
  );
});

test("switching away from the selected session workspace saves it and loads the next workspace", () => {
  assert.deepEqual(
    resolveWorkspaceSessionSnapshotAction({
      previousWorkspaceId: "ws-b",
      activeWorkspaceId: "ws-a",
      selectedScopeWorkspaceId: "ws-b",
    }),
    {
      saveWorkspaceId: "ws-b",
      loadWorkspaceId: "ws-a",
      nextPreviousWorkspaceId: "ws-a",
    },
  );
});

test("initial workspace load only loads the active workspace snapshot", () => {
  assert.deepEqual(
    resolveWorkspaceSessionSnapshotAction({
      previousWorkspaceId: null,
      activeWorkspaceId: "ws-a",
      selectedScopeWorkspaceId: null,
    }),
    {
      saveWorkspaceId: null,
      loadWorkspaceId: "ws-a",
      nextPreviousWorkspaceId: "ws-a",
    },
  );
});

test("selected session scope changes inside the same active workspace do not reload snapshot", () => {
  assert.deepEqual(
    resolveWorkspaceSessionSnapshotAction({
      previousWorkspaceId: "ws-a",
      activeWorkspaceId: "ws-a",
      selectedScopeWorkspaceId: null,
    }),
    {
      saveWorkspaceId: null,
      loadWorkspaceId: null,
      nextPreviousWorkspaceId: "ws-a",
    },
  );

  assert.deepEqual(
    resolveWorkspaceSessionSnapshotAction({
      previousWorkspaceId: "ws-a",
      activeWorkspaceId: "ws-a",
      selectedScopeWorkspaceId: "ws-b",
    }),
    {
      saveWorkspaceId: null,
      loadWorkspaceId: null,
      nextPreviousWorkspaceId: "ws-a",
    },
  );
});

test("workspace switch clears stale selected session when incoming workspace has no snapshot", () => {
  assert.match(
    snapshotSource,
    /const canClear = options\.canClearSelectedSession\?\.\(\{[\s\S]*workspaceId: action\.loadWorkspaceId,[\s\S]*selectedSessionId: selectedId,[\s\S]*\}\) \?\? true;[\s\S]*if \(loaded === false && selectedId && canClear\) \{[\s\S]*options\.clearSelectedSession\?\.\(\);/s,
    "snapshot controller should clear stale selected sessions only when the app-level guard allows it",
  );
  assert.match(
    snapshotWiringSource,
    /createWorkspaceSessionSnapshots\(\{[\s\S]*enabled: \(\) => activeWorkspaceIsHydrated\(\) && !workspaceStore\.connectingWorkspaceId\(\),[\s\S]*canClearSelectedSession: \(\) => activeWorkspaceIsHydrated\(\),[\s\S]*clearSelectedSession: \(\) => \{[\s\S]*wsDebug\("snapshot:clearSelectedSession:app",[\s\S]*setSelectedSessionId\(null\);[\s\S]*debug: wsDebug,/s,
    "app wiring should defer snapshot work during activation and clear selected state without forcing route navigation",
  );
  assert.doesNotMatch(
    snapshotWiringSource,
    /navigate\("\/session"/,
    "snapshot clear must not navigate away from a routed session before the scoped route guard decides",
  );
});

test("workspace snapshot restore does not keep a selected session missing from that workspace", () => {
  assert.match(
    sessionSource,
    /const selectedSessionIdForSnapshot = \(\) => \{[\s\S]*const selectedSessionId = options\.selectedSessionId\(\)\?\.trim\(\) \?\? "";[\s\S]*return store\.sessions\.some\(\(session\) => session\.id === selectedSessionId\) \? selectedSessionId : null;[\s\S]*selectedSessionId: selectedSessionIdForSnapshot\(\),/s,
    "saved workspace snapshots should only persist selections present in that workspace session list",
  );
  assert.match(
    sessionSource,
    /const snapshotSelectedSessionId = snapshot\.selectedSessionId\?\.trim\(\) \?\? "";[\s\S]*snapshot\.sessions\.some\(\(session\) => session\.id === snapshotSelectedSessionId\)[\s\S]*options\.setSelectedSessionId\(selectedSessionId\);[\s\S]*snapshot\.selectedSessionId = selectedSessionId;/s,
    "loading a workspace snapshot should clear stale cross-workspace selections instead of preserving them",
  );
});

test("workspace debug traces include activation caller stack", () => {
  assert.match(
    workspaceSource,
    /\/\* workspace-debug\.ts \*\/[\s\S]*export const workspaceDebugStack = \(\) => \{[\s\S]*new Error\(\)\.stack/s,
    "workspace debug helper should include a trimmed caller stack",
  );
  assert.match(
    workspaceSource,
    /\/\* workspace-activation-controller\.ts \*\/[\s\S]*deps\.wsDebug\("activate:start", \{[\s\S]*stack: deps\.workspaceDebugStack\(\),/s,
    "workspace activation debug logs should include a trimmed caller stack",
  );
});
