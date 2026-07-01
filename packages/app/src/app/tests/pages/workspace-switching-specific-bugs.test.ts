import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dashboardSource = readFileSync(new URL("../../pages/dashboard.tsx", import.meta.url), "utf8");
const sessionSource = readFileSync(new URL("../../pages/session.tsx", import.meta.url), "utf8");
const localWorkspacesSource = readFileSync(
  new URL("../../context/workspace-local-workspaces.ts", import.meta.url),
  "utf8",
);

function sourceBetween(source: string, startNeedle: string, endNeedle: string) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `source should contain ${startNeedle}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(end, -1, `source should contain ${endNeedle} after ${startNeedle}`);
  return source.slice(start, end);
}

test("fresh local workspace creation does not mark connected before runtime activation succeeds", () => {
  const createLocalWorkspaceSource = sourceBetween(
    localWorkspacesSource,
    "  async function createLocalWorkspace(",
    "  async function createWorkspaceFlow(",
  );

  assert.doesNotMatch(
    createLocalWorkspaceSource,
    /updateWorkspaceConnectionState\(ws\.activeId,\s*\{\s*status:\s*"connected"/,
    "createLocalWorkspace should not publish a green connection state before activateFreshLocalWorkspace/startHost succeeds",
  );
});

test("failed fresh local workspace activation clears or demotes the provisional connection state", () => {
  const createWorkspaceFlowSource = sourceBetween(
    localWorkspacesSource,
    "  async function createWorkspaceFlow(",
    "  async function createScratchWorkspace(",
  );

  assert.match(
    createWorkspaceFlowSource,
    /if \(!opened\) \{[\s\S]*(updateWorkspaceConnectionState|clearWorkspaceConnectionState|setError)[\s\S]*return;[\s\S]*\}/,
    "createWorkspaceFlow should leave an observable error/non-connected state when fresh activation fails",
  );
});

test("dashboard Soul navigation does not switch tabs after workspace activation fails", () => {
  const openSoulSource = sourceBetween(
    dashboardSource,
    "  const openSoulForWorkspace = (workspaceId?: string) => {",
    "  const revealWorkspaceInFinder",
  );

  assert.match(
    openSoulSource,
    /const activated = await Promise\.resolve\(props\.activateWorkspace\(id,[\s\S]*\)\);[\s\S]*if \(!activated\) return;[\s\S]*props\.setTab\("soul"\);/,
    "dashboard should only open Soul after the requested workspace activation succeeds",
  );
});

test("session Soul navigation does not switch views after workspace activation fails", () => {
  const openSoulSource = sourceBetween(
    sessionSource,
    "  const openSoul = (workspaceId?: string) => {",
    "  const runtimeAvailableWithoutClient = createMemo(() => {",
  );

  assert.match(
    openSoulSource,
    /const activated = await Promise\.resolve\(props\.activateWorkspace\(id,[\s\S]*\)\);[\s\S]*if \(!activated\) return;[\s\S]*props\.setTab\("soul"\);[\s\S]*props\.setView\("dashboard"\);/,
    "session view should only open Soul/dashboard after the requested workspace activation succeeds",
  );
});

test("pending sidebar session rows wait for workspace activation before changing the visible session scope", () => {
  const openSessionFromListSource = sourceBetween(
    sessionSource,
    "  const openSessionFromList = (workspaceId: string, sessionId: string) => {",
    "  const resolveVesloWorkspaceId",
  );

  assert.doesNotMatch(
    openSessionFromListSource,
    /openPendingSidebarSession\(sessionId\);[\s\S]*openSessionWithWorkspaceActivation\(\{[\s\S]*activateWorkspaceBeforeOpen: true/,
    "pending rows should not pre-open a workspace-scoped pending session before activation has succeeded",
  );
});

test("dashboard runtime availability is not inferred from local connected browse state alone", () => {
  const runtimeAvailabilitySource = sourceBetween(
    dashboardSource,
    "  const runtimeAvailableWithoutClient = createMemo(() => {",
    "  const soulNavIconClass",
  );

  assert.doesNotMatch(
    runtimeAvailabilitySource,
    /workspaceConnectionStateById\[props\.activeWorkspaceId\]\?\.status[\s\S]*=== "connected"/,
    "dashboard should not treat the overloaded workspace connection state as runtime availability without a routed client",
  );
});

test("session runtime availability is not inferred from local connected browse state alone", () => {
  const runtimeAvailabilitySource = sourceBetween(
    sessionSource,
    "  const runtimeAvailableWithoutClient = createMemo(() => {",
    "  const leftSidebarUpdatePill = () => (",
  );

  assert.doesNotMatch(
    runtimeAvailabilitySource,
    /workspaceConnectionStateById\[props\.activeWorkspaceId\]\?\.status[\s\S]*=== "connected"/,
    "session view should not treat the overloaded workspace connection state as runtime availability without a routed client",
  );
});
