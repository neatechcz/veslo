import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import * as dashboardMenuNavigation from "../../pages/dashboard-menu-navigation.js";
import { resolveVisibleSettingsTab } from "../../lib/settings-tab-label.js";

const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");
const appViewPropsSource = readFileSync(new URL("../../app-view-props.ts", import.meta.url), "utf8");
const workspaceSessionSelectionSource = readFileSync(
  new URL("../../context/workspace-session-selection.ts", import.meta.url),
  "utf8",
);
const { resolveLeftMenuAction } = dashboardMenuNavigation;
const resolveDashboardTabSelectionAction = (
  dashboardMenuNavigation as {
    resolveDashboardTabSelectionAction?: (input: {
      currentTab: string;
      nextTab: string;
      selectedSessionId: string | null | undefined;
      lastWorkspaceSessionId?: string | null | undefined;
    }) => unknown;
  }
).resolveDashboardTabSelectionAction;
const shouldReturnToSessionOnEscape = (
  dashboardMenuNavigation as {
    shouldReturnToSessionOnEscape?: (input: {
      key: string;
      defaultPrevented: boolean;
      metaKey: boolean;
      ctrlKey: boolean;
      altKey: boolean;
      shiftKey: boolean;
      modalOpen: boolean;
      targetTagName: string | null;
      targetIsContentEditable: boolean;
    }) => boolean;
  }
).shouldReturnToSessionOnEscape;

