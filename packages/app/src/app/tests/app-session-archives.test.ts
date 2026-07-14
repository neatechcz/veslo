import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const startupHydrationSource = readFileSync(
  new URL("../context/app-startup-hydration.ts", import.meta.url),
  "utf8",
);
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
    /const sessionArchiveOwnerKey = createMemo\(\s*\(\) => vesloArchiveClientOptions\(\)\?\.accountId \?\? "",\s*\);/,
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
  assert.match(archiveFlow, /const snapshot = syncSessionArchiveScope\(\);/);
  assert.match(archiveFlow, /writeArchiveMigrationDone\(storage, snapshot\.ownerKey\);/);
  assert.match(
    archiveStoreSource,
    /const deleteOptions: \{ workspaceId: string; workspaceIdentity\?: string; directory\?: string \} = \{\s*workspaceId,\s*\};[\s\S]*if \(workspaceIdentity\) deleteOptions\.workspaceIdentity = workspaceIdentity;[\s\S]*if \(targetDirectory\) deleteOptions\.directory = targetDirectory;[\s\S]*client\.deleteSessionArchive\(sessionId, deleteOptions\)/,
    "unarchive should preserve workspace id, identity, and directory scope for duplicate session ids",
  );
});

test("update preference persistence waits for startup preference hydration", () => {
  assert.match(
    appSource,
    /const \[updatePreferencesReady, setUpdatePreferencesReady\] = createSignal\(false\);/,
    "app should track whether update preferences have been read before writing them back",
  );
  assert.match(
    startupHydrationSource,
    /if \(!deps\.updatePreferencesReady\(\)\) return;[\s\S]*?window\.localStorage\.setItem\(\s*"veslo\.updateAutoCheck"/,
    "auto-check persistence should not write the default before startup hydration reads stored preferences",
  );
  assert.match(
    startupHydrationSource,
    /if \(!deps\.updatePreferencesReady\(\)\) return;[\s\S]*?window\.localStorage\.setItem\(\s*"veslo\.updateAutoDownload"/,
    "auto-download persistence should not write the default before startup hydration reads stored preferences",
  );
  assert.match(
    startupHydrationSource,
    /resolveUpdateAutoDownloadDefaultOffMigration\(\{[\s\S]*?storedAutoDownload: storedUpdateAutoDownload,[\s\S]*?migrationComplete:[\s\S]*?UPDATE_AUTO_DOWNLOAD_DEFAULT_OFF_MIGRATION_KEY/,
    "startup flow should migrate legacy default-on auto-download before resolving update preferences",
  );

  const startupMount =
    startupHydrationSource.match(
      /onMount\(async \(\) => \{[\s\S]*?deps\.pendingSessionDraftController\.markActivePendingDraftStorageReady\(\);/,
    )?.[0] ?? "";
  assert.ok(startupMount, "app should define the async startup mount flow");
  const updatePrefsIndex = startupMount.indexOf("hydrateUpdatePreferences(deps);");
  const pendingDraftAwaitIndex = startupMount.indexOf(
    "await deps.pendingSessionDraftController.hydrateActivePendingDraft()",
  );
  assert.ok(updatePrefsIndex >= 0, "startup flow should hydrate stored update preferences");
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
  assert.match(
    archiveStoreSource,
    /function buildSessionArchiveClientKey\([\s\S]*?JSON\.stringify\(\[client\.baseUrl, client\.token \?\? "", ownerKey\]\)/,
    "archive identity should use a structured key instead of concatenating credential values",
  );
  assert.match(
    archiveStoreSource,
    /let sessionArchiveGeneration = 0;/,
    "archive state should increment a generation when the active client or owner changes",
  );
  assert.match(
    archiveStoreSource,
    /const archiveServerStatus = deps\.vesloServerStatus\(\);/,
    "archive startup loading should track server status so a failed initial load retries when the server becomes ready",
  );
  assert.match(
    archiveStoreSource,
    /const archiveServerCheckedAt = deps\.vesloServerCheckedAt\(\) \?\? null;/,
    "archive startup loading should track server health checks so retryable startup failures are not stuck until a mutation",
  );
  assert.match(
    archiveStoreSource,
    /sameSessionArchiveSnapshot\(failedSessionArchiveSnapshot, snapshot\)/,
    "archive startup loading should retry only the failed current snapshot after a later health check",
  );
  assert.match(
    archiveStoreSource,
    /const recordsRevisionAtStart = sessionArchiveRecordsRevision;/,
    "each list should capture the current record revision before awaiting the server",
  );
  assert.match(
    archiveStoreSource,
    /recordsRevisionAtStart !== sessionArchiveRecordsRevision/,
    "a late list should be discarded after a same-owner archive mutation publishes newer records",
  );
});

test("session archive loader only clears its own visible error after recovery", () => {
  assert.match(
    appSource,
    /createSessionArchiveStore\(\{[\s\S]*?setError,[\s\S]*?getError: error,/,
    "app composition should provide the archive store with the current global error before allowing it to clear recovery state",
  );
  assert.match(
    archiveStoreSource,
    /deps\.getError\?\.\(\) === SESSION_ARCHIVE_LOAD_ERROR_MESSAGE/,
    "archive recovery must not clear a different workflow's global error",
  );
  assert.match(
    archiveStoreSource,
    /const setOwnSessionArchiveLoadError = \(\) => \{[\s\S]*?if \(currentError && currentError !== SESSION_ARCHIVE_LOAD_ERROR_MESSAGE\) return;/,
    "a background archive-load failure must not replace a different workflow's visible error",
  );
});

test("archiving the active sidebar session clears the displayed conversation only after archive succeeds", () => {
  assert.match(
    appSource,
    /import \{ buildArchivedSidebarSessionKey \} from "\.\/lib\/session-archive-model";/,
    "app should use the same workspace-scoped archive key as the sidebar filter before clearing active selection",
  );

  assert.match(
    appSource,
    /const archivedSessionMatchesSidebarTarget = \(\s*workspaceId: string,\s*sessionId: string,\s*target\?: SidebarSessionOpenTarget \| null,[\s\S]*buildArchivedSidebarSessionKey\(\{ workspaceId, sessionId, directory: target\?\.directory \}\)[\s\S]*archivedSessionIds\(\)\.includes\(key\)/,
    "active-session cleanup should verify that the mutation actually published the scoped archived sidebar key",
  );

  assert.match(
    appSource,
    /const activeSessionMatchesArchiveTarget = \(\s*workspaceId: string,\s*sessionId: string,\s*target\?: SidebarSessionOpenTarget \| null,[\s\S]*selectedSessionId\(\)\?\.trim\(\) !== normalizedSessionId[\s\S]*targetRowKey[\s\S]*resolveSelectedSessionBrowseScope\(normalizedSessionId\)[\s\S]*activeWorkspaceId !== normalizedWorkspaceId[\s\S]*targetDirectory[\s\S]*targetConversationId[\s\S]*targetOpencodeSessionId/s,
    "cleanup should only target the selected session in the archived workspace, so duplicate session ids stay safe",
  );

  assert.match(
    appSource,
    /const clearArchivedActiveSession = \(sessionId: string\) => \{[\s\S]*batch\(\(\) => \{[\s\S]*setSelectedSessionId\(null\);[\s\S]*setMessages\(\[\]\);[\s\S]*setTodos\(\[\]\);[\s\S]*sessionIdFromRoutePath\(location\.pathname\) === normalizedSessionId[\s\S]*navigate\("\/session", \{ replace: true \}\);/s,
    "clearing an archived active session should remove stale transcript state and canonicalize /session/:id to /session",
  );

  assert.match(
    appSource,
    /const archiveSidebarSessionAndClearActive = async \(\s*workspaceId: string,\s*sessionId: string,\s*target\?: SidebarSessionOpenTarget \| null,[\s\S]*const shouldClearActiveSession = activeSessionMatchesArchiveTarget\(workspaceId, sessionId, target\);[\s\S]*await archiveSidebarSession\(workspaceId, sessionId, target \?\? undefined\);[\s\S]*if \(!shouldClearActiveSession\) return;[\s\S]*if \(!activeSessionMatchesArchiveTarget\(workspaceId, sessionId, target\)\) return;[\s\S]*if \(!archivedSessionMatchesSidebarTarget\(workspaceId, sessionId, target\)\) return;[\s\S]*clearArchivedActiveSession\(sessionId\);[\s\S]*\};/s,
    "archive wrapper should not clear if archive failed or the user switched sessions while the mutation was in flight",
  );

  assert.match(
    appSource,
    /archiveSidebarSessionAndClearActive,/,
    "session and dashboard sidebars should receive the cleanup-aware archive handler",
  );
});
