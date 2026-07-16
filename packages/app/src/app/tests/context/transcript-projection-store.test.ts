import assert from "node:assert/strict";
import test from "node:test";

import { createRoot } from "solid-js";

import { createTranscriptProjectionStore } from "../../context/transcript-projection-store.js";
import type { VesloSessionTranscriptSnapshot } from "../../lib/veslo-server.js";

const scope = {
  workspaceId: "ws-a",
  appWorkspaceId: "app-ws-a",
  serverWorkspaceId: "ws-a",
  directory: "/work/a",
  uiSessionId: "ui-a",
  conversationId: "conv-a",
  opencodeSessionId: "open-a",
  selectionVersion: 3,
  expectedRunId: null,
};

const snapshot = (
  overrides: Partial<VesloSessionTranscriptSnapshot> = {},
): VesloSessionTranscriptSnapshot => ({
  workspaceId: "ws-a",
  directory: "/work/a",
  sessionId: "open-a",
  conversationId: "conv-a",
  opencodeSessionId: "open-a",
  limit: 140,
  messages: [],
  partsByMessageId: {},
  latestRunArtifacts: {
    workspaceId: "ws-a",
    sessionId: "open-a",
    conversationId: "conv-a",
    opencodeSessionId: "open-a",
    runId: "run-a",
    items: [],
  },
  ...overrides,
});

test("publishes only the current selected projection with matching aliases", () => {
  createRoot((dispose) => {
    let selectedSessionId = "ui-a";
    let selectionVersion = 3;
    const store = createTranscriptProjectionStore({
      selectedSessionId: () => selectedSessionId,
      currentSelectionVersion: () => selectionVersion,
      isRunActive: () => false,
    });

    store.reserveTranscriptProjection(scope);
    assert.equal(store.publishTranscriptProjection(scope, snapshot()), true);
    assert.equal(store.currentTranscriptProjection()?.runId, "run-a");

    selectedSessionId = "ui-b";
    assert.equal(store.currentTranscriptProjection(), undefined);

    selectedSessionId = "ui-a";
    selectionVersion = 4;
    assert.equal(store.currentTranscriptProjection(), undefined);
    dispose();
  });
});

test("does not accept a stale alias or hide local artifacts during a new active run", () => {
  createRoot((dispose) => {
    let active = false;
    const store = createTranscriptProjectionStore({
      selectedSessionId: () => "ui-a",
      currentSelectionVersion: () => 3,
      isRunActive: () => active,
    });

    store.reserveTranscriptProjection(scope);
    assert.equal(
      store.publishTranscriptProjection(scope, snapshot({ opencodeSessionId: "open-other" })),
      false,
    );
    assert.equal(store.currentTranscriptProjection(), undefined);

    active = true;
    assert.equal(store.publishTranscriptProjection(scope, snapshot()), false);
    assert.equal(store.currentTranscriptProjection(), undefined);
    dispose();
  });
});

test("requires the expected durable run id for terminal recovery", () => {
  createRoot((dispose) => {
    const terminalScope = { ...scope, expectedRunId: "run-terminal" };
    const store = createTranscriptProjectionStore({
      selectedSessionId: () => "ui-a",
      currentSelectionVersion: () => 3,
      isRunActive: () => false,
    });
    store.reserveTranscriptProjection(terminalScope);

    assert.equal(store.publishTranscriptProjection(terminalScope, snapshot()), false);
    assert.equal(
      store.publishTranscriptProjection(
        terminalScope,
        snapshot({ latestRunArtifacts: { ...snapshot().latestRunArtifacts, runId: "run-terminal" } }),
      ),
      true,
    );
    const newerScope = { ...scope, expectedRunId: "run-newer" };
    store.invalidateTranscriptProjection(newerScope);
    assert.equal(store.currentTranscriptProjection(), undefined);
    assert.equal(store.publishTranscriptProjection(terminalScope, snapshot({
      latestRunArtifacts: { ...snapshot().latestRunArtifacts, runId: "run-terminal" },
    })), false);
    dispose();
  });
});

test("binds an initially unknown server workspace without letting later responses redefine it", () => {
  createRoot((dispose) => {
    const unknownServerScope = {
      ...scope,
      workspaceId: "app-ws-a",
      appWorkspaceId: "app-ws-a",
      serverWorkspaceId: null,
    };
    const store = createTranscriptProjectionStore({
      selectedSessionId: () => "ui-a",
      currentSelectionVersion: () => 3,
      isRunActive: () => false,
    });

    store.reserveTranscriptProjection(unknownServerScope);
    assert.equal(store.publishTranscriptProjection(unknownServerScope, snapshot()), true);
    assert.equal(store.reservation()?.workspaceId, "ws-a");
    assert.equal(store.reservation()?.serverWorkspaceId, "ws-a");

    assert.equal(
      store.publishTranscriptProjection(
        unknownServerScope,
        snapshot({
          workspaceId: "ws-other",
          latestRunArtifacts: {
            ...snapshot().latestRunArtifacts!,
            workspaceId: "ws-other",
          },
        }),
      ),
      false,
    );
    assert.equal(store.reservation()?.workspaceId, "ws-a");
    dispose();
  });
});

test("rejects artifacts whose nested identity disagrees with the transcript response", () => {
  createRoot((dispose) => {
    const store = createTranscriptProjectionStore({
      selectedSessionId: () => "ui-a",
      currentSelectionVersion: () => 3,
      isRunActive: () => false,
    });
    store.reserveTranscriptProjection(scope);

    const artifactIdentityMismatches = [
      { workspaceId: "ws-other" },
      { directory: "/work/other" },
      { conversationId: "conv-other" },
      { opencodeSessionId: "open-other" },
      { sessionId: "open-other" },
    ];
    for (const artifactIdentity of artifactIdentityMismatches) {
      assert.equal(
        store.publishTranscriptProjection(
          scope,
          snapshot({
            latestRunArtifacts: {
              ...snapshot().latestRunArtifacts!,
              ...artifactIdentity,
            },
          }),
        ),
        false,
      );
    }
    assert.equal(store.publishTranscriptProjection(scope, snapshot()), true);
    dispose();
  });
});
