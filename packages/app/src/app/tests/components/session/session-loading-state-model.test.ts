import assert from "node:assert/strict";
import test from "node:test";

import { shouldShowSessionLoadingState } from "../../../components/session/session-loading-state-model.js";

test("does not show loading in workspace setup empty state", () => {
  assert.equal(
    shouldShowSessionLoadingState({
      hasWorkspaceSetupEmptyState: true,
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
      selectedSessionId: "sess-1",
      messageCount: 0,
      loadingEarlierMessages: true,
    }),
    true,
  );
});

test("does not show loading for already populated selected session", () => {
  assert.equal(
    shouldShowSessionLoadingState({
      hasWorkspaceSetupEmptyState: false,
      selectedSessionId: "sess-1",
      messageCount: 5,
      loadingEarlierMessages: false,
    }),
    false,
  );
});

test("does not show a preloader before the target session becomes selected", () => {
  assert.equal(
    shouldShowSessionLoadingState({
      hasWorkspaceSetupEmptyState: false,
      selectedSessionId: null,
      messageCount: 12,
      loadingEarlierMessages: false,
    }),
    false,
  );
});
