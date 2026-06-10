import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../context/session.ts", import.meta.url), "utf8");

test("session store exposes assistant response observation callback", () => {
  assert.match(
    source,
    /onAssistantResponseObserved\?: \(sessionId: string\) => void;/,
    "createSessionStore should accept a callback for unread-session decisions",
  );
});

test("message updated events report only assistant responses after accepting the session", () => {
  assert.match(
    source,
    /if \(event\.type === "message\.updated"\) \{[\s\S]*const info = record\.info as Message;[\s\S]*if \(!isKnownSessionId\(info\.sessionID\)\) return;[\s\S]*setStore\("messages", info\.sessionID, \(current = \[\]\) => upsertMessageInfo\(current, info\)\);[\s\S]*if \(\(info as \{ role\?: string \}\)\.role === "assistant"\) \{[\s\S]*options\.onAssistantResponseObserved\?\.\(info\.sessionID\);[\s\S]*\}/,
    "assistant response observation should be scoped to accepted message.updated events",
  );
});

test("message part updates are not used as unread response triggers", () => {
  const callbackIndex = source.indexOf("onAssistantResponseObserved");
  const messageBranchIndex = source.indexOf('if (event.type === "message.updated")');
  const partBranchIndex = source.indexOf('if (event.type === "message.part.updated")', messageBranchIndex);
  const partRemovedBranchIndex = source.indexOf('if (event.type === "message.part.removed")', partBranchIndex);
  assert.ok(callbackIndex >= 0, "callback should exist");
  assert.ok(messageBranchIndex >= 0, "message.updated branch should exist");
  assert.ok(partBranchIndex >= 0, "message.part.updated branch should exist");
  assert.ok(partRemovedBranchIndex > partBranchIndex, "part removed branch should follow part updated branch");

  const partBranchSource = source.slice(partBranchIndex, partRemovedBranchIndex);
  assert.equal(
    partBranchSource.includes("onAssistantResponseObserved"),
    false,
    "part streaming should not repeatedly report unread assistant responses",
  );
});
