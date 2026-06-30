import type {
  PendingSessionDraftGetResult,
  PendingSessionDraftSummary,
} from "../lib/tauri";
import {
  isGlobalUnpublishedPendingDraftSummary,
  resolvePendingDraftKey,
} from "../lib/pending-session-drafts";

const trim = (value: string | null | undefined) => value?.trim() ?? "";

export function findStoredPendingDraftSummary(input: {
  storedPendingDraftKey?: string | null;
  pendingDrafts: PendingSessionDraftSummary[];
}): PendingSessionDraftSummary | null {
  const storedPendingDraftKey = trim(input.storedPendingDraftKey);
  if (!storedPendingDraftKey) return null;

  return input.pendingDrafts.find((draft) => {
    if (!isGlobalUnpublishedPendingDraftSummary(draft)) return false;
    return resolvePendingDraftKey({
      kind: draft.kind,
      workspaceId: draft.workspaceId,
      directory: draft.directory ?? null,
      privateWorkspaceId: draft.privateWorkspaceId ?? null,
    }) === storedPendingDraftKey;
  }) ?? null;
}

export type PendingDraftStartupHydrationDecision =
  | { type: "skip"; reason: "empty-key" }
  | { type: "clear"; reason: "missing-summary" | "missing-draft" }
  | {
    type: "hydrate";
    storageKey: string;
    summary: PendingSessionDraftSummary;
    loadedDraft: PendingSessionDraftGetResult;
    restoreError: string | null;
  };

export function resolvePendingDraftStartupHydration(input: {
  storedPendingDraftKey?: string | null;
  matchingPendingDraft: PendingSessionDraftSummary | null;
  loadedPendingDraft: PendingSessionDraftGetResult | null;
  restoreError: string | null;
}): PendingDraftStartupHydrationDecision {
  const storageKey = trim(input.storedPendingDraftKey);
  if (!storageKey) return { type: "skip", reason: "empty-key" };
  if (!input.matchingPendingDraft) return { type: "clear", reason: "missing-summary" };
  if (!isGlobalUnpublishedPendingDraftSummary(input.matchingPendingDraft)) {
    return { type: "clear", reason: "missing-summary" };
  }
  if (!input.loadedPendingDraft) return { type: "clear", reason: "missing-draft" };
  return {
    type: "hydrate",
    storageKey,
    summary: input.matchingPendingDraft,
    loadedDraft: input.loadedPendingDraft,
    restoreError: input.restoreError,
  };
}
