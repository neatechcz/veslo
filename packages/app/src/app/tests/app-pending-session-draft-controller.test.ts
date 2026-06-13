import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

test("app shell delegates pending draft orchestration to the pending draft controller", () => {
  assert.match(
    appSource,
    /createPendingSessionDraftController/,
    "app.tsx should construct a focused pending draft controller instead of owning the flow inline",
  );
  assert.doesNotMatch(
    appSource,
    /const openNewSessionWithDirectory = async \(\) => \{/,
    "new private pending-draft creation should not remain as an inline app.tsx function",
  );
  assert.doesNotMatch(
    appSource,
    /const readActivePendingDraftKey = \(\) => \{/,
    "pending-draft storage helpers should live with the controller",
  );
  assert.match(
    appSource,
    /openNewSessionWithDirectory: pendingSessionDraftController\.openNewSessionWithDirectory/,
    "session props should receive the controller-owned new-session handler",
  );
});

