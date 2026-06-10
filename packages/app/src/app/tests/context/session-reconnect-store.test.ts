import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../context/session.ts", import.meta.url), "utf8");

test("session store exposes reconnect notice callback and outage episode tracker", () => {
  assert.match(
    source,
    /onReconnectNotice\?: \(notice: ReconnectNotice\) => void;/,
    "createSessionStore should accept a reconnect notice callback",
  );

  assert.match(
    source,
    /let outageEpisode = clearOutageEpisode\(\);/,
    "SSE loop should maintain per-episode outage state",
  );
});

test("disconnect scheduling marks outage once and emits reconnecting once", () => {
  assert.match(
    source,
    /if \(!outageEpisode\.active\) \{\s*outageEpisode = beginOutageEpisode\(store\.sessionStatus\);/s,
    "first disconnect should snapshot running sessions from full sessionStatus map",
  );

  assert.match(
    source,
    /if \(shouldShowReconnecting\(outageEpisode\)\) \{\s*options\.onReconnectNotice\?\.\("reconnecting"\);\s*outageEpisode = \{ \.\.\.outageEpisode, shownReconnecting: true \};/s,
    "reconnecting notice should be emitted once per outage episode",
  );
});

test("recovery catch-up sync is limited to sessions running when outage started", () => {
  assert.match(
    source,
    /const sessionIds = outageEpisode\.runningSessionIds\.slice\(\);/,
    "catch-up should use outage-start running session snapshot",
  );

  assert.match(
    source,
    /await withTimeout\(c\.session\.messages\(\{ sessionID, limit \}\), 12000, "session\.messages"\)/,
    "catch-up should refresh messages for running outage sessions",
  );

  assert.match(
    source,
    /await withTimeout\(c\.session\.todo\(\{ sessionID \}\), 8000, "session\.todo"\)/,
    "catch-up should refresh todos for running outage sessions",
  );

  assert.match(
    source,
    /await withTimeout\(refreshPendingPermissions\(\), 6000, "permission\.list"\)/,
    "catch-up should refresh pending permissions after reconnect",
  );

  assert.match(
    source,
    /await withTimeout\(refreshPendingQuestions\(\), 6000, "question\.list"\)/,
    "catch-up should refresh pending questions after reconnect",
  );

  assert.match(
    source,
    /if \(shouldShowReconnected\(outageEpisode\)\) \{\s*options\.onReconnectNotice\?\.\("reconnected"\);\s*outageEpisode = \{ \.\.\.outageEpisode, shownReconnected: true \};/s,
    "reconnected notice should be emitted once after successful catch-up",
  );

  assert.match(
    source,
    /outageEpisode = clearOutageEpisode\(\);/,
    "outage episode should reset after recovery",
  );
});
