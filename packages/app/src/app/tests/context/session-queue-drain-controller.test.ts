import assert from "node:assert/strict";
import test from "node:test";

import { createComputed, createRoot, createSignal } from "solid-js";

import { createSessionQueueDrainController } from "../../context/session-queue-drain-controller.js";

function solidRuntimeSupportsEffects(): boolean {
  let observed = 0;
  createRoot((dispose) => {
    const [value, setValue] = createSignal(0);
    createComputed(() => {
      observed = value();
    });
    setValue(1);
    dispose();
  });
  return observed === 1;
}

const behaviorTestOptions = solidRuntimeSupportsEffects()
  ? {}
  : {
      skip: "Solid's Node server condition does not run effects; use the test:reactivity script.",
    };

test("queue drain effects run only for their explicit reactive inputs and stop after disposal", behaviorTestOptions, async () => {
  await createRoot(async (dispose) => {
    const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>("session-a");
    const [sessionStatus, setSessionStatus] = createSignal("idle");
    const [sessionStatusById, setSessionStatusById] = createSignal<Record<string, string>>({
      "session-a": "idle",
    });
    const [pendingSessionQueueKey, setPendingSessionQueueKey] = createSignal("pending-a");

    const selectedCalls: Array<{ current: string | null | undefined; previous: string | null | undefined }> = [];
    const activeStatusCalls: Array<{ current: string; previous: string | undefined }> = [];
    const statusMapCalls: Array<{
      current: Record<string, string>;
      previous: Record<string, string> | undefined;
    }> = [];

    try {
      createSessionQueueDrainController({
        selectedSessionId,
        sessionStatus,
        sessionStatusById,
        pendingSessionQueueKey,
        pendingQueueKeyAwaitingSessionIdByBaseKey: () => ({}),
        sessionQueueKeyForSessionId: (sessionId) => sessionId ?? "",
        preserveRunStateOnSessionSwitch: () => {},
        setSearchQuery: () => {},
        closeSearch: () => {},
        markSelectedSessionForInitialAnchor: () => {},
        markTempRuntimeUiRenderSource: () => {},
        handleSelectedSessionChanged: ({ sessionId, previousSessionId }) => {
          selectedCalls.push({ current: sessionId, previous: previousSessionId });
          return {
            selectedSessionId: sessionId ?? null,
            materializedPendingSubmit: false,
            shouldMarkInitialAnchor: false,
          };
        },
        handleActiveSessionStatusChanged: (current, previous) => {
          activeStatusCalls.push({ current, previous });
        },
        handleSessionStatusMapChanged: (current, previous) => {
          statusMapCalls.push({ current, previous });
        },
      }).start();

      await Promise.resolve();

      assert.equal(selectedCalls.length, 1);
      assert.equal(activeStatusCalls.length, 1);
      assert.equal(statusMapCalls.length, 1);

      setPendingSessionQueueKey("pending-b");
      assert.equal(selectedCalls.length, 1, "callback reads must not become implicit dependencies");
      assert.equal(activeStatusCalls.length, 1);
      assert.equal(statusMapCalls.length, 1);

      setSessionStatusById({ "session-a": "busy" });
      assert.equal(selectedCalls.length, 1);
      assert.equal(activeStatusCalls.length, 1);
      assert.equal(statusMapCalls.length, 2);

      setSessionStatus("busy");
      assert.equal(selectedCalls.length, 1);
      assert.equal(activeStatusCalls.length, 2);
      assert.equal(statusMapCalls.length, 2);

      setSelectedSessionId("session-b");
      assert.equal(selectedCalls.length, 2);
      assert.equal(activeStatusCalls.length, 2);
      assert.equal(statusMapCalls.length, 2);

      setSelectedSessionId("session-b");
      assert.equal(selectedCalls.length, 2, "equal signal writes must not rerun the effect");
    } finally {
      dispose();
    }

    setSelectedSessionId("session-c");
    setSessionStatus("idle");
    setSessionStatusById({ "session-c": "idle" });

    assert.equal(selectedCalls.length, 2);
    assert.equal(activeStatusCalls.length, 2);
    assert.equal(statusMapCalls.length, 2);
  });
});
