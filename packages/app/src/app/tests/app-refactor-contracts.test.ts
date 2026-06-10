import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

function sectionBetween(startNeedle: string, endNeedle: string, label: string): string {
  const start = source.indexOf(startNeedle);
  assert.ok(start >= 0, `${label} start should be present`);
  const end = source.indexOf(endNeedle, start);
  assert.ok(end > start, `${label} end should be present`);
  return source.slice(start, end);
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
    "hydrateVesloServerSettingsFromEnv();",
    "const update = () => setDocumentVisible(document.visibilityState !== \"hidden\");",
    "startup link effect",
  );

  assertInOrder(startupLinkEffect, "startup link effect", [
    "const stored = readVesloServerSettings();",
    "const invite = readVesloConnectInviteFromSearch(window.location.search);",
    "const bundleInvite = readVesloBundleInviteFromSearch(window.location.search);",
  ]);

  assert.match(
    startupLinkEffect,
    /const merged: VesloServerSettings = \{[\s\S]*?urlOverride: invite\.url,[\s\S]*?token: invite\.token \?\? stored\.token,[\s\S]*?\};[\s\S]*?const next = writeVesloServerSettings\(merged\);[\s\S]*?setVesloServerSettings\(next\);/s,
    "server invite should merge with persisted settings and save the merged result",
  );
  assert.match(
    startupLinkEffect,
    /if \(invite\.startup === "server"\) \{[\s\S]*?setStartupPreference\("server"\);[\s\S]*?setOnboardingStep\("server"\);/s,
    "server startup invites should move the shell into the server startup path",
  );
  assert.match(
    startupLinkEffect,
    /if \(bundleInvite\?\.bundleUrl\) \{[\s\S]*?setPendingSharedBundleInvite\(\{[\s\S]*?bundleUrl: bundleInvite\.bundleUrl,[\s\S]*?intent: bundleInvite\.intent,[\s\S]*?source: bundleInvite\.source,[\s\S]*?orgId: bundleInvite\.orgId,[\s\S]*?label: bundleInvite\.label,[\s\S]*?\}\);[\s\S]*?setSharedBundleNoticeShown\(false\);/s,
    "bundle invites should be queued before the URL is cleaned",
  );
  assertInOrder(startupLinkEffect, "startup link cleanup", [
    "const cleanedConnect = stripVesloConnectInviteFromUrl(window.location.href);",
    "const cleaned = stripVesloBundleInviteFromUrl(cleanedConnect);",
    "window.history.replaceState(window.history.state ?? null, \"\", cleaned);",
  ]);
});

