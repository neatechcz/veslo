import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { ComposerDraft } from "../../types";
import {
  resolveComposerStorageKey,
  resolvePendingDraftKey,
} from "../../lib/pending-session-drafts.js";
import {
  createEmptyComposerDraft,
  getSessionComposerDraft,
  setSessionComposerDraft,
  setSessionComposerPrompt,
} from "../../pages/session-composer-drafts.js";

const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");

const withText = (text: string, extras?: Partial<ComposerDraft>): ComposerDraft => ({
  ...createEmptyComposerDraft(),
  text,
  resolvedText: text,
  parts: text ? [{ type: "text", text }] : [],
  ...extras,
});

test("stores drafts per session id without leaking text across sessions", () => {
  const sessA = withText("Draft A");
  const sessB = withText("Draft B");

  let store = {};
  store = setSessionComposerDraft(store, "session-a", sessA);
  store = setSessionComposerDraft(store, "session-b", sessB);

  assert.equal(getSessionComposerDraft(store, "session-a").text, "Draft A");
  assert.equal(getSessionComposerDraft(store, "session-b").text, "Draft B");
});

test("uses a separate draft bucket for no selected session", () => {
  let store = {};
  store = setSessionComposerPrompt(store, null, "No session draft");
  store = setSessionComposerPrompt(store, "session-a", "Session A draft");

  assert.equal(getSessionComposerDraft(store, null).text, "No session draft");
  assert.equal(getSessionComposerDraft(store, "session-a").text, "Session A draft");
});

test("setSessionComposerPrompt resets attachments to prevent cross-session carry-over", () => {
  const draftWithAttachment = withText("Has attachment", {
    attachments: [
      {
        id: "file-1",
        name: "demo.txt",
        mimeType: "text/plain",
        size: 4,
        kind: "file",
        dataUrl: "data:text/plain;base64,ZGVtbw==",
      },
    ],
  });

  let store = {};
  store = setSessionComposerDraft(store, "session-a", draftWithAttachment);
  store = setSessionComposerPrompt(store, "session-b", "Session B");

  assert.equal(getSessionComposerDraft(store, "session-a").attachments.length, 1);
  assert.equal(getSessionComposerDraft(store, "session-b").attachments.length, 0);
});

test("real session drafts and pending drafts do not overwrite one another", () => {
  const pendingDraftKey = resolvePendingDraftKey({
    kind: "directory",
    workspaceId: "workspace-1",
    directory: "/Users/demo/project/",
  });
  const sessionStorageKey = resolveComposerStorageKey({ sessionId: "session-a" });
  const pendingStorageKey = resolveComposerStorageKey({ pendingDraftKey });

  let store = {};
  store = setSessionComposerDraft(store, { storageKey: sessionStorageKey }, withText("Real session"));
  store = setSessionComposerDraft(store, {
    storageKey: pendingStorageKey,
  }, withText("Pending draft", {
    attachments: [
      {
        id: "attachment-1",
        name: "diagram.png",
        mimeType: "image/png",
        size: 4,
        kind: "image",
        dataUrl: "data:image/png;base64,AAECAw==",
      },
    ],
  }));

  assert.equal(getSessionComposerDraft(store, { storageKey: sessionStorageKey }).text, "Real session");
  assert.equal(getSessionComposerDraft(store, { storageKey: pendingStorageKey }).text, "Pending draft");
  assert.equal(getSessionComposerDraft(store, { storageKey: pendingStorageKey }).attachments.length, 1);
});

test("active pending drafts are mirrored back into durable desktop storage for restart restore", () => {
  assert.match(
    appSource,
    /let pendingDraftPersistenceQueue: Promise<void> = Promise\.resolve\(\);[\s\S]*let pendingDraftPersistenceGeneration = 0;[\s\S]*createEffect\(\(\) => \{[\s\S]*if \(!isTauriRuntime\(\)\) return;[\s\S]*if \(!activePendingDraftStorageReady\(\)\) return;[\s\S]*const pendingDraftKey = activePendingDraftKey\(\);[\s\S]*const pendingDraftMetaValue = activePendingDraftMeta\(\);[\s\S]*if \(!pendingDraftKey \|\| !pendingDraftMetaValue\) return;[\s\S]*const persistedDraft = composerDraft\(\);[\s\S]*const pendingDraftId = pendingDraftMetaValue\.id\.trim\(\);[\s\S]*if \(!pendingDraftId\) return;[\s\S]*const generation = \+\+pendingDraftPersistenceGeneration;[\s\S]*pendingDraftPersistenceQueue = pendingDraftPersistenceQueue[\s\S]*if \(pendingDraftPersistenceGeneration !== generation\) return;[\s\S]*const activePendingDraftKeyValue = activePendingDraftKey\(\);[\s\S]*const activePendingDraftId = activePendingDraftMeta\(\)\?\.id\.trim\(\) \|\| "";\s*if \(selectedSessionId\(\)\) return;\s*if \(activePendingDraftKeyValue !== pendingDraftKey\) return;\s*if \(activePendingDraftId !== pendingDraftId\) return;[\s\S]*await pendingSessionDraftsPut\(\{[\s\S]*id: pendingDraftId,[\s\S]*kind: pendingDraftMetaValue\.kind,[\s\S]*workspaceId: pendingDraftMetaValue\.workspaceId,[\s\S]*directory: pendingDraftMetaValue\.directory \?\? null,[\s\S]*privateWorkspaceId: pendingDraftMetaValue\.privateWorkspaceId \?\? null,[\s\S]*composer: persistedDraft,[\s\S]*\}\);[\s\S]*reportError\(error, "pendingDrafts\.persist"\);[\s\S]*\}\);/s,
    "active pending drafts should persist composer changes through the desktop draft store so restart reopen restores text and attachments",
  );
});

test("pending draft write-back skips stale queued writes after the active draft changes or is consumed", () => {
  assert.match(
    appSource,
    /let pendingDraftPersistenceGeneration = 0;[\s\S]*const generation = \+\+pendingDraftPersistenceGeneration;[\s\S]*if \(pendingDraftPersistenceGeneration !== generation\) return;[\s\S]*const activePendingDraftKeyValue = activePendingDraftKey\(\);[\s\S]*const activePendingDraftId = activePendingDraftMeta\(\)\?\.id\.trim\(\) \|\| "";\s*if \(selectedSessionId\(\)\) return;\s*if \(activePendingDraftKeyValue !== pendingDraftKey\) return;\s*if \(activePendingDraftId !== pendingDraftId\) return;/s,
    "queued pending-draft writes should bail out once a newer draft snapshot exists or the pending draft has been consumed",
  );
});
