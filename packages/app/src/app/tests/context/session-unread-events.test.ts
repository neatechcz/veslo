import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionSource = readFileSync(new URL("../../context/session.ts", import.meta.url), "utf8");
const eventStreamSource = readFileSync(new URL("../../context/session-event-stream.ts", import.meta.url), "utf8");

test("session store exposes assistant response observation callback", () => {
  assert.match(
    sessionSource,
    /onAssistantResponseObserved\?: \(sessionId: string\) => void;/,
    "createSessionStore should accept a callback for unread-session decisions",
  );
});

test("message updated events report only assistant responses after accepting the session", () => {
  assert.match(
    eventStreamSource,
    /if \(event\.type === "message\.updated"\) \{[\s\S]*const info = record\.info as Message;[\s\S]*if \(!bindKnownSessionToSource\(info\.sessionID, sourceWsId, record\)\) return;[\s\S]*upsertMessageInfo\(current, info as MessageInfo\)[\s\S]*deps\.setStore\("messages", info\.sessionID, next\);[\s\S]*if \(\(info as \{ role\?: string \}\)\.role === "assistant"\) \{[\s\S]*deps\.onAssistantResponseObserved\?\.\(info\.sessionID\);[\s\S]*\}/,
    "assistant response observation should be scoped to accepted message.updated events",
  );
});

test("accepted assistant stream events write metadata-only handoff trace entries", () => {
  assert.match(
    eventStreamSource,
    /recordSendWorkflowTrace\(\s*"session-sse",\s*"session-sse:assistant-message-updated",[\s\S]*sessionID: info\.sessionID,[\s\S]*messageID: info\.id,[\s\S]*role: "assistant"/,
    "assistant message.updated events should write a durable session-sse handoff trace",
  );
  assert.match(
    eventStreamSource,
    /recordSendWorkflowTrace\(\s*"session-sse",\s*"session-sse:assistant-part-updated",[\s\S]*sessionID: part\.sessionID,[\s\S]*messageID: part\.messageID,[\s\S]*partID: part\.id,[\s\S]*deltaLength:[\s\S]*textLength:[\s\S]*hasText:/,
    "assistant text part updates should write metadata-only part handoff trace",
  );
});

test("message part updates are not used as unread response triggers", () => {
  const callbackIndex = eventStreamSource.indexOf("onAssistantResponseObserved");
  const messageBranchIndex = eventStreamSource.indexOf('if (event.type === "message.updated")');
  const activePartAnchor = eventStreamSource.indexOf('if (event.type === "command.executed")', messageBranchIndex);
  const partBranchIndex = eventStreamSource.indexOf('if (event.type === "message.part.updated")', activePartAnchor);
  const partRemovedBranchIndex = eventStreamSource.indexOf('if (event.type === "message.part.removed")', partBranchIndex);
  assert.ok(callbackIndex >= 0, "callback should exist");
  assert.ok(messageBranchIndex >= 0, "message.updated branch should exist");
  assert.ok(activePartAnchor >= 0, "active command branch should precede active part branch");
  assert.ok(partBranchIndex >= 0, "message.part.updated branch should exist");
  assert.ok(partRemovedBranchIndex > partBranchIndex, "part removed branch should follow part updated branch");

  const partBranchSource = eventStreamSource.slice(partBranchIndex, partRemovedBranchIndex);
  assert.equal(
    partBranchSource.includes("onAssistantResponseObserved"),
    false,
    "part streaming should not repeatedly report unread assistant responses",
  );
});