const dashboardSource = readFileSync(new URL("../../pages/dashboard.tsx", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("../../pages/settings.tsx", import.meta.url), "utf8");
const settingsViewSource = dashboardSource.match(/<SettingsView[\s\S]*?\/>/)?.[0] ?? "";
const settingsViewDashboardCallbackSource =
  settingsViewSource.match(/onOpenDashboardTab=\{([\s\S]*?)\}/)?.[1] ?? "";
const headerSourceMatch = dashboardSource.match(
  /<header class="h-14 flex items-center justify-between px-6 md:px-10 border-b border-dls-border sticky top-0 bg-dls-surface z-10">[\s\S]*?<\/header>/,
);
const headerSource = headerSourceMatch?.[0] ?? "";
const leftMenuHandlerMatch = dashboardSource.match(
  /const\s+leftMenuAction\s*=\s*createMemo\s*\(\s*\(\)\s*=>\s*resolveLeftMenuAction\s*\(\s*\{[\s\S]*?onToggleRight\s*=\s*\{\s*\(\)\s*=>\s*toggleSidebarMenu\s*\(\s*["']right["']\s*\)\s*\}/s,
);
const leftMenuHandlerSource = leftMenuHandlerMatch?.[0] ?? dashboardSource;
const helperSourcePath = new URL("../../pages/dashboard-menu-navigation.ts", import.meta.url);
const helperSource = existsSync(helperSourcePath) ? readFileSync(helperSourcePath, "utf8") : null;
const settingsTabLabelSourcePath = new URL("../../lib/settings-tab-label.ts", import.meta.url);
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

test("returns to empty session when no selected or last session is available", () => {
  const result = resolveLeftMenuAction({
    tab: "scheduled",
    selectedSessionId: null,
  });

  assert.deepEqual(result, { kind: "return-to-session" });
});

test("returns to the active workspace's last session when no session is currently selected", () => {
  const result = resolveLeftMenuAction({
    tab: "scheduled",
    selectedSessionId: null,
    lastWorkspaceSessionId: "sess-last",
  });

  assert.deepEqual(result, { kind: "return-to-session", sessionId: "sess-last" });
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

test("returns to the active workspace's last session when re-selecting an active dashboard tab without selected session", () => {
  assert.equal(typeof resolveDashboardTabSelectionAction, "function");
  if (typeof resolveDashboardTabSelectionAction !== "function") return;

  const result = resolveDashboardTabSelectionAction({
    currentTab: "settings",
    nextTab: "settings",
    selectedSessionId: null,
    lastWorkspaceSessionId: "sess-last",
  });

  assert.deepEqual(result, { kind: "return-to-session", sessionId: "sess-last" });
});

test("returns to empty session when re-selecting an active dashboard tab without any session", () => {
  assert.equal(typeof resolveDashboardTabSelectionAction, "function");
  if (typeof resolveDashboardTabSelectionAction !== "function") return;

  const result = resolveDashboardTabSelectionAction({
    currentTab: "settings",
    nextTab: "settings",
    selectedSessionId: null,
    lastWorkspaceSessionId: null,
  });

  assert.deepEqual(result, { kind: "return-to-session" });
});

test("opens MCP when selecting MCP from the plugins dashboard tab", () => {
  assert.equal(typeof resolveDashboardTabSelectionAction, "function");
  if (typeof resolveDashboardTabSelectionAction !== "function") return;

  const result = resolveDashboardTabSelectionAction({
    currentTab: "plugins",
    nextTab: "mcp",
    selectedSessionId: "sess-123",
  });

  assert.deepEqual(result, { kind: "open-dashboard-tab", tab: "mcp" });
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

test("dashboard escape returns to session when no modal or modifier blocks it", () => {
  assert.equal(typeof shouldReturnToSessionOnEscape, "function");
  if (typeof shouldReturnToSessionOnEscape !== "function") return;

  const result = shouldReturnToSessionOnEscape({
    key: "Escape",
    defaultPrevented: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    modalOpen: false,
    targetTagName: null,
    targetIsContentEditable: false,
  });

  assert.equal(result, true);
});

test("dashboard escape stays inactive when the event is already handled, modified, or blocked by a modal", () => {
  assert.equal(typeof shouldReturnToSessionOnEscape, "function");
  if (typeof shouldReturnToSessionOnEscape !== "function") return;

  const cases = [
    { key: "Enter", defaultPrevented: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, modalOpen: false, targetTagName: null, targetIsContentEditable: false },
    { key: "Escape", defaultPrevented: true, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, modalOpen: false, targetTagName: null, targetIsContentEditable: false },
    { key: "Escape", defaultPrevented: false, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, modalOpen: false, targetTagName: null, targetIsContentEditable: false },
    { key: "Escape", defaultPrevented: false, metaKey: false, ctrlKey: true, altKey: false, shiftKey: false, modalOpen: false, targetTagName: null, targetIsContentEditable: false },
    { key: "Escape", defaultPrevented: false, metaKey: false, ctrlKey: false, altKey: true, shiftKey: false, modalOpen: false, targetTagName: null, targetIsContentEditable: false },
    { key: "Escape", defaultPrevented: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: true, modalOpen: false, targetTagName: null, targetIsContentEditable: false },
    { key: "Escape", defaultPrevented: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, modalOpen: true, targetTagName: null, targetIsContentEditable: false },
  ];

  for (const input of cases) {
    assert.equal(shouldReturnToSessionOnEscape(input), false);
  }
});

test("dashboard escape stays inactive when typing inside editable controls", () => {
  assert.equal(typeof shouldReturnToSessionOnEscape, "function");
  if (typeof shouldReturnToSessionOnEscape !== "function") return;

  const cases = [
    { targetTagName: "INPUT", targetIsContentEditable: false },
    { targetTagName: "TEXTAREA", targetIsContentEditable: false },
    { targetTagName: "SELECT", targetIsContentEditable: false },
    { targetTagName: "DIV", targetIsContentEditable: true },
  ];

  for (const editableTarget of cases) {
    assert.equal(shouldReturnToSessionOnEscape({
      key: "Escape",
      defaultPrevented: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      modalOpen: false,
      ...editableTarget,
    }), false);
  }
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

test("dashboard passes the active workspace last session fallback into the left menu helper", () => {
  assert.match(
    dashboardSource,
    /lastWorkspaceSessionId: string \| null;/,
    "DashboardViewProps should receive the active workspace last session fallback",
  );
  assert.match(
    leftMenuHandlerSource,
    /lastWorkspaceSessionId\s*:\s*props\.lastWorkspaceSessionId/,
    "left menu action should receive the fallback last session id",
  );
});

test("app derives the active workspace last session and passes it into DashboardView props", () => {
  assert.match(
    workspaceSessionSelectionSource,
    /const activeWorkspaceLastSessionId = \(\) => \{[\s\S]*const stored = readSessionByWorkspace\(\)\[workspaceId\]\?\.trim\(\) \?\? "";/,
    "workspace session selection should derive the fallback from the active workspace's persisted last-session map",
  );
  assert.match(
    appSource,
    /const currentWorkspaceStoreRef = \(\) => lateWorkspaceStore\.current\(\);[\s\S]*const workspaceSessionSelection = createWorkspaceSessionSelection\(\{[\s\S]*activeWorkspaceId: \(\) => currentWorkspaceStoreRef\(\)\?\.activeWorkspaceId\(\) \?\? "",[\s\S]*\}\);[\s\S]*lateWorkspaceStore\.bind\(workspaceStore\);/,
    "app should wire active workspace last-session fallback through the workspace session selection controller",
  );
  assert.match(
    appViewPropsSource,
    /lastWorkspaceSessionId:\s*activeWorkspaceLastSessionId\(\)/,
    "dashboard props should include the active workspace last session fallback",
  );
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
  assert.match(dashboardSource, /import DashboardTabRail/);
  assert.match(
    dashboardSource,
    /const\s+handleDashboardTabSelection\s*=\s*\(\s*nextTab:\s*DashboardTab(?:,\s*nextSettingsTab\?:\s*SettingsTab)?\s*\)\s*=>\s*\{/s,
  );
  assert.match(
    dashboardSource,
    /resolveDashboardTabSelectionAction\s*\(\s*\{\s*currentTab\s*:\s*props\.tab,\s*nextTab,\s*selectedSessionId\s*:\s*props\.selectedSessionId,\s*lastWorkspaceSessionId\s*:\s*props\.lastWorkspaceSessionId,?\s*\}\s*\)/s,
  );
  assert.match(
    dashboardSource,
    /if\s*\(\s*action\.kind\s*===\s*["']return-to-session["']\s*\)\s*\{\s*props\.setView\s*\(\s*["']session["']\s*,\s*action\.sessionId\s*\)\s*;\s*return\s*;\s*\}/s,
  );
  assert.match(dashboardSource, /props\.setTab\s*\(\s*nextTab\s*\)/);
  assert.match(
    dashboardSource,
    /const\s+handleSettingsButtonClick\s*=\s*\(\)\s*=>\s*\{\s*handleDashboardTabSelection\s*\(\s*["']settings["']\s*,\s*["']general["']\s*\)\s*;\s*\}/s,
  );
  assert.match(
    dashboardSource,
    /onOpenSettings=\{handleSettingsButtonClick\}/,
  );
  assert.match(headerSource, /onClick=\{handleSettingsButtonClick\}/);
  assert.match(
    dashboardSource,
    /<SidebarDashboardNav[\s\S]*currentTab=\{props\.tab\}[\s\S]*onSelect=\{handleDashboardTabSelection\}/,
  );
  assert.match(
    dashboardSource,
    /<SidebarAdvancedNav[\s\S]*currentTab=\{props\.tab\}[\s\S]*onSelect=\{\(\)\s*=>\s*handleDashboardTabSelection\(\s*["']config["']\s*\)\}/,
  );
  assert.match(
    settingsViewDashboardCallbackSource,
    /^(?:\s*handleDashboardTabSelection\s*|\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>\s*handleDashboardTabSelection\(\s*\1\s*\)\s*)$/,
  );
  assert.match(
    dashboardSource,
    /onClick\s*=\s*\{\s*\(\)\s*=>\s*handleDashboardTabSelection\s*\(\s*["']skills["']\s*\)\s*\}/,
  );
  assert.doesNotMatch(
    dashboardSource,
    /onClick\s*=\s*\{\s*\(\)\s*=>\s*handleDashboardTabSelection\s*\(\s*["']scheduled["']\s*\)\s*\}/,
  );
  assert.match(dashboardSource, /const\s+showDashboardTabRail\s*=\s*createMemo\s*\(\s*\(\)\s*=>/);
  assert.match(
    dashboardSource,
    /<Show when=\{showDashboardTabRail\(\)\}>[\s\S]*<DashboardTabRail[\s\S]*activeDashboardTab=\{props\.tab\}[\s\S]*activeSettingsTab=\{props\.settingsTab\}[\s\S]*onOpenSettingsTab=\{openSettings\}[\s\S]*onOpenDashboardTab=\{handleDashboardTabSelection\}[\s\S]*<\/Show>[\s\S]*<Switch>/,
  );
});

test("dashboard wires escape to the same return-to-session action as the header back button", () => {
  assert.match(
    dashboardSource,
    /import\s*\{[^}]*shouldReturnToSessionOnEscape[^}]*\}\s*from\s*["']\.\/dashboard-menu-navigation["'];/,
  );
  assert.match(
    dashboardSource,
    /createEffect\(\(\)\s*=>\s*\{\s*if\s*\(\s*typeof window === ["']undefined["']\s*\)\s*return;\s*const onKeyDown = \(event: KeyboardEvent\) => \{/s,
  );
  assert.match(dashboardSource, /const target = event\.target instanceof Element \? event\.target : null;/);
  assert.match(
    dashboardSource,
    /shouldReturnToSessionOnEscape\(\s*\{\s*key:\s*event\.key,\s*defaultPrevented:\s*event\.defaultPrevented,\s*metaKey:\s*event\.metaKey,\s*ctrlKey:\s*event\.ctrlKey,\s*altKey:\s*event\.altKey,\s*shiftKey:\s*event\.shiftKey,\s*modalOpen:\s*Boolean\(window\.document\.querySelector\(\s*["']\.fixed\.inset-0\.z-50["']\s*\)\),\s*targetTagName:\s*target\?\.tagName\s*\?\?\s*null,\s*targetIsContentEditable:\s*target\s+instanceof\s+HTMLElement\s*\?\s*target\.isContentEditable\s*:\s*false,\s*\}\s*\)/s,
  );
  assert.match(
    dashboardSource,
    /event\.preventDefault\(\);\s*returnToSession\(\);/s,
  );
  assert.match(
    dashboardSource,
    /window\.addEventListener\(\s*["']keydown["']\s*,\s*onKeyDown\s*\);/s,
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

test("dashboard header back uses the active workspace last-session fallback", () => {
  assert.match(
    dashboardSource,
    /const\s+returnToSession\s*=\s*\(\)\s*=>\s*\{\s*const\s+sessionId\s*=\s*props\.selectedSessionId\?\.trim\(\)\s*\|\|\s*props\.lastWorkspaceSessionId\?\.trim\(\);[\s\S]*props\.setView\(\s*["']session["']\s*,\s*sessionId\s*\)/,
  );
});

test("dashboard header keeps back-to-chat visible even without a selected session", () => {
  assert.doesNotMatch(headerSource, /<Show when=\{canReturnToSession\(\)\}>/);
  assert.doesNotMatch(
    dashboardSource,
    /const\s+returnToSession\s*=\s*\(\)\s*=>\s*\{\s*const\s+sessionId\s*=\s*props\.selectedSessionId\?\.trim\(\);\s*if\s*\(!sessionId\)\s*return;/s,
  );
});

test("dashboard header no longer shows settings update controls", () => {
  assert.doesNotMatch(dashboardSource, /const\s+showSettingsHeaderUpdateControls\s*=\s*createMemo\s*\(\s*\(\)\s*=>/);
  assert.doesNotMatch(dashboardSource, /const\s+settingsHeaderUpdateLabel\s*=\s*createMemo\s*\(\s*\(\)\s*=>/);
  assert.doesNotMatch(dashboardSource, /const\s+settingsHeaderUpdateActionLabel\s*=\s*createMemo\s*\(\s*\(\)\s*=>/);
  assert.doesNotMatch(dashboardSource, /const\s+handleSettingsHeaderUpdateAction\s*=\s*\(\)\s*=>/);
  assert.doesNotMatch(headerSource, /showSettingsHeaderUpdateControls\(\)/);
  assert.doesNotMatch(headerSource, /settingsHeaderUpdateLabel\(\)/);
  assert.doesNotMatch(headerSource, /settingsHeaderUpdateActionLabel\(\)/);
});

test("dashboard keeps settings page state out of the shared titlebar chrome", () => {
  assert.match(
    dashboardSource,
    /<TitlebarMenuToggles[\s\S]*centerContent=\{title\(\)\}/,
  );
  assert.doesNotMatch(dashboardSource, /dashboardTitlebarContext/);
  assert.doesNotMatch(dashboardSource, /resolveSettingsTabLabel\(visibleSettingsTab\(\)\)/);
  assert.match(
    settingsSource,
    /import\s*\{\s*resolveVisibleSettingsTab\s*\}\s*from\s+["']\.\.\/lib\/settings-tab-label["'];/,
  );
  assert.match(settingsSource, /import DashboardTabRail/);
  assert.match(settingsSource, /resolveVisibleSettingsTab\(\s*props\.settingsTab,\s*props\.developerMode\s*\)/);
  assert.match(settingsSource, /<h1 class="font-product type-title-md text-gray-12">\s*\{translate\("dashboard\.settings"\)\}\s*<\/h1>/);
  assert.match(settingsSource, /<DashboardTabRail/);
  assert.doesNotMatch(settingsSource, /{resolveNavItemLabel\(item\)}/);
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

test("settings tab labels include archived and keep developer tabs unavailable", () => {
  assert.equal(resolveVisibleSettingsTab("archived", false), "archived");
  assert.equal(resolveVisibleSettingsTab("archived", true), "archived");
  assert.equal(resolveVisibleSettingsTab("advanced", false), "advanced");
  assert.equal(resolveVisibleSettingsTab("advanced", true), "advanced");
  assert.equal(resolveVisibleSettingsTab("debug", false), "general");
  assert.equal(resolveVisibleSettingsTab("debug", true), "general");

  assert.match(settingsTabLabelSource, /archived:\s*"settings\.archived"/);
  assert.doesNotMatch(settingsTabLabelSource, /model:\s*"settings\.model"/);
  assert.match(
    settingsTabLabelSource,
    /const visibleSettingsTabs: SettingsTab\[] = \["general", "archived", "advanced"\]/,
  );
  assert.doesNotMatch(settingsTabLabelSource, /extensions:\s*"settings\.extensions"/);

  const enLocale = readFileSync(new URL("../../../i18n/locales/en.ts", import.meta.url), "utf8");
  const csLocale = readFileSync(new URL("../../../i18n/locales/cs.ts", import.meta.url), "utf8");
  const zhLocale = readFileSync(new URL("../../../i18n/locales/zh.ts", import.meta.url), "utf8");

  assert.match(enLocale, /"settings\.archived":\s*"/);
  assert.match(csLocale, /"settings\.archived":\s*"/);
  assert.match(zhLocale, /"settings\.archived":\s*"/);
});

test("settings tab labels are localized through a shared helper", () => {
  assert.equal(resolveVisibleSettingsTab("advanced", false), "advanced");
  assert.equal(resolveVisibleSettingsTab("advanced", true), "advanced");
  assert.equal(resolveVisibleSettingsTab("debug", false), "general");
  assert.equal(resolveVisibleSettingsTab("debug", true), "general");
  assert.match(settingsTabLabelSource, /settings\.general/);
  assert.match(settingsTabLabelSource, /settings\.advanced/);
  assert.doesNotMatch(settingsTabLabelSource, /settings\.model/);
  assert.match(settingsTabLabelSource, /return\s+t\(key,\s*currentLocale\(\)\)/);
  assert.doesNotMatch(settingsTabLabelSource, /"General"|"Advanced"|"Debug"/);
});
