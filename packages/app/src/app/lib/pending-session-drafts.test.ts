import assert from "node:assert/strict";
import test from "node:test";

import {
  isPendingDraftKey,
  pendingDraftAttachmentPayloadToComposerAttachment,
  pendingDraftAttachmentPayloadsToComposerAttachments,
  resolveComposerStorageKey,
  resolvePendingDraftKey,
} from "./pending-session-drafts.js";

test("new-private draft keys are unique once a private workspace exists", () => {
  const first = resolvePendingDraftKey({
    kind: "new-private",
    workspaceId: "workspace-a",
    privateWorkspaceId: "private-a",
  });
  const second = resolvePendingDraftKey({
    kind: "new-private",
    workspaceId: "workspace-b",
    privateWorkspaceId: "private-b",
  });
  const generic = resolvePendingDraftKey({
    kind: "new-private",
  });

  assert.notEqual(first, second);
  assert.notEqual(first, generic);
  assert.match(first, /private-a$/);
  assert.match(second, /private-b$/);
  assert.equal(isPendingDraftKey(first), true);
  assert.equal(resolveComposerStorageKey({ pendingDraftKey: first }), first);
});

test("directory drafts resolve to distinct keys per normalized target", () => {
  const first = resolvePendingDraftKey({
    kind: "directory",
    workspaceId: "workspace-a",
    directory: "/Users/demo/project/",
  });
  const sameNormalized = resolvePendingDraftKey({
    kind: "directory",
    workspaceId: "workspace-a",
    directory: "/Users/demo/project",
  });
  const differentDirectory = resolvePendingDraftKey({
    kind: "directory",
    workspaceId: "workspace-a",
    directory: "/Users/demo/project/subdir",
  });
  const differentWorkspace = resolvePendingDraftKey({
    kind: "directory",
    workspaceId: "workspace-b",
    directory: "/Users/demo/project",
  });

  assert.equal(first, sameNormalized);
  assert.notEqual(first, differentDirectory);
  assert.notEqual(first, differentWorkspace);
  assert.equal(isPendingDraftKey(first), true);
});

test("restoring a pending draft preserves attachments", () => {
  const first = pendingDraftAttachmentPayloadToComposerAttachment({
    id: "attachment-image",
    name: "diagram.png",
    mimeType: "image/png",
    size: 4,
    kind: "image",
    bytes: [0, 1, 2, 3],
  });
  const restored = pendingDraftAttachmentPayloadsToComposerAttachments([
    {
      id: "attachment-image",
      name: "diagram.png",
      mimeType: "image/png",
      size: 4,
      kind: "image",
      bytes: [0, 1, 2, 3],
    },
    {
      id: "attachment-doc",
      name: "notes.txt",
      mimeType: "text/plain",
      size: 5,
      kind: "file",
      bytes: [104, 101, 108, 108, 111],
    },
  ]);

  assert.deepEqual(first, {
    id: "attachment-image",
    name: "diagram.png",
    mimeType: "image/png",
    size: 4,
    kind: "image",
    dataUrl: "data:image/png;base64,AAECAw==",
  });
  assert.deepEqual(restored, [
    {
      id: "attachment-image",
      name: "diagram.png",
      mimeType: "image/png",
      size: 4,
      kind: "image",
      dataUrl: "data:image/png;base64,AAECAw==",
    },
    {
      id: "attachment-doc",
      name: "notes.txt",
      mimeType: "text/plain",
      size: 5,
      kind: "file",
      dataUrl: "data:text/plain;base64,aGVsbG8=",
    },
  ]);
});
