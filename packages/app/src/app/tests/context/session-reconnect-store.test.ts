import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionFacadeSource = readFileSync(new URL("../../context/session.ts", import.meta.url), "utf8");
const eventStreamSource = readFileSync(new URL("../../context/session-event-stream.ts", import.meta.url), "utf8");

test("session store exposes reconnect notice callback and outage episode tracker", () => {
  assert.match(
    sessionFacadeSource,
    /onReconnectNotice\?: \(notice: ReconnectNotice\) => void;/,
    "createSessionStore should accept a reconnect notice callback",
  );
  assert.match(
    sessionFacadeSource,
    /onReconnectState\?: \(state: ReconnectState\) => void;/,
    "createSessionStore should accept a reconnect state callback",
  );

  assert.match(
    eventStreamSource,
    /let outageEpisode = clearOutageEpisode\(\);/,
    "SSE loop should maintain per-episode outage state",
  );
});

test("selecting a session resumes only recovery work that actually needs foreground help", () => {
  const selectSessionFacade = sessionFacadeSource.match(
    /const selectSession = async \([\s\S]*?return result;\s*\n\s*};/,
  )?.[0];

  assert.ok(selectSessionFacade, "session facade should keep a scoped selectSession wrapper");
  assert.match(
    selectSessionFacade,
    /resumeExhaustedWatchForSession\(/,
    "selection should resume an exhausted watch for the selected session",
  );
  assert.match(
    selectSessionFacade,
    /retryTerminalTranscriptRecoveryForSession\(/,
    "selection should retry an unavailable terminal transcript for the selected session",
  );
  assert.doesNotMatch(
    selectSessionFacade,
    /retryAcceptedRunForSession\(/,
    "selection must not restart a healthy accepted-run watch",
  );
});

test("disconnect scheduling marks outage once and emits reconnecting once", () => {
  assert.match(
    eventStreamSource,
    /if \(!outageEpisode\.active\) \{\s*outageEpisode = beginOutageEpisode\(deps\.store\.sessionStatus, sourceWsId\);/s,
    "first disconnect should snapshot running sessions for the stream workspace",
  );

  assert.match(
    eventStreamSource,
    /if \(shouldShowReconnecting\(outageEpisode\)\) \{\s*deps\.onReconnectNotice\?\.\("reconnecting"\);\s*outageEpisode = \{ \.\.\.outageEpisode, shownReconnecting: true \};/s,
    "reconnecting notice should be emitted once per outage episode",
  );
});

test("recovery catch-up sync is limited to sessions running when outage started", () => {
  assert.match(
    eventStreamSource,
    /const sessionIds = outageEpisode\.runningSessionIds\.slice\(\);/,
    "catch-up should use outage-start running session snapshot",
  );

  assert.match(
    eventStreamSource,
    /await deps\.withTimeout\(c\.session\.messages\(\{ sessionID, limit \}\), 12000, "session\.messages"\)/,
    "catch-up should refresh messages for running outage sessions",
  );

  assert.match(
    eventStreamSource,
    /await deps\.withTimeout\(c\.session\.todo\(\{ sessionID \}\), 8000, "session\.todo"\)/,
    "catch-up should refresh todos for running outage sessions",
  );

  assert.match(
    eventStreamSource,
    /await deps\.withTimeout\(deps\.refreshPendingPermissions\(\), 6000, "permission\.list"\)/,
    "catch-up should refresh pending permissions after reconnect",
  );

  assert.match(
    eventStreamSource,
    /await deps\.withTimeout\(deps\.refreshPendingQuestions\(\), 6000, "question\.list"\)/,
    "catch-up should refresh pending questions after reconnect",
  );

  assert.match(
    eventStreamSource,
    /if \(refreshTranscript && shouldShowReconnected\(outageEpisode\)\) \{\s*deps\.onReconnectNotice\?\.\("reconnected"\);\s*outageEpisode = \{ \.\.\.outageEpisode, shownReconnected: true \};/s,
    "reconnected notice should be emitted once after successful catch-up",
  );

  assert.match(
    eventStreamSource,
    /outageEpisode = clearOutageEpisode\(\);/,
    "outage episode should reset after recovery",
  );
});
