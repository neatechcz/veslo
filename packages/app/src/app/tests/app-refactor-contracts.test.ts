import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const appRouteSyncSource = readFileSync(new URL("../context/app-route-sync.ts", import.meta.url), "utf8");
const appDeepLinkWorkflowSource = readFileSync(new URL("../context/app-deep-link-workflow.ts", import.meta.url), "utf8");
const appStartupHydrationSource = readFileSync(
  new URL("../context/app-startup-hydration.ts", import.meta.url),
  "utf8",
);

function sectionBetween(
  startNeedle: string,
  endNeedle: string,
  label: string,
  haystack: string = source,
): string {
  const start = haystack.indexOf(startNeedle);
  assert.ok(start >= 0, `${label} start should be present`);
  const end = haystack.indexOf(endNeedle, start);
  assert.ok(end > start, `${label} end should be present`);
  return haystack.slice(start, end);
}

function assertInOrder(haystack: string, label: string, needles: string[]): void {
  let previous = -1;
  for (const needle of needles) {
    const next = haystack.indexOf(needle);
    assert.ok(next >= 0, `${label} should include ${needle}`);
    assert.ok(next > previous, `${label} should keep ${needle} in the expected order`);
    previous = next;
  }
}

test("startup server and bundle links hydrate settings before stripping consumed query params", () => {
  const startupLinkEffect = sectionBetween(
    "const hydrateStartupInvites =",
    "const flushPendingRemoteConnectDeepLink =",
    "startup link effect",
    appDeepLinkWorkflowSource,
  );

  assert.match(
    source,
    /import \{ createAppDeepLinkWorkflow \} from "\.\/context\/app-deep-link-workflow";/,
    "app.tsx should delegate deep-link workflow behavior to the app deep-link workflow context",
  );
  assertInOrder(startupLinkEffect, "startup link effect", [
    "const stored = readSettings();",
    "const invite = readVesloConnectInviteFromSearch(windowTarget.location.search);",
    "const bundleInvite = readVesloBundleInviteFromSearch(windowTarget.location.search);",
  ]);

  assert.match(
    startupLinkEffect,
    /const merged: VesloServerSettings = \{[\s\S]*?urlOverride: invite\.url,[\s\S]*?token: invite\.token \?\? stored\.token,[\s\S]*?\};[\s\S]*?const next = writeSettings\(merged\);[\s\S]*?deps\.setVesloServerSettings\(next\);/s,
    "server invite should merge with persisted settings and save the merged result",
  );
  assert.match(
    startupLinkEffect,
    /if \(invite\.startup === "server"\) \{[\s\S]*?deps\.setStartupPreference\("server"\);[\s\S]*?deps\.setOnboardingStep\("server"\);/s,
    "server startup invites should move the shell into the server startup path",
  );
  assert.match(
    startupLinkEffect,
    /if \(bundleInvite\?\.bundleUrl\) \{[\s\S]*?setPendingSharedBundleInvite\(\{[\s\S]*?bundleUrl: bundleInvite\.bundleUrl,[\s\S]*?intent: bundleInvite\.intent,[\s\S]*?source: bundleInvite\.source,[\s\S]*?orgId: bundleInvite\.orgId,[\s\S]*?label: bundleInvite\.label,[\s\S]*?\}\);[\s\S]*?setSharedBundleNoticeShown\(false\);/s,
    "bundle invites should be queued before the URL is cleaned",
  );
  assertInOrder(startupLinkEffect, "startup link cleanup", [
    "const cleanedConnect = stripVesloConnectInviteFromUrl(windowTarget.location.href);",
    "const cleaned = stripVesloBundleInviteFromUrl(cleanedConnect);",
    "windowTarget.history.replaceState(windowTarget.history.state ?? null, \"\", cleaned);",
  ]);
});

test("desktop deep-link fan-in dedupes URLs and stops after the first matching handler consumes one", () => {
  const desktopDeepLinkStartup = sectionBetween(
    "const { getCurrent, onOpenUrl } = await import(\"@tauri-apps/plugin-deep-link\");",
    "function runWebDeepLinkStartup",
    "desktop deep-link startup",
    appStartupHydrationSource,
  );
  const workflowFanIn = sectionBetween(
    "const consumeDesktopDeepLinkUrls =",
    "const consumeWebDeepLinkUrl =",
    "desktop deep-link workflow fan-in",
    appDeepLinkWorkflowSource,
  );

  assert.match(
    appDeepLinkWorkflowSource,
    /const seenDesktopDeepLinkUrls = new Set<string>\(\);[\s\S]*?if \(seenDesktopDeepLinkUrls\.has\(url\)\) continue;[\s\S]*?seenDesktopDeepLinkUrls\.add\(url\);/s,
    "desktop deep-link delivery should dedupe URLs across startup, open-url, and single-instance channels",
  );
  assert.match(
    workflowFanIn,
    /if \([\s\S]*?deps\.queueAuthCompleteDeepLink\(url\) \|\|[\s\S]*?queueRemoteConnectDeepLink\(url\) \|\|[\s\S]*?queueSharedBundleDeepLink\(url\)[\s\S]*?\) \{\s*break;\s*\}/s,
    "desktop deep-link handling should stop after one handler consumes the launch URL",
  );
  assertInOrder(desktopDeepLinkStartup, "desktop deep-link channel setup", [
    "deps.consumeDesktopDeepLinkUrls(await getCurrent());",
    "const unlisten = await onOpenUrl((urls) => {",
    "deps.consumeDesktopDeepLinkUrls(urls);",
    "const unlistenSingleInstance = await listen<string[]>(\"deep-link://new-url\", (event) => {",
    "deps.consumeDesktopDeepLinkUrls(event.payload);",
    "return () => {",
    "unlisten();",
    "unlistenSingleInstance();",
  ]);
});

test("web startup consumes all URL deep-link formats but strips only non-auth query params", () => {
  const webDeepLinkStartup = sectionBetween(
    "function runWebDeepLinkStartup",
    "async function hydrateDesktopAuthSnapshot",
    "web deep-link startup",
    appStartupHydrationSource,
  );
  const webDeepLinkWorkflow = sectionBetween(
    "const consumeWebDeepLinkUrl =",
    "const hydrateStartupInvites =",
    "web deep-link workflow",
    appDeepLinkWorkflowSource,
  );

  assertInOrder(webDeepLinkStartup, "web deep-link startup", [
    "deps.consumeWebDeepLinkUrl(currentUrl, (cleanedUrl) => {",
    "window.history.replaceState({}, \"\", cleanedUrl);",
  ]);
  assertInOrder(webDeepLinkWorkflow, "web deep-link workflow", [
    "deps.queueAuthCompleteDeepLink(currentUrl);",
    "queueRemoteConnectDeepLink(currentUrl);",
    "queueSharedBundleDeepLink(currentUrl);",
    "const remoteStripped = stripRemoteConnectQuery(currentUrl) ?? currentUrl;",
    "const bundleStripped = stripSharedBundleQuery(remoteStripped) ?? remoteStripped;",
    "replaceUrl(bundleStripped);",
  ]);
  assert.doesNotMatch(
    webDeepLinkWorkflow,
    /stripAuth|stripDesktopAuth|strip.*AuthComplete/i,
    "web auth handoff should stay consumable without stripping unknown auth params in this block",
  );
});

test("desktop hash routing owns dashboard aliases and cleans up its hashchange listener", () => {
  const hashRouting = sectionBetween(
    "const syncExternalHashRoute = (windowTarget?: AppRouteHashWindowTarget | null) => {",
    "const startStartupRouteSync =",
    "desktop hash routing",
    appRouteSyncSource,
  );

  assert.match(
    source,
    /import \{ createAppRouteSync \} from "\.\/context\/app-route-sync";/,
    "app.tsx should delegate route/hash shell behavior to the app route sync context",
  );
  assert.match(
    source,
    /appRouteSync\.startHashRouteSync\(\);/,
    "app.tsx should install desktop hash routing through the route sync module",
  );
  assert.match(
    appRouteSyncSource,
    /import \{[\s\S]*resolveDashboardRouteTab,[\s\S]*\} from "\.\.\/controllers\/app-startup-controller";/s,
    "dashboard hash tab resolution should preserve explicit dashboard tabs and scheduled fallback",
  );
  assert.match(
    hashRouting,
    /const syncExternalHashRoute = \(windowTarget\?: AppRouteHashWindowTarget \| null\) => \{[\s\S]*?if \(!deps\.isTauriRuntime\(\)\) \{[\s\S]*?return;[\s\S]*?const hashPath = target\.location\.hash\.replace\(\/\^#\/, ""\)\.trim\(\);[\s\S]*?if \(!hashPath\.startsWith\("\/"\)\) \{[\s\S]*?return;[\s\S]*?const pathname = routePathFromHash\(hashPath\);/s,
    "desktop hash routing should only consume absolute hash routes in Tauri",
  );
  assert.match(
    hashRouting,
    /syncDashboardHashTab\(pathname\);[\s\S]*?if \(shouldNavigateFromHash\(deps\.pathname\(\), pathname\)\) \{[\s\S]*?deps\.navigate\(hashPath, \{ replace: true \}\);/s,
    "desktop hash routing should sync both dashboard tab state and router location",
  );
  assert.doesNotMatch(
    hashRouting,
    /addEventListener\("hashchange", syncExternalHashRoute\)/,
    "desktop hash routing should not pass DOM hashchange events into the manual sync helper",
  );
  assertInOrder(hashRouting, "desktop hash routing listener lifecycle", [
    "let onHashChange: AppRouteHashChangeListener | null = null;",
    "onHashChange = createAppRouteHashChangeListener(() => mountedWindowTarget, syncExternalHashRoute);",
    "mountedWindowTarget.addEventListener(\"hashchange\", onHashChange);",
    "mountedWindowTarget.removeEventListener(\"hashchange\", onHashChange);",
    "onHashChange = null;",
  ]);
});

test("session first-send entrypoint is exposed through the session flow facade", () => {
  assert.match(
    source,
    /import \{ createSessionFlowFacade \} from "\.\/context\/session-flow-facade";/,
    "app.tsx should import the context session flow facade",
  );
  assert.match(
    source,
    /const sessionFlowFacade = createSessionFlowFacade\(\{[\s\S]*createSessionAndOpen,[\s\S]*sendWorkflow: sessionSendWorkflow,[\s\S]*\}\);[\s\S]*const sendPrompt = sessionFlowFacade\.sendPrompt;[\s\S]*const abortSession = sessionFlowFacade\.abortSession;/s,
    "App should expose send and abort through the session flow facade boundary",
  );
  assert.doesNotMatch(
    source,
    /const sendPrompt = sessionSendWorkflow\.sendPrompt;/,
    "App should not expose sendPrompt directly from the page-level send workflow",
  );
});

test("baseUrl cache is read and written only for the web runtime", () => {
  const startupStorageHydration = sectionBetween(
    "// In Tauri/desktop mode, do NOT restore the cached baseUrl from localStorage.",
    "const storedClientDir = window.localStorage.getItem",
    "startup baseUrl hydration",
    appStartupHydrationSource,
  );
  assert.match(
    startupStorageHydration,
    /if \(!deps\.isTauriRuntime\(\)\) \{[\s\S]*?const storedBaseUrl = window\.localStorage\.getItem\("veslo\.baseUrl"\);[\s\S]*?if \(storedBaseUrl\) \{[\s\S]*?deps\.setBaseUrl\(storedBaseUrl\);[\s\S]*?\}[\s\S]*?\}/s,
    "startup should restore cached baseUrl only outside Tauri",
  );

  const baseUrlPersistence = sectionBetween(
    "// In Tauri desktop the orchestrator port rotates on every `pnpm dev`",
    "\"veslo.clientDirectory\",",
    "baseUrl persistence effect",
    appStartupHydrationSource,
  );
  assertInOrder(baseUrlPersistence, "baseUrl persistence effect", [
    "if (deps.isTauriRuntime()) return;",
    "window.localStorage.setItem(\"veslo.baseUrl\", deps.baseUrl());",
  ]);
});
