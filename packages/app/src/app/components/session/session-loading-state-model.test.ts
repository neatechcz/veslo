import assert from "node:assert/strict";
import test from "node:test";

import { shouldShowSessionLoadingState } from "./session-loading-state-model.js";

test("shows loading immediately when pending session load exists", () => {
  assert.equal(
    shouldShowSessionLoadingState({
      hasWorkspaceSetupEmptyState: false,
      hasPendingSessionLoad: true,
      selectedSessionId: null,
      messageCount: 12,
      loadingEarlierMessages: false,
    }),
    true,
  );
});

test("does not show loading in workspace setup empty state", () => {
  assert.equal(
    shouldShowSessionLoadingState({
      hasWorkspaceSetupEmptyState: true,
      hasPendingSessionLoad: true,
      selectedSessionId: "sess-1",
      messageCount: 0,
      loadingEarlierMessages: true,
    }),
    false,
  );
});

test("shows loading when selected session is empty and loading earlier messages", () => {
  assert.equal(
    shouldShowSessionLoadingState({
      hasWorkspaceSetupEmptyState: false,
      hasPendingSessionLoad: false,
      selectedSessionId: "sess-1",
      messageCount: 0,
      loadingEarlierMessages: true,
    }),
    true,
  );
});

test("does not show loading for already populated selected session without pending load", () => {
  assert.equal(
    shouldShowSessionLoadingState({
      hasWorkspaceSetupEmptyState: false,
      hasPendingSessionLoad: false,
      selectedSessionId: "sess-1",
      messageCount: 5,
      loadingEarlierMessages: false,
    }),
    false,
  );
});
