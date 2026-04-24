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
