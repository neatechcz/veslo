import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { readWorkspaceFacadeSource } from "./workspace-source";

const workspaceSource = readWorkspaceFacadeSource();
const startupSource = readFileSync(
  new URL("../../context/app-startup-hydration.ts", import.meta.url),
  "utf8",
);

function sectionBetween(source: string, startNeedle: string, endNeedle: string, label: string): string {
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
    assert.ok(next > previous, `${label} should keep ${needle} in order`);
    previous = next;
  }
}

test("tauri updater environment detection is scheduled outside the awaited startup path", () => {
  const tauriStartup = sectionBetween(
    startupSource,
    "async function hydrateTauriStartup",
    "function scheduleUpdaterStartup",
    "hydrateTauriStartup",
  );
  const updaterStartup = sectionBetween(
    startupSource,
    "function scheduleUpdaterStartup",
    "async function mountDesktopDeepLinkWorkflow",
    "scheduleUpdaterStartup",
  );

  assert.match(
    tauriStartup,
    /scheduleUpdaterStartup\(deps\);/,
    "Tauri startup should schedule updater work without awaiting updaterEnvironment",
  );
  assert.doesNotMatch(
    tauriStartup,
    /await updaterEnvironment\(\)/,
    "updaterEnvironment must not be awaited before bootstrapOnboarding can start",
  );
  assert.match(
    updaterStartup,
    /void updaterEnvironment\(\)[\s\S]*deps\.setUpdateEnv\(env\)[\s\S]*deps\.checkForUpdates\(\{ quiet: true \}\)/s,
    "updater environment and quiet update check should remain in the background updater startup chain",
  );
  assert.match(
    updaterStartup,
    /deps\.setUpdateEnv\(env\);[\s\S]*if \(!env\.supported\) return;/s,
    "unsupported and explicitly disabled runtimes should not start the updater check path",
  );
});

test("bootstrap publishes local workspace shell before workspace config read completes", () => {
  const bootstrap = sectionBetween(
    workspaceSource,
    "async function bootstrapOnboarding",
    "function onSelectStartup",
    "bootstrapOnboarding",
  );

  assertInOrder(bootstrap, "local workspace config background hydration", [
    "setProjectDir(active.path);",
    "publishLocalWorkspaceConfigFallback(active.path, false);",
    "hydrateLocalWorkspaceConfigInBackground({",
  ]);
  assert.doesNotMatch(
    bootstrap,
    /await withTimeout\(workspaceVesloRead/,
    "bootstrap must not await workspaceVesloRead before first paint",
  );
  assert.match(
    workspaceSource,
    /function hydrateLocalWorkspaceConfigInBackground\([\s\S]*void withTimeout\([\s\S]*workspaceVesloRead\(\{ workspacePath \}\)/s,
    "workspace config read should still happen through a bounded background helper",
  );
});

test("bootstrap completes onboarding before sidebar DB hydration runs", () => {
  const bootstrap = sectionBetween(
    workspaceSource,
    "async function bootstrapOnboarding",
    "function onSelectStartup",
    "bootstrapOnboarding",
  );
  const lazyBoot = sectionBetween(
    bootstrap,
    "if (isTauriRuntime() && options.populateSidebarFromDb)",
    "// Non-Tauri fallback",
    "local lazy boot branch",
  );

  assertInOrder(lazyBoot, "sidebar DB background hydration", [
    "options.setEngineReady?.(false);",
    "markOnboardingComplete();",
    "options.setOnboardingStep(resolveWelcomeOnboardingStep());",
    "populateSidebarFromDbInBackground({",
  ]);
  assert.doesNotMatch(
    bootstrap,
    /await options\.populateSidebarFromDb\(activeWorkspace\?\.id \?\? "", workspacePath\)/,
    "bootstrap must not await sidebar DB hydration before clearing booting",
  );
});
