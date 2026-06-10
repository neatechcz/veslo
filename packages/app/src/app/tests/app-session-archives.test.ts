import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

test("session archive flow uses the resolved archive owner key instead of requiring cloud auth directly", () => {
  assert.match(
    source,
    /const vesloArchiveClientOptions = createMemo\(\(\) => \{[\s\S]*?resolveSessionArchiveClientOptions\(/,
    "archive client resolution should be exposed as a memo so local owner fallback is available to archive handlers",
  );

  assert.match(
    source,
    /const sessionArchiveOwnerKey = createMemo\(\(\) => vesloArchiveClientOptions\(\)\?\.accountId \?\? ""\);/,
    "archive handlers should share the resolved owner key from client options",
  );

  const archiveFlow = source.match(
    /const loadSessionArchives = async \(\) => \{[\s\S]*?const unarchiveSession = async \(sessionId: string\) => \{[\s\S]*?^\s*\};/m,
  )?.[0] ?? "";

  assert.ok(archiveFlow, "app should define the session archive load/archive/unarchive flow");
  assert.doesNotMatch(
    archiveFlow,
    /authenticatedAccountId\(\)/,
    "archive load/archive/unarchive must not bypass the local archive owner fallback",
  );
  assert.match(archiveFlow, /const ownerKey = sessionArchiveOwnerKey\(\);/);
  assert.match(archiveFlow, /writeArchiveMigrationDone\(ownerKey\);/);
});

test("update preference persistence waits for startup preference hydration", () => {
  assert.match(
    source,
    /const \[updatePreferencesReady, setUpdatePreferencesReady\] = createSignal\(false\);/,
    "app should track whether update preferences have been read before writing them back",
  );
  assert.match(
    source,
    /if \(!updatePreferencesReady\(\)\) return;[\s\S]*?window\.localStorage\.setItem\(\s*"veslo\.updateAutoCheck"/,
    "auto-check persistence should not write the default before startup hydration reads stored preferences",
  );
  assert.match(
    source,
    /if \(!updatePreferencesReady\(\)\) return;[\s\S]*?window\.localStorage\.setItem\(\s*"veslo\.updateAutoDownload"/,
    "auto-download persistence should not write the default before startup hydration reads stored preferences",
  );

  const startupMount = source.match(/onMount\(async \(\) => \{[\s\S]*?setActivePendingDraftStorageReady\(true\);/)?.[0] ?? "";
  assert.ok(startupMount, "app should define the async startup mount flow");
  const updatePrefsIndex = startupMount.indexOf("const storedUpdateAutoDownload = window.localStorage.getItem");
  const pendingDraftAwaitIndex = startupMount.indexOf("await pendingSessionDraftsList()");
  assert.ok(updatePrefsIndex >= 0, "startup flow should read stored update auto-download preference");
  assert.ok(pendingDraftAwaitIndex >= 0, "startup flow should hydrate pending drafts on desktop startup");
  assert.ok(
    updatePrefsIndex < pendingDraftAwaitIndex,
    "stored update preferences should be read before async desktop startup work can yield",
  );
});

test("session archive loader retries the same client after server readiness changes", () => {
  const archiveLoadEffect = source.match(
    /let lastSessionArchiveClientKey = "";[\s\S]*?let sessionArchiveMigrationRunning = false;/m,
  )?.[0] ?? "";

  assert.ok(archiveLoadEffect, "app should define the session archive startup load effect");
  assert.match(
    archiveLoadEffect,
    /const archiveServerStatus = vesloServerStatus\(\);/,
    "archive startup loading should track server status so a failed initial load retries when the server becomes ready",
  );
  assert.match(
    archiveLoadEffect,
    /const archiveServerCheckedAt = vesloServerCheckedAt\(\);/,
    "archive startup loading should track server health checks so retryable startup failures are not stuck until a mutation",
  );
  assert.match(
    archiveLoadEffect,
    /failedSessionArchiveClientKey === key/,
    "archive startup loading should remember the failed archive client key and retry that same key after readiness changes",
  );
});
