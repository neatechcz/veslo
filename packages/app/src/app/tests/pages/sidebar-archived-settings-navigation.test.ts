import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dashboardSource = readFileSync(new URL("../../pages/dashboard.tsx", import.meta.url), "utf8");
const sessionSource = readFileSync(new URL("../../pages/session.tsx", import.meta.url), "utf8");

test("dashboard routes archived items to settings archived", () => {
  assert.match(dashboardSource, /onOpenArchivedSessions=\{\(\) => openSettings\("archived"\)\}/);
  assert.doesNotMatch(dashboardSource, /onOpenArchivedSessions=\{\(\) => openSettings\("general"\)\}/);
});

test("session routes archived items to settings archived", () => {
  assert.match(sessionSource, /onOpenArchivedSessions=\{\(\) => openSettings\("archived"\)\}/);
  assert.doesNotMatch(sessionSource, /onOpenArchivedSessions=\{\(\) => openSettings\("general"\)\}/);
});
