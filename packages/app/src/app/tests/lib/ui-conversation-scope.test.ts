import assert from "node:assert/strict";
import test from "node:test";

import {
  createUiConversationKey,
  isPendingUiConversationKey,
  parseUiConversationKey,
  sessionIdFromUiConversationKey,
} from "../../lib/ui-conversation-scope.js";

test("ui conversation keys include workspace identity", () => {
  const left = createUiConversationKey({
    workspaceId: "ws-a",
    kind: "session",
    id: "ses-1",
  });
  const right = createUiConversationKey({
    workspaceId: "ws-b",
    kind: "session",
    id: "ses-1",
  });

  assert.notEqual(left, right);
  assert.equal(sessionIdFromUiConversationKey(left), "ses-1");
  assert.deepEqual(parseUiConversationKey(left), {
    workspaceId: "ws-a",
    kind: "session",
    id: "ses-1",
  });
});

test("pending ui conversation keys do not resolve to raw session ids", () => {
  const key = createUiConversationKey({
    workspaceId: "ws-a",
    kind: "pending-draft",
    id: "__pending-draft__:new-private",
  });

  assert.equal(isPendingUiConversationKey(key), true);
  assert.equal(sessionIdFromUiConversationKey(key), null);
  assert.deepEqual(parseUiConversationKey(key), {
    workspaceId: "ws-a",
    kind: "pending-draft",
    id: "__pending-draft__:new-private",
  });
});
