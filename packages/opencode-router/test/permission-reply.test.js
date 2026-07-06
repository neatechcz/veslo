import assert from "node:assert/strict";
import test from "node:test";

import { replyToPermissionRequest } from "../dist/bridge.js";

test("replyToPermissionRequest uses top-level permission.reply for legacy requests", async () => {
  const calls = [];
  const client = {
    permission: {
      reply: async ({ requestID, reply }) => {
        calls.push(`reply:${requestID}:${reply}`);
      },
    },
    v2: {
      session: {
        permission: {
          reply: async ({ sessionID, requestID, reply }) => {
            calls.push(`v2:${sessionID}:${requestID}:${reply}`);
          },
        },
      },
    },
  };

  await replyToPermissionRequest(client, {
    eventType: "permission.asked",
    sessionID: "sess-a",
    requestID: "perm-a",
    reply: "always",
  });

  assert.deepEqual(calls, ["reply:perm-a:always"]);
});

test("replyToPermissionRequest uses session-scoped v2 reply for v2 requests", async () => {
  const calls = [];
  const client = {
    permission: {
      reply: async ({ requestID, reply }) => {
        calls.push(`reply:${requestID}:${reply}`);
      },
    },
    v2: {
      session: {
        permission: {
          reply: async ({ sessionID, requestID, reply }) => {
            calls.push(`v2:${sessionID}:${requestID}:${reply}`);
          },
        },
      },
    },
  };

  await replyToPermissionRequest(client, {
    eventType: "permission.v2.asked",
    sessionID: "sess-v2",
    requestID: "perm-v2",
    reply: "reject",
  });

  assert.deepEqual(calls, ["v2:sess-v2:perm-v2:reject"]);
});

test("replyToPermissionRequest keeps deprecated respond only as a legacy fallback", async () => {
  const calls = [];
  const client = {
    permission: {
      reply: async ({ requestID, reply }) => {
        calls.push(`reply:${requestID}:${reply}`);
        throw new Error("PermissionNotFoundError: not found");
      },
      respond: async ({ sessionID, permissionID, response }) => {
        calls.push(`respond:${sessionID}:${permissionID}:${response}`);
      },
    },
  };

  await replyToPermissionRequest(client, {
    eventType: "permission.asked",
    sessionID: "sess-legacy",
    requestID: "perm-legacy",
    reply: "once",
  });

  assert.deepEqual(calls, ["reply:perm-legacy:once", "respond:sess-legacy:perm-legacy:once"]);
});
