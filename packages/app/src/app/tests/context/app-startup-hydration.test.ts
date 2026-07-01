import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");
const startupSource = readFileSync(
  new URL("../../context/app-startup-hydration.ts", import.meta.url),
  "utf8",
);

function sectionBetween(startNeedle: string, endNeedle: string, label: string): string {
  const start = startupSource.indexOf(startNeedle);
  assert.ok(start >= 0, `${label} start should be present`);
  const end = startupSource.indexOf(endNeedle, start);
  assert.ok(end > start, `${label} end should be present`);
  return startupSource.slice(start, end);
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

test("app delegates startup hydration and preference persistence to the AM23 module", () => {
  assert.match(
    appSource,
    /import \{ createAppStartupHydration \} from "\.\/context\/app-startup-hydration";/,
    "app.tsx should import the AM23 startup hydration module",
  );
  assert.match(
    appSource,
    /createAppStartupHydration\(\{[\s\S]*?pendingSessionDraftController,[\s\S]*?consumeDesktopDeepLinkUrls:[\s\S]*?consumeWebDeepLinkUrl:[\s\S]*?\}\);/s,
    "app.tsx should pass the shell dependencies instead of keeping startup hydration inline",
  );
});

test("startup restore reads update preferences before async draft hydration can yield", () => {
  const mountFlow = sectionBetween(
    "onMount(async () => {",
    "createPersistentPreferenceEffects(deps);",
    "startup mount flow",
  );

  assertInOrder(mountFlow, "startup update preference hydration", [
    "hydrateUpdatePreferences(deps);",
    "await deps.pendingSessionDraftController.hydrateActivePendingDraft();",
    "deps.pendingSessionDraftController.markActivePendingDraftStorageReady();",
  ]);
  assert.match(
    startupSource,
    /resolveUpdateAutoDownloadDefaultOffMigration\(\{[\s\S]*?storedAutoDownload: storedUpdateAutoDownload,[\s\S]*?UPDATE_AUTO_DOWNLOAD_DEFAULT_OFF_MIGRATION_KEY/s,
    "startup module should own auto-download default-off migration",
  );
  assert.match(
    startupSource,
    /deps\.setUpdatePreferencesReady\(true\);/,
    "startup module should release update preference persistence after storage hydration",
  );
});

test("startup storage keeps desktop baseUrl ephemeral and migrates model variant state", () => {
  const storageRestore = sectionBetween(
    "function hydrateLocalStoragePreferences",
    "async function hydrateTauriStartup",
    "local storage restore",
  );
  assert.match(
    storageRestore,
    /if \(!deps\.isTauriRuntime\(\)\) \{[\s\S]*?const storedBaseUrl = window\.localStorage\.getItem\("veslo\.baseUrl"\);[\s\S]*?deps\.setBaseUrl\(storedBaseUrl\);[\s\S]*?\}/s,
    "desktop startup must not restore stale localStorage baseUrl",
  );
  assert.match(
    storageRestore,
    /resolveStartupModelVariant\(\{[\s\S]*?storedVariant: window\.localStorage\.getItem\(VARIANT_PREF_KEY\),[\s\S]*?storedMigrationVersion: window\.localStorage\.getItem\(MODEL_VARIANT_DEFAULT_MIGRATION_KEY\),[\s\S]*?\}\)/s,
    "model variant migration should stay with startup storage restore",
  );
  assert.match(
    storageRestore,
    /finally \{\s*deps\.setModelVariantPreferenceReady\(true\);\s*\}/s,
    "variant persistence should wait until startup migration finishes",
  );
});

test("persistent preference effects keep desktop baseUrl out of storage and gate migrated preferences", () => {
  const persistence = sectionBetween(
    "function createPersistentPreferenceEffects",
    "function persistTitlebarPreference",
    "persistent preference effects",
  );

  assertInOrder(persistence, "baseUrl persistence", [
    "if (deps.isTauriRuntime()) return;",
    "window.localStorage.setItem(\"veslo.baseUrl\", deps.baseUrl());",
  ]);
  assert.match(
    persistence,
    /if \(!deps\.updatePreferencesReady\(\)\) return;[\s\S]*?window\.localStorage\.setItem\(\s*"veslo\.updateAutoCheck"/,
    "auto-check persistence should wait for startup preference hydration",
  );
  assert.match(
    persistence,
    /if \(!deps\.updatePreferencesReady\(\)\) return;[\s\S]*?window\.localStorage\.setItem\(\s*"veslo\.updateAutoDownload"/,
    "auto-download persistence should wait for startup preference hydration",
  );
  assert.match(
    persistence,
    /if \(!deps\.modelVariantPreferenceReady\(\)\) return;[\s\S]*?window\.localStorage\.setItem\(VARIANT_PREF_KEY, value\)/,
    "variant persistence should wait for startup migration",
  );
});

test("automatic context compaction no longer has a persisted preference layer", () => {
  assert.doesNotMatch(
    startupSource,
    /AUTO_COMPACT_CONTEXT_PREF_KEY|autoCompactContext|veslo\.autoCompactContext/,
    "startup hydration should not restore or persist the removed auto-compaction preference",
  );
  assert.doesNotMatch(
    appSource,
    /autoCompactContext|setAutoCompactContext|AUTO_COMPACT_CONTEXT_PREF_KEY/,
    "app.tsx should not keep a user preference signal for automatic compaction",
  );
  assert.match(
    appSource,
    /const triggerAutoCompaction = async \(sessionID: string\) => \{[\s\S]*await compactCurrentSession\(sessionID\);/,
    "automatic compaction should remain wired as always-on behavior",
  );
  assert.match(
    appSource,
    /shouldAutoCompact\(messages\(\), selectedSessionModel\(\), providers\(\)\)/,
    "automatic compaction should still respect the context-threshold predicate",
  );
});

test("startup guard completes only after bootstrap and desktop auth recovery are scheduled", () => {
  const mountFlow = sectionBetween(
    "onMount(async () => {",
    "createPersistentPreferenceEffects(deps);",
    "startup mount flow",
  );

  assertInOrder(mountFlow, "desktop auth before bootstrap guard", [
    "await hydrateDesktopAuthSnapshot(deps);",
    "void deps.workspaceStore.bootstrapOnboarding().finally(() => {",
    "startupGuard.complete();",
  ]);
  const bootstrapFinally = sectionBetween(
    "void deps.workspaceStore.bootstrapOnboarding().finally(() => {",
    "createPersistentPreferenceEffects(deps);",
    "bootstrap finally",
  );
  assert.match(
    bootstrapFinally,
    /startupGuard\.complete\(\);[\s\S]*?deps\.setBooting\(false\);/s,
    "bootstrap finally should complete the guard before clearing booting",
  );
  assert.match(
    mountFlow,
    /const startupGuard = createStartupGuard\(\{[\s\S]*?timeoutMs: 15_000,[\s\S]*?deps\.setBooting\(false\);/s,
    "startup timeout should still force boot completion",
  );
});
