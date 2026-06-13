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
const workspaceSource = readWorkspaceBehaviorSources();

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
    /const loaded = options\.loadWorkspaceSnapshot\(action\.loadWorkspaceId\);[\s\S]*options\.debug\?\.\("snapshot:load",[\s\S]*if \(loaded === false && selectedId\) \{[\s\S]*options\.debug\?\.\("snapshot:clear-stale-selected-session",[\s\S]*options\.clearSelectedSession\?\.\(\);/s,
    "snapshot controller should clear stale selected sessions when the incoming workspace has no cached snapshot",
  );
  assert.match(
    appSource,
    /clearSelectedSession: \(\) => \{[\s\S]*wsDebug\("snapshot:clearSelectedSession:app",[\s\S]*setSelectedSessionId\(null\);[\s\S]*if \(location\.pathname\.toLowerCase\(\)\.startsWith\("\/session\/"\)\) \{[\s\S]*navigate\("\/session", \{ replace: true \}\);[\s\S]*debug: wsDebug,/s,
    "app wiring should log and clear the stale session route when a workspace switch cannot restore an incoming snapshot",
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
    /wsDebug\("activate:start", \{[\s\S]*stack: workspaceDebugStack\(\),/s,
    "workspace activation debug logs should include a trimmed caller stack",
  );
});
