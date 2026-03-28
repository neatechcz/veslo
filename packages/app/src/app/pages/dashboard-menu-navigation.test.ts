import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolveLeftMenuAction } from "./dashboard-menu-navigation.js";

const dashboardSource = readFileSync(new URL("./dashboard.tsx", import.meta.url), "utf8");
const leftMenuHandlerStart = dashboardSource.indexOf("const handleLeftMenuToggle = () => {");
const leftMenuHandlerEnd = dashboardSource.indexOf('onToggleRight={() => toggleSidebarMenu("right")}', leftMenuHandlerStart);
const leftMenuHandlerSource =
  leftMenuHandlerStart >= 0 && leftMenuHandlerEnd >= 0
    ? dashboardSource.slice(leftMenuHandlerStart, leftMenuHandlerEnd)
    : dashboardSource;

test("returns to selected session for automations", () => {
  const result = resolveLeftMenuAction({
    tab: "scheduled",
    selectedSessionId: "sess-123",
  });

  assert.deepEqual(result, { kind: "return-to-session", sessionId: "sess-123" });
});

test("returns to selected session for extensions too", () => {
  const result = resolveLeftMenuAction({
    tab: "mcp",
    selectedSessionId: "sess-123",
  });

  assert.deepEqual(result, { kind: "return-to-session", sessionId: "sess-123" });
});

test("returns to selected session for plugins too", () => {
  const result = resolveLeftMenuAction({
    tab: "plugins",
    selectedSessionId: "sess-123",
  });

  assert.deepEqual(result, { kind: "return-to-session", sessionId: "sess-123" });
});

test("falls back to sidebar toggle when no session is selected", () => {
  const result = resolveLeftMenuAction({
    tab: "scheduled",
    selectedSessionId: null,
  });

  assert.deepEqual(result, { kind: "toggle-left-sidebar" });
});

test("dashboard routes the left titlebar button through the helper", () => {
  assert.ok(leftMenuHandlerSource.includes("handleLeftMenuToggle"));
  assert.ok(leftMenuHandlerSource.includes("resolveLeftMenuAction({"));
  assert.ok(leftMenuHandlerSource.includes("tab: props.tab"));
  assert.ok(leftMenuHandlerSource.includes("selectedSessionId: props.selectedSessionId"));
  assert.ok(leftMenuHandlerSource.includes('props.setView("session", action.sessionId)'));
  assert.match(dashboardSource, /onToggleLeft=\{handleLeftMenuToggle\}/);
  assert.doesNotMatch(dashboardSource, /onToggleLeft=\{\(\) => toggleSidebarMenu\("left"\)\}/);
  assert.doesNotMatch(leftMenuHandlerSource, /matchMedia\("\(max-width: 767px\)"\)/);
});