test("desktop deep-link fan-in dedupes URLs and stops after the first matching handler consumes one", () => {
  const desktopDeepLinkStartup = sectionBetween(
    "const { getCurrent, onOpenUrl } = await import(\"@tauri-apps/plugin-deep-link\");",
    "if (!isTauriRuntime()) {",
    "desktop deep-link startup",
  );

  assert.match(
    desktopDeepLinkStartup,
    /const seenUrls = new Set<string>\(\);[\s\S]*?const consumeUrls = \(urls: string\[\] \| null \| undefined\) => \{[\s\S]*?if \(seenUrls\.has\(url\)\) continue;[\s\S]*?seenUrls\.add\(url\);/s,
    "desktop deep-link delivery should dedupe URLs across startup, open-url, and single-instance channels",
  );
  assert.match(
    desktopDeepLinkStartup,
    /if \(queueAuthCompleteDeepLink\(url\) \|\| queueRemoteConnectDeepLink\(url\) \|\| queueSharedBundleDeepLink\(url\)\) \{\s*break;\s*\}/s,
    "desktop deep-link handling should stop after one handler consumes the launch URL",
  );
  assertInOrder(desktopDeepLinkStartup, "desktop deep-link channel setup", [
    "consumeUrls(await getCurrent());",
    "const unlisten = await onOpenUrl((urls) => {",
    "const unlistenSingleInstance = await listen<string[]>(\"deep-link://new-url\", (event) => {",
    "mountCleanupFns.push(() => {",
    "unlisten();",
    "unlistenSingleInstance();",
  ]);
});

test("web startup consumes all URL deep-link formats but strips only non-auth query params", () => {
  const webDeepLinkStartup = sectionBetween(
    "const currentUrl = typeof window === \"undefined\" ? \"\" : window.location.href;",
    "const hydrationPromise = hydrateDenAuthFromDesktopSnapshot().catch(() => false);",
    "web deep-link startup",
  );

  assertInOrder(webDeepLinkStartup, "web deep-link startup", [
    "queueAuthCompleteDeepLink(currentUrl);",
    "queueRemoteConnectDeepLink(currentUrl);",
    "queueSharedBundleDeepLink(currentUrl);",
    "const remoteStripped = stripRemoteConnectQuery(currentUrl) ?? currentUrl;",
    "const bundleStripped = stripSharedBundleQuery(remoteStripped) ?? remoteStripped;",
    "window.history.replaceState({}, \"\", bundleStripped);",
  ]);
  assert.doesNotMatch(
    webDeepLinkStartup,
    /stripAuth|stripDesktopAuth|strip.*AuthComplete/i,
    "web auth handoff should stay consumable without stripping unknown auth params in this block",
  );
});

test("desktop hash routing owns dashboard aliases and cleans up its hashchange listener", () => {
  const hashRouting = sectionBetween(
    "const dashboardTabs = new Set<DashboardTab>([",
    "const initialRoute = () => {",
    "desktop hash routing",
  );

  for (const tab of ["scheduled", "soul", "skills", "plugins", "mcp", "config", "settings"]) {
    assert.match(hashRouting, new RegExp(`"${tab}"`), `dashboard hash routing should recognize ${tab}`);
  }

  assert.match(
    hashRouting,
    /const resolveDashboardTab = \(value\?: string \| null\) => \{[\s\S]*?if \(normalized === "plugins"\) return "mcp";[\s\S]*?if \(dashboardTabs\.has\(normalized as DashboardTab\)\) \{[\s\S]*?return normalized as DashboardTab;[\s\S]*?\}[\s\S]*?return "scheduled";[\s\S]*?\};/s,
    "dashboard hash tab resolution should preserve the legacy plugins-to-mcp alias and scheduled fallback",
  );
  assert.match(
    hashRouting,
    /const syncExternalHashRoute = \(\) => \{[\s\S]*?if \(!isTauriRuntime\(\)\) return;[\s\S]*?const hashPath = window\.location\.hash\.replace\(\/\^#\/, ""\)\.trim\(\);[\s\S]*?if \(!hashPath\.startsWith\("\/"\)\) return;[\s\S]*?const pathname = hashPath\.split\(\/\[\?#\]\/, 1\)\[0\]\?\.toLowerCase\(\) \?\? "";/s,
    "desktop hash routing should only consume absolute hash routes in Tauri",
  );
  assert.match(
    hashRouting,
    /if \(pathname\.startsWith\("\/dashboard"\)\) \{[\s\S]*?const resolvedTab = resolveDashboardTab\(tabSegment\);[\s\S]*?setTabState\(resolvedTab\);[\s\S]*?\}[\s\S]*?if \(location\.pathname\.toLowerCase\(\) !== pathname\) \{[\s\S]*?navigate\(hashPath, \{ replace: true \}\);/s,
    "desktop hash routing should sync both dashboard tab state and router location",
  );
  assertInOrder(hashRouting, "desktop hash routing listener lifecycle", [
    "window.addEventListener(\"hashchange\", syncExternalHashRoute);",
    "window.removeEventListener(\"hashchange\", syncExternalHashRoute);",
  ]);
});

test("baseUrl cache is read and written only for the web runtime", () => {
  const startupStorageHydration = sectionBetween(
    "// In Tauri/desktop mode, do NOT restore the cached baseUrl from localStorage.",
    "const storedClientDir = window.localStorage.getItem",
    "startup baseUrl hydration",
  );
  assert.match(
    startupStorageHydration,
    /if \(!isTauriRuntime\(\)\) \{[\s\S]*?const storedBaseUrl = window\.localStorage\.getItem\("veslo\.baseUrl"\);[\s\S]*?if \(storedBaseUrl\) \{[\s\S]*?setBaseUrl\(storedBaseUrl\);[\s\S]*?\}[\s\S]*?\}/s,
    "startup should restore cached baseUrl only outside Tauri",
  );

  const baseUrlPersistence = sectionBetween(
    "// In Tauri desktop the orchestrator port rotates on every `pnpm dev`",
    "\"veslo.clientDirectory\",",
    "baseUrl persistence effect",
  );
  assertInOrder(baseUrlPersistence, "baseUrl persistence effect", [
    "if (isTauriRuntime()) return;",
    "window.localStorage.setItem(\"veslo.baseUrl\", baseUrl());",
  ]);
});
