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

test("archiving the active sidebar session clears the displayed conversation only after archive succeeds", () => {
  assert.match(
    appSource,
    /import \{ buildArchivedSidebarSessionKey \} from "\.\/lib\/session-archive-model";/,
    "app should use the same workspace-scoped archive key as the sidebar filter before clearing active selection",
  );

  assert.match(
    appSource,
    /const archivedSessionMatchesSidebarTarget = \(workspaceId: string, sessionId: string\) => \{[\s\S]*buildArchivedSidebarSessionKey\(\{ workspaceId, sessionId \}\)[\s\S]*archivedSessionIds\(\)\.includes\(key\)/,
    "active-session cleanup should verify that the mutation actually published an archived sidebar key",
  );

  assert.match(
    appSource,
    /const activeSessionMatchesArchiveTarget = \(workspaceId: string, sessionId: string\) => \{[\s\S]*selectedSessionId\(\)\?\.trim\(\) !== normalizedSessionId[\s\S]*resolveSelectedSessionBrowseScope\(normalizedSessionId\)[\s\S]*workspaceStore\.activeWorkspaceId\(\)\.trim\(\)[\s\S]*activeWorkspaceId === normalizedWorkspaceId/s,
    "cleanup should only target the selected session in the archived workspace, so duplicate session ids stay safe",
  );

  assert.match(
    appSource,
    /const clearArchivedActiveSession = \(sessionId: string\) => \{[\s\S]*batch\(\(\) => \{[\s\S]*setSelectedSessionId\(null\);[\s\S]*setMessages\(\[\]\);[\s\S]*setTodos\(\[\]\);[\s\S]*navigate\("\/session", \{ replace: true \}\);/s,
    "clearing an archived active session should remove stale transcript state and canonicalize /session/:id to /session",
  );

  assert.match(
    appSource,
    /const archiveSidebarSessionAndClearActive = async \(workspaceId: string, sessionId: string\) => \{[\s\S]*const shouldClearActiveSession = activeSessionMatchesArchiveTarget\(workspaceId, sessionId\);[\s\S]*await archiveSidebarSession\(workspaceId, sessionId\);[\s\S]*if \(!shouldClearActiveSession\) return;[\s\S]*if \(!activeSessionMatchesArchiveTarget\(workspaceId, sessionId\)\) return;[\s\S]*if \(!archivedSessionMatchesSidebarTarget\(workspaceId, sessionId\)\) return;[\s\S]*clearArchivedActiveSession\(sessionId\);[\s\S]*\};/s,
    "archive wrapper should not clear if archive failed or the user switched sessions while the mutation was in flight",
  );

  assert.match(
    appSource,
    /archiveSidebarSession: archiveSidebarSessionAndClearActive,/,
    "session and dashboard sidebars should receive the cleanup-aware archive handler",
  );
});
