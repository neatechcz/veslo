import assert from "node:assert/strict";
import test from "node:test";

import { createConversationRunOwnershipIndex } from "./conversation-run-ownership";
import { createTerminalDeliveryCoordinator } from "./terminal-delivery-coordinator";

const key = { workspaceId: "ws-a", conversationId: "conv-a", runId: "run-a" };

test("retains only the last visible mutation until the terminal render boundary", () => {
  const commits: string[] = [];
  const renderBoundaries: Array<() => void> = [];
  const coordinator = createTerminalDeliveryCoordinator({
    scheduleRenderBoundary: (callback) => { renderBoundaries.push(callback); },
  });

  coordinator.retainVisibleMutation(key, { kind: "assistant", commit: () => commits.push("first") });
  coordinator.retainVisibleMutation(key, { kind: "assistant", commit: () => commits.push("last") });
  assert.deepEqual(commits, ["first"]);

  coordinator.confirmTerminal(key);
  assert.deepEqual(commits, ["first"]);
  renderBoundaries.shift()?.();
  assert.deepEqual(commits, ["first", "last"]);
});

test("holds hydration and error display behind the same terminal boundary", () => {
  const commits: string[] = [];
  const renderBoundaries: Array<() => void> = [];
  const coordinator = createTerminalDeliveryCoordinator({
    scheduleRenderBoundary: (callback) => { renderBoundaries.push(callback); },
  });

  coordinator.retainVisibleMutation(key, { kind: "assistant", commit: () => commits.push("text") });
  coordinator.confirmTerminal(key);
  coordinator.retainTerminalDisplay(key, { kind: "hydration", commit: () => commits.push("hydration") });
  coordinator.retainTerminalDisplay(key, { kind: "error", commit: () => commits.push("error") });
  assert.deepEqual(commits, []);
  renderBoundaries.shift()?.();
  assert.deepEqual(commits, ["text", "hydration", "error"]);
});

test("commits terminal A text before a candidate B event can take the shared alias", () => {
  const commits: string[] = [];
  const renderBoundaries: Array<() => void> = [];
  const coordinator = createTerminalDeliveryCoordinator({
    scheduleRenderBoundary: (callback) => { renderBoundaries.push(callback); },
  });
  const ownership = createConversationRunOwnershipIndex();
  const a = { sessionId: "ses-a", workspaceId: "ws-a", conversationId: "conv-a", opencodeSessionId: "open-a", runId: "run-a", clientMessageId: "msg-a" };
  const b = { ...a, runId: "run-b", clientMessageId: "msg-b" };

  ownership.activate(a);
  ownership.reserve(b);
  ownership.observeStatus(b, { runId: "run-b", status: "running", stale: false });
  coordinator.retainVisibleMutation(key, { kind: "assistant", commit: () => commits.push("a-final") });
  ownership.beginTerminal(a);
  assert.equal(ownership.holdTransitionMutation("open-a", "ws-a", () => commits.push("b-first")), true);
  coordinator.confirmTerminal(key, () => {
    ownership.releaseTerminal(a);
    const released = ownership.settleTerminalTranscript(a);
    for (const commit of released.commits) commit();
    for (const commit of released.promoted?.commits ?? []) commit();
  });

  assert.deepEqual(commits, []);
  renderBoundaries.shift()?.();
  assert.deepEqual(commits, ["a-final", "b-first"]);
});

test("emits terminal confirmation before the ordered final-commit trace", () => {
  const traces: string[] = [];
  const renderBoundaries: Array<() => void> = [];
  const coordinator = createTerminalDeliveryCoordinator({
    scheduleRenderBoundary: (callback) => { renderBoundaries.push(callback); },
    trace: (event) => traces.push(event),
  });

  coordinator.retainVisibleMutation(key, { kind: "assistant", commit: () => {} });
  coordinator.confirmTerminal(key);
  renderBoundaries.shift()?.();

  assert.ok(traces.indexOf("terminal-delivery:terminal-confirmed") >= 0);
  assert.ok(
    traces.indexOf("terminal-delivery:terminal-confirmed") <
      traces.indexOf("terminal-delivery:visible-mutation-commit-after-terminal"),
  );
});

test("promotes a pre-submit tail to its exact run without an early or duplicate commit", () => {
  const commits: string[] = [];
  const renderBoundaries: Array<() => void> = [];
  const coordinator = createTerminalDeliveryCoordinator({
    scheduleRenderBoundary: (callback) => { renderBoundaries.push(callback); },
  });
  const provisional = { workspaceId: "ws-a", conversationId: "conv-a", clientMessageId: "msg-a" };

  coordinator.retainVisibleMutation(provisional, { kind: "assistant", commit: () => commits.push("first-text") });
  assert.equal(coordinator.promoteProvisional(provisional, key), true);
  assert.deepEqual(commits, []);

  coordinator.confirmTerminal(key);
  renderBoundaries.shift()?.();
  assert.deepEqual(commits, ["first-text"]);
});

test("releases a provisional tail instead of silently losing text when terminality is unavailable", () => {
  const commits: string[] = [];
  const coordinator = createTerminalDeliveryCoordinator();
  const provisional = { workspaceId: "ws-a", conversationId: "conv-a", clientMessageId: "msg-a" };

  coordinator.retainVisibleMutation(provisional, { kind: "assistant", commit: () => commits.push("text") });
  assert.equal(coordinator.releaseProvisionalWithoutTerminal(provisional), true);
  assert.deepEqual(commits, ["text"]);
});
