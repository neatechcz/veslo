import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

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
