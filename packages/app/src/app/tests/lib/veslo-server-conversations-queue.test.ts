import assert from "node:assert/strict";
import test from "node:test";

import { createConversationsClient } from "../../lib/veslo-server-domains/conversations.js";

test("conversation client builds scoped queue list and known-item paths", async () => {
  const paths: string[] = [];
  const client = createConversationsClient({
    baseUrl: "http://127.0.0.1:8787",
    token: "client-token",
    requestJson: async <T>(_baseUrl: string, path: string): Promise<T> => {
      paths.push(path);
      return { ok: true, items: [], nextCursor: null } as T;
    },
    timeouts: {
      deleteSession: 1,
      sessionArtifacts: 1,
      sessionTranscript: 1,
      conversationCreate: 1,
      conversationRun: 1,
      conversationAbort: 1,
      status: 1,
    },
  });

  await client.listQueue("ws id", "conv/id", {
    status: ["failed", "pending"],
    cursor: "cursor+/=",
    limit: 25,
  });
  await client.getQueueItem("ws id", "conv/id", "queue/id");

  assert.deepEqual(paths, [
    "/workspace/ws%20id/conversations/conv%2Fid/queue?status=failed&status=pending&cursor=cursor%2B%2F%3D&limit=25",
    "/workspace/ws%20id/conversations/conv%2Fid/queue/queue%2Fid",
  ]);
});
