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
    // Whitespace-tolerant: this guards the callback's shape, not the
    // formatter's current line-wrapping choice.
    /onSessionBusyChange\?:\s*\(\s*sessionId: string,\s*busy: boolean,\s*workspaceId\?: string,?\s*\) => void;/,
    "session busy callback should carry the source workspace id",
  );
  assert.match(
    eventStreamSource,
    /const applyBackgroundWorkspaceEvent = \(event: OpencodeEvent, workspaceId: string\) => \{[\s\S]*event\.type === "session\.status"[\s\S]*deps\.setSessionStatusForWorkspace\(sessionID, normalized, workspaceId\);[\s\S]*deps\.notifySessionBusy\(sessionID, normalized, workspaceId\);[\s\S]*event\.type === "session\.idle" \|\| event\.type === "session\.error"[\s\S]*deps\.setSessionStatusForWorkspace\(sessionID, "idle", workspaceId\);[\s\S]*deps\.notifySessionBusy\(sessionID, "idle", workspaceId\);[\s\S]*\};/,
    "background events should update status for their source workspace without writing transcript snapshots",
  );
  assert.match(
    eventStreamSource,
    /if \(activeWsId && sourceWsId !== activeWsId\) \{[\s\S]*applyBackgroundWorkspaceEvent\(event, sourceWsId\);[\s\S]*return;[\s\S]*\}/,
    "background SSE events should branch away before active workspace message mutations",
  );
  assert.doesNotMatch(eventStreamSource, /scheduleBackgroundTranscriptIngestion/);
  assert.doesNotMatch(transcriptControllerSource, /flushBackgroundTranscriptIngestion|appendTranscriptSnapshot/);
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
