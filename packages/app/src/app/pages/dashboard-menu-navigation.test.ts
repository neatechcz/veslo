import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolveLeftMenuAction } from "./dashboard-menu-navigation.js";

const dashboardSource = readFileSync(new URL("./dashboard.tsx", import.meta.url), "utf8");

test("returns to selected session for automations on desktop widths", () => {
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

test("falls back to sidebar toggle when no session is selected", () => {
  const result = resolveLeftMenuAction({
    tab: "scheduled",
    selectedSessionId: null,
  });

  assert.deepEqual(result, { kind: "toggle-left-sidebar" });
});

test("dashboard routes the left titlebar button through the helper", () => {
  assert.match(dashboardSource, /const handleLeftMenuToggle = \(\) => \{/);
  assert.match(dashboardSource, /const action = resolveLeftMenuAction\(\{/);
  assert.match(dashboardSource, /tab: props\.tab/);
  assert.match(dashboardSource, /selectedSessionId: props\.selectedSessionId/);
  assert.match(
    dashboardSource,
    /if \(action\.kind === "return-to-session"\) \{\s*props\.setView\("session", action\.sessionId\);\s*return;\s*\}/,
  );
  assert.match(dashboardSource, /onToggleLeft=\{handleLeftMenuToggle\}/);
  assert.doesNotMatch(dashboardSource, /onToggleLeft=\{\(\) => toggleSidebarMenu\("left"\)\}/);
  assert.match(dashboardSource, /props\.setView\("session", action\.sessionId\)/);
  assert.doesNotMatch(dashboardSource, /matchMedia\("\(max-width: 767px\)"\)/);
});
