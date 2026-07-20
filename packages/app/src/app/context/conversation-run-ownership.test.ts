import assert from "node:assert/strict";
import test from "node:test";

import { createConversationRunOwnershipIndex } from "./conversation-run-ownership";

const scope = (runId: string) => ({
  sessionId: "ses-a",
  workspaceId: "ws-a",
  conversationId: "conv-a",
  opencodeSessionId: "open-a",
  runId,
  clientMessageId: `msg-${runId}`,
});

test("queued reservation cannot replace the active alias owner before terminal release", () => {
  const ownership = createConversationRunOwnershipIndex();
  const a = scope("run-a");
  const b = scope("run-b");
  ownership.activate(a);
  ownership.reserve(b);
  ownership.observeStatus(b, { runId: "run-b", status: "running", stale: false });

  assert.equal(ownership.resolveActive("open-a", "ws-a")?.runId, "run-a");
  assert.equal(ownership.releaseTerminal(a).promoted, null);
  assert.equal(ownership.settleTerminalTranscript(a).promoted?.scope.runId, "run-b");
  assert.equal(ownership.resolveActive("open-a", "ws-a")?.runId, "run-b");
});

test("candidate alias events wait for terminal release before B owns the alias", () => {
  const ownership = createConversationRunOwnershipIndex();
  const a = scope("run-a");
  const b = scope("run-b");
  const commits: string[] = [];
  ownership.activate(a);
  ownership.reserve(b);
  ownership.observeStatus(b, { runId: "run-b", status: "running", stale: false });
  ownership.beginTerminal(a);

  assert.equal(ownership.holdTransitionMutation("open-a", "ws-a", () => commits.push("b-text")), true);
  assert.deepEqual(commits, []);
  ownership.releaseTerminal(a);
  const released = ownership.settleTerminalTranscript(a);
  assert.equal(released.promoted?.scope.runId, "run-b");
  for (const commit of released.promoted?.commits ?? []) commit();
  assert.deepEqual(commits, ["b-text"]);
});

test("does not hand B the alias until A crosses its terminal render boundary", () => {
  const ownership = createConversationRunOwnershipIndex();
  const a = scope("run-a");
  const b = scope("run-b");
  ownership.activate(a);
  ownership.reserve(b);
  ownership.beginTerminal(a);
  ownership.observeStatus(b, { runId: "run-b", status: "running", stale: false });

  assert.equal(ownership.promoteReadyRun(b), null);
  assert.equal(ownership.releaseTerminal(a).promoted, null);
  assert.equal(ownership.settleTerminalTranscript(a).promoted?.scope.runId, "run-b");
});

test("flushes delayed alias events and clears the latch when A has no queued successor", () => {
  const ownership = createConversationRunOwnershipIndex();
  const a = scope("run-a");
  const commits: string[] = [];
  ownership.activate(a);
  ownership.beginTerminal(a);
  assert.equal(ownership.holdTransitionMutation("open-a", "ws-a", () => commits.push("late-a")), true);

  ownership.releaseTerminal(a);
  const released = ownership.settleTerminalTranscript(a);
  for (const commit of released.commits) commit();
  assert.deepEqual(commits, ["late-a"]);
  assert.equal(ownership.holdTransitionMutation("open-a", "ws-a", () => commits.push("next-run")), false);
});

test("clears a waiting handover when the queued successor terminalizes without becoming active", () => {
  const ownership = createConversationRunOwnershipIndex();
  const a = scope("run-a");
  const b = scope("run-b");
  const commits: string[] = [];
  ownership.activate(a);
  ownership.reserve(b);
  ownership.beginTerminal(a);
  assert.equal(ownership.holdTransitionMutation("open-a", "ws-a", () => commits.push("candidate")), true);
  assert.equal(ownership.releaseTerminal(a).promoted, null);
  assert.equal(ownership.settleTerminalTranscript(a).promoted, null);
  ownership.observeStatus(b, { runId: "run-b", status: "aborted", stale: false });
  for (const commit of ownership.settleNonActiveTerminal(b)) commit();

  assert.deepEqual(commits, ["candidate"]);
  assert.equal(ownership.holdTransitionMutation("open-a", "ws-a", () => commits.push("next-run")), false);
});

test("an exact recovered scope remains active until app-local ownership is known", () => {
  const ownership = createConversationRunOwnershipIndex();
  assert.equal(ownership.isActiveOrUnknown(scope("run-reloaded")), true);
  ownership.activate(scope("run-a"));
  ownership.reserve(scope("run-b"));
  assert.equal(ownership.isActiveOrUnknown(scope("run-b")), false);
});

test("a known session alias can be provisionally armed before its submitted run id is returned", () => {
  const ownership = createConversationRunOwnershipIndex();
  const provisional = {
    sessionId: "ses-a",
    workspaceId: "ws-a",
    conversationId: "conv-a",
    opencodeSessionId: "open-a",
    clientMessageId: "msg-provisional",
  };

  assert.equal(ownership.armProvisional(provisional), true);
  assert.deepEqual(ownership.resolveProvisional("open-a", "ws-a"), provisional);
  assert.deepEqual(ownership.promoteProvisional({ ...provisional, runId: "run-a" }), provisional);
  assert.equal(ownership.resolveProvisional("open-a", "ws-a"), null);
});
