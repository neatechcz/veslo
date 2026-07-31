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
    /const outageEpisodesByWorkspace = new Map<string, ReturnType<typeof clearOutageEpisode>>\(\);/,
    "SSE controller should own outage state across stream replacement generations",
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
    /let outageEpisode = outageEpisodeFor\(streamConnectionKey\);\s*if \(!outageEpisode\.active\) \{\s*outageEpisode = beginOutageEpisode\(deps\.store\.sessionStatus, sourceWsId\);/s,
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
    /setOutageEpisode\(streamConnectionKey, outageEpisode\);/,
    "outage episode should reset after recovery",
  );
});

test("runtime recovery is budgeted once per workspace outage and UI observation is bounded", () => {
  assert.match(
    eventStreamSource,
    /const runtimeRecoveryEpisodesByWorkspace = new Map<string, RuntimeRecoveryEpisode>\(\);/,
    "runtime recovery budget should belong to the controller, not one SSE generation",
  );
  assert.match(
    eventStreamSource,
    /if \(existingEpisode\?\.attemptedFreshRuntimeRecovery\) \{[\s\S]*runtime-route-recovery-budget-exhausted/s,
    "a replacement or reconnect in one outage must not start another fresh runtime",
  );
  assert.match(
    eventStreamSource,
    /const OUTAGE_UI_OBSERVATION_LIMIT_MS = 60_000;/,
    "UI should stop extending the visible reconnect budget indefinitely",
  );
  assert.match(
    eventStreamSource,
    /outage-ui-observation-limit/,
    "the transition to background reconnecting should remain diagnosable",
  );
});
