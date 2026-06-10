import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionSource = readFileSync(new URL("../../context/session.ts", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");

test("background SSE events update only the source workspace busy marker", () => {
  assert.match(
    sessionSource,
    /onSessionBusyChange\?: \(sessionId: string, busy: boolean, workspaceId\?: string\) => void;/,
    "session busy callback should carry the source workspace id",
  );
  assert.match(
    sessionSource,
    /const notifyBackgroundSessionBusy = \(event: OpencodeEvent, workspaceId: string\) => \{[\s\S]*event\.type === "session\.status"[\s\S]*notifySessionBusy\(sessionID, normalizeSessionStatus\(record\.status\), workspaceId\);[\s\S]*event\.type === "session\.idle" \|\| event\.type === "session\.error"[\s\S]*notifySessionBusy\(sessionID, "idle", workspaceId\);[\s\S]*\};/,
    "background events should be reduced to busy/idle updates scoped to their workspace",
  );
  assert.match(
    sessionSource,
    /if \(activeWsId && sourceWsId !== activeWsId\) \{[\s\S]*notifyBackgroundSessionBusy\(event, sourceWsId\);[\s\S]*return;[\s\S]*\}/,
    "background SSE events should not mutate the active session store",
  );
  assert.match(
    appSource,
    /onSessionBusyChange: \(sessionId, busy, sourceWorkspaceId\) => \{[\s\S]*const wsId = sourceWorkspaceId\?\.trim\(\) \|\| workspaceStore\.activeWorkspaceId\(\)\.trim\(\);[\s\S]*workspaceStore\.markWorkspaceBusy\(wsId, sessionId\);[\s\S]*workspaceStore\.clearWorkspaceBusy\(wsId, sessionId\);[\s\S]*\},/,
    "app should use the SSE source workspace id instead of assuming the active workspace",
  );
});
