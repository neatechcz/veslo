import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dashboardSource = readFileSync(new URL("./dashboard.tsx", import.meta.url), "utf8");
const sessionSource = readFileSync(new URL("./session.tsx", import.meta.url), "utf8");

test("dashboard sidebar opens selected sessions without selected-parent subagent expansion", () => {
  assert.match(
    dashboardSource,
    /<WorkspaceSessionList[\s\S]*?allowSelectedParentExpansion=\{false\}[\s\S]*?onOpenSession=\{openSessionFromList\}/,
    "dashboard/settings sidebar should treat selected session clicks as navigation-only",
  );
});

test("session sidebar keeps selected-parent row clicks available for subagent expansion", () => {
  assert.match(
    sessionSource,
    /<WorkspaceSessionList[\s\S]*?allowSelectedParentExpansion=\{true\}[\s\S]*?onOpenSession=\{openSessionFromList\}/,
    "session view sidebar should allow the explicit selected-parent row expansion gesture",
  );
});
