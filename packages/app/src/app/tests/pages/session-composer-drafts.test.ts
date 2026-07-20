import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
const {
  batch,
  createComputed,
  createMemo,
  createRoot,
  createSignal,
} = createRequire(import.meta.url)("solid-js/dist/solid.cjs") as typeof import("solid-js");

import type { ComposerDraft } from "../../types";
import {
  resolveComposerStorageKey,
  resolvePendingDraftKey,
} from "../../lib/pending-session-drafts.js";
import {
  createEmptyComposerDraft,
  clearSessionComposerDraftIfRevision,
  deleteSessionComposerDraft,
  getSessionComposerDraft,
  getSessionComposerDraftRevision,
  remapPendingComposerDraftToSession,
  resolveActiveComposerDraftStorageKey,
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

test("preserves entry identity for a semantic no-op and rejects a stale conditional clear", () => {
  const initial = setSessionComposerDraft({}, "session-a", withText("first"));
  const revision = getSessionComposerDraftRevision(initial, "session-a");

  assert.strictEqual(
    setSessionComposerDraft(initial, "session-a", withText("first")),
    initial,
    "a semantic no-op must not wake unrelated Composer consumers",
  );

  const newer = setSessionComposerDraft(initial, "session-a", withText("second"));
  const staleClear = clearSessionComposerDraftIfRevision(newer, "session-a", revision);
  assert.equal(staleClear.cleared, false);
  assert.strictEqual(staleClear.state, newer);
  assert.equal(getSessionComposerDraft(staleClear.state, "session-a").text, "second");

  const currentClear = clearSessionComposerDraftIfRevision(
    newer,
    "session-a",
    getSessionComposerDraftRevision(newer, "session-a"),
  );
  assert.equal(currentClear.cleared, true);
  assert.equal(getSessionComposerDraft(currentClear.state, "session-a").text, "");
});

test("materializing a pending session moves its follow-up composer draft into the real session", () => {
  const pendingDraftKey = resolvePendingDraftKey({
    kind: "directory",
    workspaceId: "workspace-a",
    directory: "/Users/demo/project",
  });
  const pendingStorageKey = resolveComposerStorageKey({ pendingDraftKey });
  const sessionStorageKey = resolveComposerStorageKey({ sessionId: "session-a" });
  const followUp = withText("Keep this follow-up", {
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
  });
  const pendingStore = setSessionComposerDraft({}, { storageKey: pendingStorageKey }, followUp);

  const remap = remapPendingComposerDraftToSession(pendingStore, pendingDraftKey, "session-a");
  assert.equal(remap.status, "moved");
  const materialized = remap.state;

  assert.equal(getSessionComposerDraft(materialized, { storageKey: sessionStorageKey }).text, "Keep this follow-up");
  assert.equal(getSessionComposerDraft(materialized, { storageKey: sessionStorageKey }).attachments.length, 1);
  assert.equal(getSessionComposerDraft(materialized, { storageKey: pendingStorageKey }).text, "");
  assert.strictEqual(
    remapPendingComposerDraftToSession(materialized, pendingDraftKey, "session-a").state,
    materialized,
    "a repeated materialization must be a no-op",
  );
});

test("first-session materialization moves the no-session draft when no pending key exists", () => {
  const noSessionStorageKey = resolveComposerStorageKey({ sessionId: null });
  const sessionStorageKey = resolveComposerStorageKey({ sessionId: "session-a" });
  const noSession = setSessionComposerDraft({}, { storageKey: noSessionStorageKey }, withText("follow-up"));
  const revision = getSessionComposerDraftRevision(noSession, { storageKey: noSessionStorageKey });

  const remap = remapPendingComposerDraftToSession(noSession, null, "session-a");

  assert.equal(remap.status, "moved");
  assert.equal(getSessionComposerDraft(remap.state, { storageKey: sessionStorageKey }).text, "follow-up");
  assert.equal(getSessionComposerDraftRevision(remap.state, { storageKey: sessionStorageKey }), revision);
  assert.equal(getSessionComposerDraft(remap.state, { storageKey: noSessionStorageKey }).text, "");
});

test("first-session handoff reads the materialized draft before route selection completes", () => {
  const noSessionStorageKey = resolveComposerStorageKey({ sessionId: null });
  const sessionStorageKey = resolveComposerStorageKey({ sessionId: "session-a" });
  const pending = setSessionComposerDraft({}, { storageKey: noSessionStorageKey }, withText("follow-up"));
  const moved = remapPendingComposerDraftToSession(pending, null, "session-a");

  const activeStorageKey = resolveActiveComposerDraftStorageKey({
    selectedSessionId: null,
    pendingDraftKey: null,
    materializingSessionId: "session-a",
  });

  assert.equal(activeStorageKey, sessionStorageKey);
  assert.equal(getSessionComposerDraft(moved.state, { storageKey: activeStorageKey }).text, "follow-up");
});

test("reactive first-session handoff never exposes the emptied source draft", () => {
  createRoot((dispose) => {
    const noSessionStorageKey = resolveComposerStorageKey({ sessionId: null });
    const initial = setSessionComposerDraft(
      {},
      { storageKey: noSessionStorageKey },
      withText("follow-up"),
    );
    const [drafts, setDrafts] = createSignal(initial);
    const [selectedSessionId] = createSignal<string | null>(null);
    const [materializingSessionId, setMaterializingSessionId] = createSignal<string | null>(null);
    const activeStorageKey = createMemo(() => resolveActiveComposerDraftStorageKey({
      selectedSessionId: selectedSessionId(),
      pendingDraftKey: null,
      materializingSessionId: materializingSessionId(),
    }));
    const observedPrompts: string[] = [];
    createComputed(() => {
      observedPrompts.push(getSessionComposerDraft(drafts(), { storageKey: activeStorageKey() }).text);
    });

    batch(() => {
      const moved = remapPendingComposerDraftToSession(drafts(), null, "session-a");
      assert.equal(moved.status, "moved");
      setDrafts(moved.state);
      setMaterializingSessionId("session-a");
    });

    assert.deepEqual(observedPrompts, ["follow-up", "follow-up"]);
    dispose();
  });
});

test("materialization preserves the moved revision and never overwrites a real-session draft", () => {
  const pendingDraftKey = resolvePendingDraftKey({ kind: "new-private" });
  const pendingStorageKey = resolveComposerStorageKey({ pendingDraftKey });
  const sessionStorageKey = resolveComposerStorageKey({ sessionId: "session-a" });
  const pending = setSessionComposerDraft({}, { storageKey: pendingStorageKey }, withText("follow-up"));
  const pendingRevision = getSessionComposerDraftRevision(pending, { storageKey: pendingStorageKey });

  const moved = remapPendingComposerDraftToSession(pending, pendingDraftKey, "session-a");
  assert.equal(moved.status, "moved");
  assert.equal(getSessionComposerDraftRevision(moved.state, { storageKey: sessionStorageKey }), pendingRevision);

  const conflicting = setSessionComposerDraft(
    pending,
    { storageKey: sessionStorageKey },
    withText("already there"),
  );
  const conflict = remapPendingComposerDraftToSession(conflicting, pendingDraftKey, "session-a");
  assert.equal(conflict.status, "conflict");
  assert.strictEqual(conflict.state, conflicting);
  assert.equal(getSessionComposerDraft(conflict.state, { storageKey: pendingStorageKey }).text, "follow-up");
  assert.equal(getSessionComposerDraft(conflict.state, { storageKey: sessionStorageKey }).text, "already there");

  const duplicate = setSessionComposerDraft(
    pending,
    { storageKey: sessionStorageKey },
    withText("follow-up"),
  );
  const deduplicated = remapPendingComposerDraftToSession(duplicate, pendingDraftKey, "session-a");
  assert.equal(deduplicated.status, "deduplicated");
  assert.equal(getSessionComposerDraft(deduplicated.state, { storageKey: sessionStorageKey }).text, "follow-up");
  assert.equal(getSessionComposerDraft(deduplicated.state, { storageKey: pendingStorageKey }).text, "");
});

test("a delayed writer or clearer captured on the pending key cannot touch the materialized session draft", () => {
  const pendingDraftKey = resolvePendingDraftKey({ kind: "new-private" });
  const pendingStorageKey = resolveComposerStorageKey({ pendingDraftKey });
  const sessionStorageKey = resolveComposerStorageKey({ sessionId: "session-a" });
  const pending = setSessionComposerDraft({}, { storageKey: pendingStorageKey }, withText("follow-up"));
  const pendingRevision = getSessionComposerDraftRevision(pending, { storageKey: pendingStorageKey });
  const moved = remapPendingComposerDraftToSession(pending, pendingDraftKey, "session-a");
  assert.equal(moved.status, "moved");

  const delayedClear = clearSessionComposerDraftIfRevision(
    moved.state,
    { storageKey: pendingStorageKey },
    pendingRevision,
  );
  assert.equal(delayedClear.cleared, false);
  assert.equal(getSessionComposerDraft(delayedClear.state, { storageKey: sessionStorageKey }).text, "follow-up");

  const delayedWrite = setSessionComposerDraft(
    delayedClear.state,
    { storageKey: pendingStorageKey },
    withText("stale owner"),
  );
  assert.equal(getSessionComposerDraft(delayedWrite, { storageKey: sessionStorageKey }).text, "follow-up");
  assert.equal(getSessionComposerDraft(delayedWrite, { storageKey: pendingStorageKey }).text, "stale owner");
});

test("a clear scoped to one real session cannot affect another session's draft", () => {
  const withA = setSessionComposerDraft({}, "session-a", withText("A"));
  const withBoth = setSessionComposerDraft(withA, "session-b", withText("B"));
  const clearA = clearSessionComposerDraftIfRevision(
    withBoth,
    "session-a",
    getSessionComposerDraftRevision(withBoth, "session-a"),
  );

  assert.equal(clearA.cleared, true);
  assert.equal(getSessionComposerDraft(clearA.state, "session-a").text, "");
  assert.equal(getSessionComposerDraft(clearA.state, "session-b").text, "B");
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
