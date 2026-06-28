import assert from "node:assert/strict";
import test from "node:test";

import {
  findStoredPendingDraftSummary,
  resolvePendingDraftStartupHydration,
} from "../../controllers/pending-draft-startup-controller.js";
import { resolvePendingDraftKey } from "../../lib/pending-session-drafts.js";
import type {
  PendingSessionDraftGetResult,
  PendingSessionDraftSummary,
} from "../../lib/tauri.js";

const GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID = "pending-global-unpublished";

function summary(overrides: Partial<PendingSessionDraftSummary> = {}): PendingSessionDraftSummary {
  return {
    id: "draft-a",
    kind: "directory",
    workspaceId: "workspace-a",
    directory: "/repo/a",
    privateWorkspaceId: null,
    createdAt: 10,
    updatedAt: 20,
    composer: {
      mode: "prompt",
      parts: [{ type: "text", text: "hello" }],
      text: "hello",
      resolvedText: "hello",
      attachments: [],
      command: null,
    },
    ...overrides,
  };
}

function loaded(): PendingSessionDraftGetResult {
  return {
    draft: {
      ...summary({ id: GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID }),
      composer: {
        mode: "prompt",
        parts: [{ type: "text", text: "hello" }],
        attachments: [],
        text: "hello",
        resolvedText: "hello",
      },
    },
    attachmentFailures: [],
  };
}

test("finds the stored pending draft only after matching the durable storage key", () => {
  const oldPerWorkspaceDraft = summary({
    id: "pending-directory-old-workspace-a",
    workspaceId: "workspace-a",
    directory: "/repo/b",
  });
  const globalDraft = summary({
    id: GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID,
    workspaceId: "workspace-a",
    directory: "/repo/b",
  });

  assert.equal(
    findStoredPendingDraftSummary({
      storedPendingDraftKey: resolvePendingDraftKey({
        kind: globalDraft.kind,
        workspaceId: globalDraft.workspaceId,
        directory: globalDraft.directory,
        privateWorkspaceId: globalDraft.privateWorkspaceId,
      }),
      pendingDrafts: [oldPerWorkspaceDraft, globalDraft],
    }),
    globalDraft,
  );
  assert.equal(
    findStoredPendingDraftSummary({
      storedPendingDraftKey: "pending:directory:workspace-a:/missing",
      pendingDrafts: [oldPerWorkspaceDraft, globalDraft],
    }),
    null,
  );
});

test("startup hydration ignores old per-workspace pending drafts when no global record exists", () => {
  const oldPerWorkspaceDraft = summary({
    id: "pending-directory-old-workspace-a",
    workspaceId: "workspace-a",
    directory: "/repo/a",
  });

  assert.equal(
    findStoredPendingDraftSummary({
      storedPendingDraftKey: resolvePendingDraftKey({
        kind: oldPerWorkspaceDraft.kind,
        workspaceId: oldPerWorkspaceDraft.workspaceId,
        directory: oldPerWorkspaceDraft.directory,
        privateWorkspaceId: oldPerWorkspaceDraft.privateWorkspaceId,
      }),
      pendingDrafts: [oldPerWorkspaceDraft],
    }),
    null,
  );
});

test("startup hydration clears stale stored keys and only hydrates after the draft payload loads", () => {
  const matchingPendingDraft = summary({ id: GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID });
  const loadedPendingDraft = loaded();

  assert.deepEqual(
    resolvePendingDraftStartupHydration({
      storedPendingDraftKey: "",
      matchingPendingDraft,
      loadedPendingDraft,
      restoreError: null,
    }),
    { type: "skip", reason: "empty-key" },
  );
  assert.deepEqual(
    resolvePendingDraftStartupHydration({
      storedPendingDraftKey: "pending:directory:workspace-a:/repo/a",
      matchingPendingDraft: null,
      loadedPendingDraft,
      restoreError: null,
    }),
    { type: "clear", reason: "missing-summary" },
  );
  assert.deepEqual(
    resolvePendingDraftStartupHydration({
      storedPendingDraftKey: "pending:directory:workspace-a:/repo/a",
      matchingPendingDraft,
      loadedPendingDraft: null,
      restoreError: null,
    }),
    { type: "clear", reason: "missing-draft" },
  );
  assert.deepEqual(
    resolvePendingDraftStartupHydration({
      storedPendingDraftKey: " pending:directory:workspace-a:/repo/a ",
      matchingPendingDraft,
      loadedPendingDraft,
      restoreError: "One pending draft attachment could not be restored and was removed.",
    }),
    {
      type: "hydrate",
      storageKey: "pending:directory:workspace-a:/repo/a",
      summary: matchingPendingDraft,
      loadedDraft: loadedPendingDraft,
      restoreError: "One pending draft attachment could not be restored and was removed.",
    },
  );
});
