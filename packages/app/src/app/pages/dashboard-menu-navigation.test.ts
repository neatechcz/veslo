import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import * as dashboardMenuNavigation from "./dashboard-menu-navigation.js";
import { resolveVisibleSettingsTab } from "../lib/settings-tab-label.js";

const { resolveLeftMenuAction } = dashboardMenuNavigation;
const resolveDashboardTabSelectionAction = (
  dashboardMenuNavigation as {
    resolveDashboardTabSelectionAction?: (input: {
      currentTab: string;
      nextTab: string;
      selectedSessionId: string | null | undefined;
    }) => unknown;
  }
).resolveDashboardTabSelectionAction;

const dashboardSource = readFileSync(new URL("./dashboard.tsx", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("./settings.tsx", import.meta.url), "utf8");
const headerSourceMatch = dashboardSource.match(
  /<header class="h-14 flex items-center justify-between px-6 md:px-10 border-b border-dls-border sticky top-0 bg-dls-surface z-10">[\s\S]*?<\/header>/,
);
const headerSource = headerSourceMatch?.[0] ?? "";
const leftMenuHandlerMatch = dashboardSource.match(
  /const\s+leftMenuAction\s*=\s*createMemo\s*\(\s*\(\)\s*=>\s*resolveLeftMenuAction\s*\(\s*\{[\s\S]*?onToggleRight\s*=\s*\{\s*\(\)\s*=>\s*toggleSidebarMenu\s*\(\s*["']right["']\s*\)\s*\}/s,
);
const leftMenuHandlerSource = leftMenuHandlerMatch?.[0] ?? dashboardSource;
const helperSourcePath = new URL("./dashboard-menu-navigation.ts", import.meta.url);
const helperSource = existsSync(helperSourcePath) ? readFileSync(helperSourcePath, "utf8") : null;
const settingsTabLabelSourcePath = new URL("../lib/settings-tab-label.ts", import.meta.url);
const settingsTabLabelSource = readFileSync(settingsTabLabelSourcePath, "utf8");

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

test("returns to selected session for the remaining dashboard tabs", () => {
  for (const tab of ["soul", "skills", "config", "settings"] as const) {
    const result = resolveLeftMenuAction({
      tab,
      selectedSessionId: "sess-123",
    });

    assert.deepEqual(result, { kind: "return-to-session", sessionId: "sess-123" });
  }
});

test("falls back to sidebar toggle when no session is selected", () => {
  const result = resolveLeftMenuAction({
    tab: "scheduled",
    selectedSessionId: null,
  });

  assert.deepEqual(result, { kind: "toggle-left-sidebar" });
});

test("returns to selected session when re-selecting an active dashboard tab", () => {
  assert.equal(typeof resolveDashboardTabSelectionAction, "function");
  if (typeof resolveDashboardTabSelectionAction !== "function") return;

  const result = resolveDashboardTabSelectionAction({
    currentTab: "skills",
    nextTab: "skills",
    selectedSessionId: "sess-123",
  });

  assert.deepEqual(result, { kind: "return-to-session", sessionId: "sess-123" });
});

test("treats plugins and extensions as the same active destination when re-selected", () => {
  assert.equal(typeof resolveDashboardTabSelectionAction, "function");
  if (typeof resolveDashboardTabSelectionAction !== "function") return;

  const result = resolveDashboardTabSelectionAction({
    currentTab: "plugins",
    nextTab: "mcp",
    selectedSessionId: "sess-123",
  });

  assert.deepEqual(result, { kind: "return-to-session", sessionId: "sess-123" });
});

test("keeps opening dashboard tabs when selecting a different destination", () => {
  assert.equal(typeof resolveDashboardTabSelectionAction, "function");
  if (typeof resolveDashboardTabSelectionAction !== "function") return;

  const result = resolveDashboardTabSelectionAction({
    currentTab: "skills",
    nextTab: "scheduled",
    selectedSessionId: "sess-123",
  });

  assert.deepEqual(result, { kind: "open-dashboard-tab", tab: "scheduled" });
});

test("dashboard routes the left titlebar button through the helper", () => {
  assert.match(leftMenuHandlerSource, /const\s+leftMenuAction\s*=\s*createMemo\s*\(\s*\(\)\s*=>\s*resolveLeftMenuAction\s*\(\s*\{/s);
  assert.match(leftMenuHandlerSource, /const\s+leftMenuLabel\s*=\s*createMemo\s*\(\s*\(\)\s*=>\s*leftMenuAction\(\)\.kind\s*===\s*["']return-to-session["']/s);
  assert.match(leftMenuHandlerSource, /const\s+leftMenuActive\s*=\s*createMemo\s*\(\s*\(\)\s*=>\s*leftMenuAction\(\)\.kind\s*===\s*["']return-to-session["']/s);
  assert.match(leftMenuHandlerSource, /handleLeftMenuToggle/);
  assert.match(leftMenuHandlerSource, /resolveLeftMenuAction\s*\(\s*\{/s);
  assert.match(leftMenuHandlerSource, /tab\s*:\s*props\.tab/);
  assert.match(leftMenuHandlerSource, /selectedSessionId\s*:\s*props\.selectedSessionId/);
  assert.match(leftMenuHandlerSource, /const\s+action\s*=\s*leftMenuAction\(\)\s*;/);
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
  assert.match(dashboardSource, /leftActive=\{leftMenuActive\(\)\}/);
  assert.match(dashboardSource, /leftLabel=\{leftMenuLabel\(\)\}/);
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

test("dashboard source keeps a single left-menu handler without the legacy viewport branch", () => {
  const handlerDeclarations = dashboardSource.match(/const\s+handleLeftMenuToggle\s*=\s*\(\)\s*=>/g) ?? [];

  assert.equal(handlerDeclarations.length, 1);
  assert.doesNotMatch(dashboardSource, /isNarrowViewport\s*:/);
});

test("dashboard routes active nav re-clicks through the session return helper", () => {
  assert.match(
    dashboardSource,
    /const\s+handleDashboardTabSelection\s*=\s*\(\s*nextTab:\s*DashboardTab(?:,\s*nextSettingsTab\?:\s*SettingsTab)?\s*\)\s*=>\s*\{/s,
  );
  assert.match(
    dashboardSource,
    /resolveDashboardTabSelectionAction\s*\(\s*\{\s*currentTab\s*:\s*props\.tab,\s*nextTab,\s*selectedSessionId\s*:\s*props\.selectedSessionId,?\s*\}\s*\)/s,
  );
  assert.match(
    dashboardSource,
    /if\s*\(\s*action\.kind\s*===\s*["']return-to-session["']\s*\)\s*\{\s*props\.setView\s*\(\s*["']session["']\s*,\s*action\.sessionId\s*\)\s*;\s*return\s*;\s*\}/s,
  );
  assert.match(dashboardSource, /props\.setTab\s*\(\s*nextTab\s*\)/);
  assert.match(
    dashboardSource,
    /const\s+openSettings\s*=\s*\(\s*tab:\s*SettingsTab\s*=\s*["']general["']\s*\)\s*=>\s*\{\s*props\.setSettingsTab\s*\(\s*tab\s*\)\s*;\s*props\.setTab\s*\(\s*["']settings["']\s*\)\s*;\s*\}/s,
  );
  assert.doesNotMatch(
    dashboardSource,
    /const\s+openSettings\s*=\s*\(\s*tab:\s*SettingsTab\s*=\s*["']general["']\s*\)\s*=>\s*\{\s*handleDashboardTabSelection\s*\(\s*["']settings["']\s*,\s*tab\s*\)\s*;\s*\}/s,
  );
  assert.match(
    dashboardSource,
    /<SidebarDashboardNav[\s\S]*currentTab=\{props\.tab\}[\s\S]*onSelect=\{handleDashboardTabSelection\}/,
  );
  assert.match(
    dashboardSource,
    /<SidebarAdvancedNav[\s\S]*currentTab=\{props\.tab\}[\s\S]*onSelect=\{\(\)\s*=>\s*handleDashboardTabSelection\(\s*["']config["']\s*\)\}/,
  );
  assert.match(
    dashboardSource,
    /onClick\s*=\s*\{\s*\(\)\s*=>\s*handleDashboardTabSelection\s*\(\s*["']skills["']\s*\)\s*\}/,
  );
  assert.match(
    dashboardSource,
    /onClick\s*=\s*\{\s*\(\)\s*=>\s*handleDashboardTabSelection\s*\(\s*["']scheduled["']\s*\)\s*\}/,
  );
});

test("dashboard header exposes settings and back-to-chat actions", () => {
  assert.match(
    dashboardSource,
    /const\s+headerSettingsLabel\s*=\s*createMemo\s*\(\s*\(\)\s*=>\s*t\("dashboard\.settings", currentLocale\(\)\)\s*\)/,
  );
  assert.match(
    dashboardSource,
    /const\s+headerBackLabel\s*=\s*createMemo\s*\(\s*\(\)\s*=>\s*t\("session\.back", currentLocale\(\)\)\s*\)/,
  );
  assert.match(
    dashboardSource,
    /const\s+returnToSession\s*=\s*\(\)\s*=>\s*\{[\s\S]*props\.setView\(\s*["']session["']\s*,\s*sessionId\s*\)/,
  );
  assert.match(headerSource, /onClick=\{returnToSession\}/);
});

test("dashboard header keeps back-to-chat visible even without a selected session", () => {
  assert.doesNotMatch(headerSource, /<Show when=\{canReturnToSession\(\)\}>/);
  assert.doesNotMatch(
    dashboardSource,
    /const\s+returnToSession\s*=\s*\(\)\s*=>\s*\{\s*const\s+sessionId\s*=\s*props\.selectedSessionId\?\.trim\(\);\s*if\s*\(!sessionId\)\s*return;/s,
  );
});

test("dashboard centers the titlebar on the active settings subsection", () => {
  assert.match(
    dashboardSource,
    /import\s*\{\s*resolveSettingsTabLabel,\s*resolveVisibleSettingsTab\s*\}\s*from\s+["']\.\.\/lib\/settings-tab-label["'];/,
  );
  assert.match(
    dashboardSource,
    /resolveVisibleSettingsTab\(\s*props\.settingsTab,\s*props\.developerMode\s*\)/,
  );
  assert.match(
    dashboardSource,
    /props\.tab\s*===\s*["']settings["']\s*\?\s*resolveSettingsTabLabel\(\s*visibleSettingsTab\(\)\s*\)\s*:\s*title\(\)/,
  );
  assert.match(
    dashboardSource,
    /<TitlebarMenuToggles[\s\S]*centerContent=\{dashboardTitlebarContext\(\)\}/,
  );
  assert.doesNotMatch(dashboardSource, /<TitlebarMenuToggles[\s\S]*centerContent=\{title\(\)\}/);
  assert.match(
    settingsSource,
    /import\s*\{\s*resolveSettingsTabLabel,\s*resolveVisibleSettingsTab\s*\}\s*from\s+["']\.\.\/lib\/settings-tab-label["'];/,
  );
  assert.match(settingsSource, /resolveVisibleSettingsTab\(\s*props\.settingsTab,\s*props\.developerMode\s*\)/);
  assert.match(settingsSource, /{resolveSettingsTabLabel\(tab\)}/);
  assert.doesNotMatch(settingsSource, /tabLabel\(tab\)/);
});

test("dashboard clears the native window title while centered titlebar context is active", () => {
  assert.match(
    dashboardSource,
    /acquireBlankNativeWindowTitleLease/,
    "dashboard should acquire the shared blank native title lease so the shared titlebar context does not overlap with the default product label",
  );

  assert.match(
    dashboardSource,
    /releaseNativeWindowTitleLease\?\.\(\)/,
    "dashboard should release the shared blank native title lease instead of restoring the product name directly",
  );
});

test("settings tab labels include archived and keep debug gated", () => {
  assert.equal(resolveVisibleSettingsTab("archived", false), "archived");
  assert.equal(resolveVisibleSettingsTab("archived", true), "archived");
  assert.equal(resolveVisibleSettingsTab("debug", false), "general");
  assert.equal(resolveVisibleSettingsTab("debug", true), "debug");

  assert.match(settingsTabLabelSource, /archived:\s*"settings\.archived"/);
  assert.match(
    settingsTabLabelSource,
    /const visibleSettingsTabs: SettingsTab\[] = \["general", "archived", "model", "advanced"\]/,
  );

  const enLocale = readFileSync(new URL("../../i18n/locales/en.ts", import.meta.url), "utf8");
  const csLocale = readFileSync(new URL("../../i18n/locales/cs.ts", import.meta.url), "utf8");
  const zhLocale = readFileSync(new URL("../../i18n/locales/zh.ts", import.meta.url), "utf8");

  assert.match(enLocale, /"settings\.archived":\s*"Archived"/);
  assert.match(csLocale, /"settings\.archived":\s*"Archivované"/);
  assert.match(zhLocale, /"settings\.archived":\s*"已归档"/);
});

test("settings tab labels are localized through a shared helper", () => {
  assert.equal(resolveVisibleSettingsTab("debug", false), "general");
  assert.equal(resolveVisibleSettingsTab("debug", true), "debug");
  assert.match(settingsTabLabelSource, /settings\.general/);
  assert.match(settingsTabLabelSource, /settings\.model/);
  assert.match(settingsTabLabelSource, /settings\.advanced/);
  assert.match(settingsTabLabelSource, /settings\.debug/);
  assert.match(settingsTabLabelSource, /return\s+t\(key,\s*currentLocale\(\)\)/);
  assert.doesNotMatch(settingsTabLabelSource, /"General"|"Model"|"Advanced"|"Debug"/);
});
