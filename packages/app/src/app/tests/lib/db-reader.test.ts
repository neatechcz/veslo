import assert from "node:assert/strict";
import test from "node:test";

import { dbSessionRowToSidebarItem, dbTranscriptToSnapshot } from "../../lib/db-reader.js";

test("dbSessionRowToSidebarItem preserves parent session ids for sidebar nesting", () => {
  const item = dbSessionRowToSidebarItem({
    id: "child-subagent",
    title: "child-subagent",
    directory: "/tmp/workspace",
    parentId: "root-parent",
    timeCreated: 100,
    timeUpdated: 200,
  });

  assert.equal(item.parentID, "root-parent");
});

test("dbTranscriptToSnapshot rebuilds message and part ids from DB rows", () => {
  const snapshot = dbTranscriptToSnapshot(
    "session-1",
    "workspace-1",
    {
      messages: [
        {
          id: "msg-1",
          sessionId: "session-1",
          data: JSON.stringify({
            role: "assistant",
            time: { created: 123 },
          }),
        },
      ],
      parts: [
        {
          id: "part-1",
          messageId: "msg-1",
          sessionId: "session-1",
          data: JSON.stringify({
            type: "text",
            text: "Ahoj",
          }),
        },
      ],
    },
    140,
  );

  assert.equal(snapshot.messages.length, 1);
  assert.equal(snapshot.messages[0]?.id, "msg-1");
  assert.equal((snapshot.messages[0] as { sessionID?: string })?.sessionID, "session-1");
  assert.equal(snapshot.partsByMessageId["msg-1"]?.length, 1);
  assert.deepEqual(snapshot.partsByMessageId["msg-1"]?.[0], {
    id: "part-1",
    messageID: "msg-1",
    sessionID: "session-1",
    type: "text",
    text: "Ahoj",
  });
});
