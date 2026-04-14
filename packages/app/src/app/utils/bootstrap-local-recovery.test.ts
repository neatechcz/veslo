import assert from "node:assert/strict";
import test from "node:test";

import { connectOrRecoverLocalBootstrap } from "./bootstrap-local-recovery.js";

test("falls back to startHost when reconnect returns false", async () => {
  const calls: string[] = [];

  const ok = await connectOrRecoverLocalBootstrap({
    connect: async () => {
      calls.push("connect");
      return false;
    },
    startHost: async () => {
      calls.push("startHost");
      return true;
    },
  });

  assert.equal(ok, true);
  assert.deepEqual(calls, ["connect", "startHost"]);
});

test("falls back to startHost when reconnect throws", async () => {
  const calls: string[] = [];
  const error = new Error("stale-runtime");

  const ok = await connectOrRecoverLocalBootstrap({
    connect: async () => {
      calls.push("connect");
      throw error;
    },
    startHost: async () => {
      calls.push("startHost");
      return true;
    },
  });

  assert.equal(ok, true);
  assert.deepEqual(calls, ["connect", "startHost"]);
});

test("does not startHost when reconnect succeeds", async () => {
  const calls: string[] = [];

  const ok = await connectOrRecoverLocalBootstrap({
    connect: async () => {
      calls.push("connect");
      return true;
    },
    startHost: async () => {
      calls.push("startHost");
      return true;
    },
  });

  assert.equal(ok, true);
  assert.deepEqual(calls, ["connect"]);
});
