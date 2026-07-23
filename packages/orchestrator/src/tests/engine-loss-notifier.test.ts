import { expect, test } from "bun:test";

import { createEngineLossNotifier } from "../engine-loss-notifier.js";

test("engine loss notifier posts the generation-fenced event with bounded retry", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let attempt = 0;
  const notifier = createEngineLossNotifier({
    baseUrl: "http://127.0.0.1:8787/",
    token: "lifecycle-token",
    maxAttempts: 2,
    sleepImpl: async () => undefined,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      attempt += 1;
      return new Response(attempt === 1 ? "temporary" : JSON.stringify({ ok: true }), {
        status: attempt === 1 ? 503 : 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const result = await notifier({
    eventId: "event-1",
    workspaceId: "ws-1",
    engineSlotId: "slot-1",
    engineOwnerId: "generation-1",
    enginePid: 42,
    engineStartedAt: 123,
    engineBaseUrl: "http://127.0.0.1:4000",
    event: "exit",
    runIds: ["run-1", "run-1"],
    reason: "engine-pool exit",
  });

  expect(result).toEqual({ delivered: true, attempts: 2 });
  expect(calls).toHaveLength(2);
  expect(calls[0]?.url).toBe("http://127.0.0.1:8787/internal/orchestrator/engine-loss");
  expect((calls[0]?.init?.headers as Record<string, string>)["X-Veslo-Orchestrator-Token"]).toBe("lifecycle-token");
  expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
    schema: "veslo-engine-loss/v1",
    eventId: "event-1",
    workspaceId: "ws-1",
    engineOwnerId: "generation-1",
    runIds: ["run-1"],
  });
});

test("engine loss notifier does not send without callback authority", async () => {
  let calls = 0;
  const notifier = createEngineLossNotifier({
    baseUrl: "",
    token: "",
    fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status: 200 });
    },
  });

  const result = await notifier({
    eventId: "event-1",
    workspaceId: "ws-1",
    engineSlotId: "slot-1",
    engineOwnerId: "generation-1",
    enginePid: 42,
    engineStartedAt: 123,
    engineBaseUrl: "http://127.0.0.1:4000",
    event: "exit",
    runIds: ["run-1"],
    reason: "engine-pool exit",
  });

  expect(result).toEqual({ delivered: false, attempts: 0 });
  expect(calls).toBe(0);
});
