import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

test("successful pending draft sends consume the pending draft only after the prompt handoff succeeds", () => {
  assert.match(
    appSource,
    /const result = await c\.session\.promptAsync\(\{[\s\S]*assertNoClientError\(result\);\s*\}\s*if \(pendingDraftSendState\) \{[\s\S]*const pendingDraftStorageKey = pendingDraftSendState\.key;[\s\S]*const pendingDraftId = pendingDraftSendState\.draftId;[\s\S]*if \(pendingDraftId && isTauriRuntime\(\)\) \{[\s\S]*await pendingSessionDraftsDelete\(pendingDraftId\);[\s\S]*\}[\s\S]*clearActivePendingDraftState\(\);[\s\S]*setComposerDraftBySessionId\(\(current\) => deleteSessionComposerDraft\(current, \{ storageKey: pendingDraftStorageKey \}\)\);[\s\S]*\}\s*finishPerf\(perfEnabled, "session\.prompt", "done", startedAt, \{[\s\S]*\}\);\s*return true;/s,
    "pending drafts should be deleted and cleared only after the real session prompt handoff succeeds",
  );
});

test("failed sends do not consume pending draft state", () => {
  const catchStart = appSource.indexOf("    } catch (e) {");
  const catchEnd = appSource.indexOf("    } finally {", catchStart);
  assert.notEqual(catchStart, -1, "send failure path should exist");
  assert.notEqual(catchEnd, -1, "send failure path should end before finally");
  const catchWindow = appSource.slice(catchStart, catchEnd);

  assert.doesNotMatch(
    catchWindow,
    /pendingSessionDraftsDelete\(|clearActivePendingDraftState\(|deleteSessionComposerDraft\(/,
    "failed sends must leave the pending draft intact",
  );
});

test("failed pending draft sends restore the pending draft route instead of leaving the empty real session selected", () => {
  assert.match(
    appSource,
    /if \(pendingDraftSendState\) \{\s*setActivePendingDraftKey\(pendingDraftSendState\.key\);\s*setActivePendingDraftMeta\(pendingDraftSendState\.meta\);\s*setView\("session"\);\s*\}/s,
    "pending-draft send failures should return the UI to the pending draft route",
  );
});

test("pending draft cleanup failures are handled separately from prompt handoff success", () => {
  assert.match(
    appSource,
    /if \(pendingDraftId && isTauriRuntime\(\)\) \{\s*try \{[\s\S]*const deleted = await pendingSessionDraftsDelete\(pendingDraftId\);[\s\S]*if \(!deleted\) \{[\s\S]*markPendingDraftConsumed\(pendingDraftId\);[\s\S]*console\.warn\([\s\S]*\} else \{[\s\S]*clearConsumedPendingDraftId\(pendingDraftId\);[\s\S]*\}[\s\S]*\} catch \(error\) \{[\s\S]*markPendingDraftConsumed\(pendingDraftId\);[\s\S]*reportError\(error, "pendingDrafts\.consume"\);[\s\S]*\}\s*\}/s,
    "pending-draft cleanup should report delete errors without converting a successful prompt handoff into a send failure",
  );
});
