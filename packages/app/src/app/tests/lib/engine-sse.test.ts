import assert from "node:assert/strict";
import test from "node:test";

import { createEngineSseSubscribeForTests } from "../../lib/engine-sse.js";

test("engine SSE forwards connection key to desktop subscribe command", async () => {
  let emitPayload = (_payload: any): void => {
    throw new Error("engine SSE listener was not registered");
  };
  const invocations: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const subscribe = createEngineSseSubscribeForTests({
    isTauriRuntime: () => true,
    listen: async (_event, nextHandler) => {
      emitPayload = (payload: any) => nextHandler({ payload });
      return () => {};
    },
    invoke: async (cmd, args) => {
      invocations.push({ cmd, args });
      if (cmd === "engine_sse_subscribe") {
        const options = (args as any)?.options ?? {};
        emitPayload({
          kind: "open",
          subscriptionId: options.subscriptionId,
          workspaceId: options.workspaceId,
        });
        return {
          subscriptionId: options.subscriptionId,
          replacedExisting: true,
          activeSubscriptionCount: 2,
          activeConnectionCount: 2,
        } as any;
      }
      return true as any;
    },
  });

  const subscription = await subscribe({
    workspaceId: "ws-a",
    baseUrl: "http://127.0.0.1:1234/workspace/ws-a/opencode",
    connectionKey: "session-workspace:ws-a",
  });

  assert.equal((invocations[0].args as any)?.options?.connectionKey, "session-workspace:ws-a");
  assert.equal(subscription.replacedExisting, true);
  assert.equal(subscription.activeSubscriptionCount, 2);
  assert.equal(subscription.activeConnectionCount, 2);
  await subscription.close();
  assert.equal(invocations[1].cmd, "engine_sse_unsubscribe");
  assert.equal((invocations[1].args as any)?.subscriptionId, subscription.subscriptionId);
});

test("engine SSE rejects a pending iterator read on post-open stream error close", async () => {
  let emitPayload = (_payload: any): void => {
    throw new Error("engine SSE listener was not registered");
  };
  const subscribe = createEngineSseSubscribeForTests({
    isTauriRuntime: () => true,
    listen: async (_event, nextHandler) => {
      emitPayload = (payload: any) => nextHandler({ payload });
      return () => {};
    },
    invoke: async (cmd, args) => {
      if (cmd === "engine_sse_subscribe") {
        const options = (args as any)?.options ?? {};
        emitPayload({
          kind: "open",
          subscriptionId: options.subscriptionId,
          workspaceId: options.workspaceId,
        });
        return { subscriptionId: options.subscriptionId } as any;
      }
      return undefined as any;
    },
  });

  const subscription = await subscribe({
    workspaceId: "ws-a",
    baseUrl: "http://127.0.0.1:1234/workspace/ws-a/opencode",
  });
  const iterator = subscription.stream[Symbol.asyncIterator]();
  const pending = iterator.next();

  emitPayload({
    kind: "error",
    subscriptionId: subscription.subscriptionId,
    workspaceId: "ws-a",
    message: "stream error: socket connection was closed unexpectedly",
  });
  emitPayload({
    kind: "closed",
    subscriptionId: subscription.subscriptionId,
    workspaceId: "ws-a",
    reason: "stream-error",
  });

  await assert.rejects(pending, /socket connection was closed unexpectedly/);
});
