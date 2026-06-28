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
  deleteSessionComposerDraft,
  getSessionComposerDraft,
  setSessionComposerDraft,
  setSessionComposerPrompt,
} from "../../pages/session-composer-drafts.js";

const pendingDraftControllerSource = readFileSync(
  new URL("../../context/pending-session-draft-controller.ts", import.meta.url),
  "utf8",
);

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

test("pending composer storage keys share one unpublished draft bucket", () => {
  const chatKey = resolvePendingDraftKey({ kind: "new-private" });
  const projectKey = resolvePendingDraftKey({
    kind: "directory",
    workspaceId: "workspace-a",
    directory: "/Users/demo/project",
  });

  const withChatDraft = setSessionComposerDraft({}, { storageKey: chatKey }, withText("hello"));
  const projectDraft = getSessionComposerDraft(withChatDraft, { storageKey: projectKey });

  assert.equal(projectDraft.text, "hello");
});

test("real session composer storage keys remain separate from each other", () => {
  let store = {};
  store = setSessionComposerDraft(store, { storageKey: "session-a" }, withText("Draft A"));
  store = setSessionComposerDraft(store, { storageKey: "session-b" }, withText("Draft B"));

  assert.equal(getSessionComposerDraft(store, { storageKey: "session-a" }).text, "Draft A");
  assert.equal(getSessionComposerDraft(store, { storageKey: "session-b" }).text, "Draft B");
});

test("deleting a pending composer draft clears only the unpublished draft bucket", () => {
  const chatKey = resolvePendingDraftKey({ kind: "new-private" });
  const projectKey = resolvePendingDraftKey({
    kind: "directory",
    workspaceId: "workspace-a",
    directory: "/Users/demo/project",
  });

  let store = {};
  store = setSessionComposerDraft(store, { storageKey: chatKey }, withText("Pending draft"));
  store = setSessionComposerDraft(store, { storageKey: "session-a" }, withText("Real session"));
  store = deleteSessionComposerDraft(store, { storageKey: projectKey });

  assert.equal(getSessionComposerDraft(store, { storageKey: chatKey }).text, "");
  assert.equal(getSessionComposerDraft(store, { storageKey: "session-a" }).text, "Real session");
});

test("active pending drafts are mirrored back into durable desktop storage for restart restore", () => {
  assert.match(
    pendingDraftControllerSource,
    /let pendingDraftPersistenceQueue: Promise<void> = Promise\.resolve\(\);[\s\S]*let pendingDraftPersistenceGeneration = 0;[\s\S]*createEffect\(\(\) => \{[\s\S]*if \(!deps\.isTauriRuntime\(\)\) return;[\s\S]*if \(!activePendingDraftStorageReady\(\)\) return;[\s\S]*const pendingDraftKey = activePendingDraftKey\(\);[\s\S]*const pendingDraftMetaValue = activePendingDraftMeta\(\);[\s\S]*if \(!pendingDraftKey \|\| !pendingDraftMetaValue\) return;[\s\S]*const persistedDraft = input\.composerDraft\(\);[\s\S]*const pendingDraftId = pendingDraftMetaValue\.id\.trim\(\);[\s\S]*if \(!pendingDraftId\) return;[\s\S]*const generation = \+\+pendingDraftPersistenceGeneration;[\s\S]*pendingDraftPersistenceQueue = pendingDraftPersistenceQueue[\s\S]*if \(pendingDraftPersistenceGeneration !== generation\) return;[\s\S]*const activePendingDraftKeyValue = activePendingDraftKey\(\);[\s\S]*const activePendingDraftId = activePendingDraftMeta\(\)\?\.id\.trim\(\) \|\| "";\s*if \(input\.selectedSessionId\(\)\) return;\s*if \(activePendingDraftKeyValue !== pendingDraftKey\) return;\s*if \(activePendingDraftId !== pendingDraftId\) return;[\s\S]*await deps\.pendingSessionDraftsPut\(\{[\s\S]*id: pendingDraftId,[\s\S]*kind: pendingDraftMetaValue\.kind,[\s\S]*workspaceId: pendingDraftMetaValue\.workspaceId,[\s\S]*directory: pendingDraftMetaValue\.directory \?\? null,[\s\S]*privateWorkspaceId: pendingDraftMetaValue\.privateWorkspaceId \?\? null,[\s\S]*composer: persistedDraft,[\s\S]*\}\);[\s\S]*deps\.reportError\(error, "pendingDrafts\.persist"\);[\s\S]*\}\);/s,
    "active pending drafts should persist composer changes through the desktop draft store so restart reopen restores text and attachments",
  );
});

test("pending draft write-back skips stale queued writes after the active draft changes or is consumed", () => {
  assert.match(
    pendingDraftControllerSource,
    /let pendingDraftPersistenceGeneration = 0;[\s\S]*const generation = \+\+pendingDraftPersistenceGeneration;[\s\S]*if \(pendingDraftPersistenceGeneration !== generation\) return;[\s\S]*const activePendingDraftKeyValue = activePendingDraftKey\(\);[\s\S]*const activePendingDraftId = activePendingDraftMeta\(\)\?\.id\.trim\(\) \|\| "";\s*if \(input\.selectedSessionId\(\)\) return;\s*if \(activePendingDraftKeyValue !== pendingDraftKey\) return;\s*if \(activePendingDraftId !== pendingDraftId\) return;/s,
    "queued pending-draft writes should bail out once a newer draft snapshot exists or the pending draft has been consumed",
  );
});
