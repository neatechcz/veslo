import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionSource = readFileSync(new URL("../../context/session.ts", import.meta.url), "utf8");
const eventStreamSource = readFileSync(new URL("../../context/session-event-stream.ts", import.meta.url), "utf8");
const transcriptControllerSource = readFileSync(
  new URL("../../context/session-transcript-controller.ts", import.meta.url),
  "utf8",
);
const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");

test("background SSE events update scoped runtime state without merging messages into the active store", () => {
  assert.match(
    sessionSource,
    /onSessionBusyChange\?: \(sessionId: string, busy: boolean, workspaceId\?: string\) => void;/,
    "session busy callback should carry the source workspace id",
  );
  assert.match(
    eventStreamSource,
    /const applyBackgroundWorkspaceEvent = \(event: OpencodeEvent, workspaceId: string\) => \{[\s\S]*event\.type === "session\.status"[\s\S]*deps\.setSessionStatusForWorkspace\(sessionID, normalized, workspaceId\);[\s\S]*deps\.notifySessionBusy\(sessionID, normalized, workspaceId\);[\s\S]*event\.type === "session\.idle" \|\| event\.type === "session\.error"[\s\S]*deps\.setSessionStatusForWorkspace\(sessionID, "idle", workspaceId\);[\s\S]*deps\.notifySessionBusy\(sessionID, "idle", workspaceId\);[\s\S]*deps\.scheduleBackgroundTranscriptIngestion\(sessionID, workspaceId, event\.type, 0\);[\s\S]*\};/,
    "background events should update status and durable transcript ingestion for their source workspace",
  );
  assert.match(
    eventStreamSource,
    /if \(activeWsId && sourceWsId !== activeWsId\) \{[\s\S]*applyBackgroundWorkspaceEvent\(event, sourceWsId\);[\s\S]*return;[\s\S]*\}/,
    "background SSE events should branch away before active workspace message mutations",
  );
  assert.match(
    eventStreamSource,
    /if \(event\.type === "message\.part\.updated"\) \{[\s\S]*deps\.scheduleBackgroundTranscriptIngestion\([\s\S]*targetSessionID,[\s\S]*workspaceId,[\s\S]*"background message\.part\.updated"[\s\S]*\);[\s\S]*return;[\s\S]*\}/,
    "background message stream events should feed transcript ingestion instead of the visible message store",
  );
  assert.match(
    transcriptControllerSource,
    /const flushBackgroundTranscriptIngestion = async \([\s\S]*workspaceId: string,[\s\S]*sessionID: string,[\s\S]*const c = deps\.routing\.client\(workspaceId\);[\s\S]*resolveTranscriptIngestDirectory\(workspaceId, sessionID,[\s\S]*c\.session\.messages\(\{ sessionID, limit \}\)[\s\S]*await writer\(\{[\s\S]*workspaceId,[\s\S]*sessionId: sessionID,[\s\S]*messages,[\s\S]*partsByMessageId,/,
    "background transcript ingestion should use the explicit source workspace client for one canonical messages read",
  );
  assert.match(
    eventStreamSource,
    /if \(isPermissionRefreshEvent\(event\.type\)\) \{[\s\S]*void deps\.refreshPendingPermissions\(\);[\s\S]*\}/,
    "background permission events should refresh aggregated permission state",
  );
  assert.match(
    appSource,
    /onSessionBusyChange: \(sessionId, busy, sourceWorkspaceId\) => \{[\s\S]*const wsId = sourceWorkspaceId\?\.trim\(\) \|\| workspaceStore\.activeWorkspaceId\(\)\.trim\(\);[\s\S]*workspaceStore\.markWorkspaceBusy\(wsId, sessionId\);[\s\S]*workspaceStore\.clearWorkspaceBusy\(wsId, sessionId\);[\s\S]*\},/,
    "app should use the SSE source workspace id instead of assuming the active workspace",
  );
});
