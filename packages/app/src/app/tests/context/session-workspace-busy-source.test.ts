import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionSource = readFileSync(new URL("../../context/session.ts", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");

test("background SSE events update scoped runtime state without merging messages into the active store", () => {
  assert.match(
    sessionSource,
    /onSessionBusyChange\?: \(sessionId: string, busy: boolean, workspaceId\?: string\) => void;/,
    "session busy callback should carry the source workspace id",
  );
  assert.match(
    sessionSource,
    /const applyBackgroundWorkspaceEvent = \(event: OpencodeEvent, workspaceId: string\) => \{[\s\S]*event\.type === "session\.status"[\s\S]*setSessionStatusForWorkspace\(sessionID, normalized, workspaceId\);[\s\S]*notifySessionBusy\(sessionID, normalized, workspaceId\);[\s\S]*event\.type === "session\.idle" \|\| event\.type === "session\.error"[\s\S]*setSessionStatusForWorkspace\(sessionID, "idle", workspaceId\);[\s\S]*notifySessionBusy\(sessionID, "idle", workspaceId\);[\s\S]*scheduleBackgroundTranscriptIngestion\(sessionID, workspaceId, event\.type, 0\);[\s\S]*\};/,
    "background events should update status and durable transcript ingestion for their source workspace",
  );
  assert.match(
    sessionSource,
    /if \(activeWsId && sourceWsId !== activeWsId\) \{[\s\S]*applyBackgroundWorkspaceEvent\(event, sourceWsId\);[\s\S]*return;[\s\S]*\}/,
    "background SSE events should branch away before active workspace message mutations",
  );
  assert.match(
    sessionSource,
    /if \(event\.type === "message\.part\.updated"\) \{[\s\S]*scheduleBackgroundTranscriptIngestion\(targetSessionID, workspaceId, "background message\.part\.updated"\);[\s\S]*return;[\s\S]*\}/,
    "background message stream events should feed transcript ingestion instead of the visible message store",
  );
  assert.match(
    sessionSource,
    /const flushBackgroundTranscriptIngestion = async \([\s\S]*workspaceId: string,[\s\S]*sessionID: string,[\s\S]*const c = options\.routing\.client\(workspaceId\);[\s\S]*c\.session\.get\(\{ sessionID \}\)[\s\S]*c\.session\.messages\(\{ sessionID, limit \}\)[\s\S]*await writer\(\{[\s\S]*workspaceId,[\s\S]*sessionId: sessionID,[\s\S]*messages,[\s\S]*partsByMessageId,/,
    "background transcript ingestion should read from the explicit source workspace client and persist that transcript",
  );
  assert.match(
    sessionSource,
    /if \(event\.type === "permission\.asked" \|\| event\.type === "permission\.replied"\) \{[\s\S]*void refreshPendingPermissions\(\);[\s\S]*\}/,
    "background permission events should refresh aggregated permission state",
  );
  assert.match(
    sessionSource,
    /const c = sourceWsId\s*\?\s*options\.routing\.client\(sourceWsId\) \?\? options\.client\(\)\s*:\s*options\.client\(\);/,
    "session idle refreshes should use the source workspace client before falling back to the active client",
  );
  assert.match(
    appSource,
    /onSessionBusyChange: \(sessionId, busy, sourceWorkspaceId\) => \{[\s\S]*const wsId = sourceWorkspaceId\?\.trim\(\) \|\| workspaceStore\.activeWorkspaceId\(\)\.trim\(\);[\s\S]*workspaceStore\.markWorkspaceBusy\(wsId, sessionId\);[\s\S]*workspaceStore\.clearWorkspaceBusy\(wsId, sessionId\);[\s\S]*\},/,
    "app should use the SSE source workspace id instead of assuming the active workspace",
  );
});
