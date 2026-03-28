import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { resolveLeftMenuAction } from "./dashboard-menu-navigation.js";

const dashboardSource = readFileSync(new URL("./dashboard.tsx", import.meta.url), "utf8");
const leftMenuHandlerMatch = dashboardSource.match(
  /const\s+handleLeftMenuToggle\s*=\s*\(\)\s*=>\s*\{[\s\S]*?onToggleRight\s*=\s*\{\s*\(\)\s*=>\s*toggleSidebarMenu\s*\(\s*["']right["']\s*\)\s*\}/s,
);
const leftMenuHandlerSource = leftMenuHandlerMatch?.[0] ?? dashboardSource;
const helperSourcePath = new URL("./dashboard-menu-navigation.ts", import.meta.url);
const helperSource = existsSync(helperSourcePath) ? readFileSync(helperSourcePath, "utf8") : null;

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
  assert.match(leftMenuHandlerSource, /handleLeftMenuToggle/);
  assert.match(leftMenuHandlerSource, /resolveLeftMenuAction\s*\(\s*\{/s);
  assert.match(leftMenuHandlerSource, /tab\s*:\s*props\.tab/);
  assert.match(leftMenuHandlerSource, /selectedSessionId\s*:\s*props\.selectedSessionId/);
  assert.match(leftMenuHandlerSource, /props\.setView\s*\(\s*["']session["']\s*,\s*action\.sessionId\s*\)/);
  const returnBranchMatch = leftMenuHandlerSource.match(
    /if\s*\(\s*action\.kind\s*===\s*["']return-to-session["']\s*\)\s*\{[\s\S]*?return\s*;[\s\S]*?\}/s,
  );

  assert.ok(returnBranchMatch);
  assert.match(
    leftMenuHandlerSource.slice((returnBranchMatch.index ?? 0) + returnBranchMatch[0].length),
    /toggleSidebarMenu\s*\(\s*["']left["']\s*\)/,
  );
  assert.match(dashboardSource, /onToggleLeft\s*=\s*\{\s*handleLeftMenuToggle\s*\}/);
  assert.doesNotMatch(dashboardSource, /onToggleLeft\s*=\s*\{\s*\(\)\s*=>\s*toggleSidebarMenu\s*\(\s*["']left["']\s*\)\s*\}/);
  assert.doesNotMatch(leftMenuHandlerSource, /matchMedia\s*\(\s*["']\(max-width:\s*767px\)["']\s*\)/);
});

test("helper source avoids viewport-specific left-menu logic when it exists", () => {
  if (helperSource === null) {
    assert.equal(helperSource, null);
    return;
  }

  assert.doesNotMatch(helperSource, /matchMedia\s*\(\s*["']\(max-width:\s*767px\)["']\s*\)/);
});
