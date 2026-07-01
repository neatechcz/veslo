import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const archiveStoreSource = readFileSync(new URL("../context/session-archive-store.ts", import.meta.url), "utf8");
const vesloServerConnectionSource = readFileSync(
  new URL("../context/veslo-server-connection.ts", import.meta.url),
  "utf8",
);

test("session archive flow uses the resolved archive owner key instead of requiring cloud auth directly", () => {
  assert.match(
    vesloServerConnectionSource,
    /const vesloArchiveClientOptions = createMemo\(\(\) => \{[\s\S]*?resolveSessionArchiveClientOptions\(/,
    "archive client resolution should be exposed as a memo so local owner fallback is available to archive handlers",
  );

  assert.match(
    vesloServerConnectionSource,
    /const sessionArchiveOwnerKey = createMemo\(\(\) => vesloArchiveClientOptions\(\)\?\.accountId \?\? ""\);/,
    "archive handlers should share the resolved owner key from client options",
  );

  const archiveFlow =
    archiveStoreSource.match(
      /export function createSessionArchiveStore[\s\S]*?const unarchiveSession = async \([\s\S]*?workspaceIdentityHint\?: string \| null,[\s\S]*?\) => \{[\s\S]*?^\s*\};/m,
    )?.[0] ?? "";

  assert.ok(archiveFlow, "session archive store should define the load/archive/unarchive flow");
  assert.doesNotMatch(
    archiveFlow,
    /authenticatedAccountId\(\)/,
    "archive load/archive/unarchive must not bypass the local archive owner fallback",
  );
  assert.match(archiveFlow, /const ownerKey = deps\.sessionArchiveOwnerKey\(\);/);
  assert.match(archiveFlow, /writeArchiveMigrationDone\(storage, ownerKey\);/);
  assert.match(
    archiveFlow,
    /client\.deleteSessionArchive\(sessionId, \{ workspaceId, workspaceIdentity \}\)/,
    "unarchive should preserve workspace id and identity scope for duplicate session ids",
  );
});

test("update preference persistence waits for startup preference hydration", () => {
  assert.match(
    appSource,
    /const \[updatePreferencesReady, setUpdatePreferencesReady\] = createSignal\(false\);/,
    "app should track whether update preferences have been read before writing them back",
  );
  assert.match(
    appSource,
    /if \(!updatePreferencesReady\(\)\) return;[\s\S]*?window\.localStorage\.setItem\(\s*"veslo\.updateAutoCheck"/,
    "auto-check persistence should not write the default before startup hydration reads stored preferences",
  );
  assert.match(
    appSource,
    /if \(!updatePreferencesReady\(\)\) return;[\s\S]*?window\.localStorage\.setItem\(\s*"veslo\.updateAutoDownload"/,
    "auto-download persistence should not write the default before startup hydration reads stored preferences",
  );
  assert.match(
    appSource,
    /resolveUpdateAutoDownloadDefaultOffMigration\(\{[\s\S]*?storedAutoDownload: storedUpdateAutoDownload,[\s\S]*?migrationComplete:[\s\S]*?UPDATE_AUTO_DOWNLOAD_DEFAULT_OFF_MIGRATION_KEY/,
    "startup flow should migrate legacy default-on auto-download before resolving update preferences",
  );

  const startupMount = appSource.match(/onMount\(async \(\) => \{[\s\S]*?pendingSessionDraftController\.markActivePendingDraftStorageReady\(\);/)?.[0] ?? "";
  assert.ok(startupMount, "app should define the async startup mount flow");
  const updatePrefsIndex = startupMount.indexOf("const storedUpdateAutoDownload = window.localStorage.getItem");
  const pendingDraftAwaitIndex = startupMount.indexOf("await pendingSessionDraftController.hydrateActivePendingDraft()");
  assert.ok(updatePrefsIndex >= 0, "startup flow should read stored update auto-download preference");
  assert.ok(pendingDraftAwaitIndex >= 0, "startup flow should hydrate pending drafts on desktop startup");
  assert.ok(
    updatePrefsIndex < pendingDraftAwaitIndex,
    "stored update preferences should be read before async desktop startup work can yield",
  );
});

test("startup update check waits for preferences and updater environment", () => {
  const startupUpdateCheckEffect = appSource.match(
    /createEffect\(\(\) => \{[\s\S]*?if \(launchUpdateCheckTriggered\(\)\) return;[\s\S]*?checkForUpdates\(\{ quiet: true \}\)/,
  )?.[0] ?? "";

  assert.ok(startupUpdateCheckEffect, "app should define the startup update check effect");
  assert.match(
    startupUpdateCheckEffect,
    /if \(!updateAutoCheck\(\)\) return;/,
    "startup update check should honor stored auto-check preferences before contacting the update endpoint",
  );
  assert.match(
    startupUpdateCheckEffect,
    /const env = updateEnv\(\);[\s\S]*?if \(!env\) return;[\s\S]*?if \(!env\.supported\) return;/,
    "startup update check should wait for updater environment and skip unsupported runtimes",
  );
});

test("session archive loader retries the same client after server readiness changes", () => {
  const archiveLoadEffect = archiveStoreSource.match(
    /let lastSessionArchiveClientKey = "";[\s\S]*?let sessionArchiveMigrationRunning = false;/m,
  )?.[0] ?? "";

  assert.ok(archiveLoadEffect, "session archive store should define the startup load effect");
  assert.match(
    archiveLoadEffect,
    /const archiveServerStatus = deps\.vesloServerStatus\(\);/,
    "archive startup loading should track server status so a failed initial load retries when the server becomes ready",
  );
  assert.match(
    archiveLoadEffect,
    /const archiveServerCheckedAt = deps\.vesloServerCheckedAt\(\);/,
    "archive startup loading should track server health checks so retryable startup failures are not stuck until a mutation",
  );
  assert.match(
    archiveLoadEffect,
    /failedSessionArchiveClientKey === key/,
    "archive startup loading should remember the failed archive client key and retry that same key after readiness changes",
  );
});
