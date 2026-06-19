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
      ...summary(),
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
  const first = summary({ id: "draft-a", workspaceId: "workspace-a", directory: "/repo/a" });
  const second = summary({ id: "draft-b", workspaceId: "workspace-a", directory: "/repo/b" });

  assert.equal(
    findStoredPendingDraftSummary({
      storedPendingDraftKey: resolvePendingDraftKey({
        kind: second.kind,
        workspaceId: second.workspaceId,
        directory: second.directory,
        privateWorkspaceId: second.privateWorkspaceId,
      }),
      pendingDrafts: [first, second],
    }),
    second,
  );
  assert.equal(
    findStoredPendingDraftSummary({
      storedPendingDraftKey: "pending:directory:workspace-a:/missing",
      pendingDrafts: [first, second],
    }),
    null,
  );
});

test("startup hydration clears stale stored keys and only hydrates after the draft payload loads", () => {
  const matchingPendingDraft = summary();
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
