import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionSource = readFileSync(new URL("./session.tsx", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("./dashboard.tsx", import.meta.url), "utf8");

test("session view props expose the directory-picked session callback", () => {
  assert.match(
    sessionSource,
    /openDirectorySessionFromPicker: \(\) => void;/,
    "SessionViewProps should expose the picker-driven directory session callback",
  );
});

test("dashboard view props expose the directory-picked session callback", () => {
  assert.match(
    dashboardSource,
    /openDirectorySessionFromPicker: \(\) => void;/,
    "DashboardViewProps should expose the picker-driven directory session callback",
  );
});

test("session wires the directory-picked session callback into WorkspaceSessionList", () => {
  assert.match(
    sessionSource,
    /onAddDirectorySession=\{props\.openDirectorySessionFromPicker\}/,
    "Session should pass the picker-driven callback into WorkspaceSessionList",
  );
});

test("dashboard wires the directory-picked session callback into WorkspaceSessionList", () => {
  assert.match(
    dashboardSource,
    /onAddDirectorySession=\{props\.openDirectorySessionFromPicker\}/,
    "Dashboard should pass the picker-driven callback into WorkspaceSessionList",
  );
});
