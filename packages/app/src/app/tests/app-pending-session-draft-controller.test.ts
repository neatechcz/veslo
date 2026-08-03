import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

test("app shell delegates pending draft orchestration to the pending draft controller", () => {
  const wrapperStart = appSource.indexOf("const openNewSessionWithDirectory = async () => {");
  assert.notStrictEqual(wrapperStart, -1, "app.tsx should expose the new-session handler");

  const wrapperTail = appSource.slice(wrapperStart);
  const wrapperEndMatch = wrapperTail.match(/\r?\n  const \{\r?\n    activePendingDraftKey,/);
  assert.ok(wrapperEndMatch && wrapperEndMatch.index !== undefined, "new-session handler end marker is missing");
  const wrapperEnd = wrapperStart + wrapperEndMatch.index;
  const wrapperSource = appSource.slice(wrapperStart, wrapperEnd);

  assert.match(
    appSource,
    /createPendingSessionDraftController/,
    "app.tsx should construct a focused pending draft controller instead of owning the flow inline",
  );
  assert.match(
    appSource,
    /clearDisplayedSession:\s*\(\) => \{\s*batch\(\(\) => \{\s*setSelectedSessionId\(null\);\s*setMessages\(\[\]\);\s*setTodos\(\[\]\);\s*\}\);\s*\},/s,
    "opening a pending draft should synchronously detach the previously displayed real session before routing",
  );
  assert.match(
    wrapperSource,
    /const opened\s*=\s*await pendingSessionDraftController\.openNewSessionWithDirectory\(\);/,
    "app.tsx should delegate pending draft creation to the controller",
  );
  assert.doesNotMatch(
    appSource,
    /const readActivePendingDraftKey = \(\) => \{/,
    "pending-draft storage helpers should live with the controller",
  );
  assert.doesNotMatch(
    wrapperSource,
    /createScratchWorkspace|pendingSessionDraftsPut|newPrivatePendingDraftKey|setActivePendingDraftKey|setActivePendingDraftMeta/,
    "app.tsx should not re-own pending draft orchestration details",
  );
  assert.doesNotMatch(
    appSource,
    /openNewSessionWithDirectory:\s*pendingSessionDraftController\.openNewSessionWithDirectory/,
    "session props should not bypass the app-shell runtime wrapper",
  );
  assert.match(
    appSource,
    /openNewSessionWithDirectory,/,
    "session props should receive the app-shell new-session handler",
  );
});

