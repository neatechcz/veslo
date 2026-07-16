import assert from "node:assert/strict";
import test from "node:test";

import type { ComposerDraft } from "../../../types.js";
import type { PendingSubmittedDraft } from "../../../components/session/pending-submit-model.js";
import {
  materializePendingSessionInstance,
  removePendingSubmittedDraftForKey,
  trySetPendingSubmittedDraftForKey,
} from "../../../components/session/pending-session-instance-model.js";

const draft = (id: string, sessionKey: string): PendingSubmittedDraft => ({
  id,
  clientMessageId: `client-${id}`,
  sessionKey,
  sessionId: null,
  createdAt: 1,
  draft: {} as ComposerDraft,
  state: "sending",
});

test("stores a pending draft only when its session-key slot is unoccupied", () => {
  const first = draft("submit-a", "pending-session:a");
  const stored = trySetPendingSubmittedDraftForKey({}, first.sessionKey, first);
  assert.equal(stored.kind, "stored");

  const occupied = trySetPendingSubmittedDraftForKey(
    stored.draftsBySessionKey,
    first.sessionKey,
    draft("submit-b", first.sessionKey),
  );
  assert.equal(occupied.kind, "occupied");
  assert.equal(occupied.draftsBySessionKey, stored.draftsBySessionKey);
});

test("removes only the matching pending draft and materializes it into the real session key", () => {
  const pending = draft("submit-a", "pending-session:a");
  const current = { [pending.sessionKey]: pending };

  assert.equal(removePendingSubmittedDraftForKey(current, pending.sessionKey, "other"), current);

  const materialized = materializePendingSessionInstance(current, {
    pendingSessionKey: pending.sessionKey,
    realSessionKey: "workspace-a\0session-a",
    realSessionId: "session-a",
  });
  assert.equal(materialized[pending.sessionKey], undefined);
  assert.equal(materialized["workspace-a\0session-a"]?.sessionId, "session-a");
});
